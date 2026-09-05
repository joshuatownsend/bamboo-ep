# Part 2 — Submitting certifications to Essential Personnel

Part 1 pulls an employee's training records and certificate files out of BambooHR and
writes them to a folder described by `manifest.json`. Part 2 gets those certifications
into Essential Personnel (EP), which LC-CFRS has made the system of record.

## What the General Order actually requires

System GO 2026-020 (issued 29 July 2026, `docs/System GO 2026-020 Essential Personnel.pdf`)
is the specification this half is written against. The parts that constrain the design:

- **Deadline 30 November 2026**, and *"failure to comply will result in operational
  suspension."* This is the only real schedule pressure in the project.
- **Upload all certifications, licenses, training records, and other professional
  credentials.**
- **"Members are responsible for ensuring all uploaded certifications are legible."**
  The AI verification built in Part 1 already reports `extracted.legible` per file. That
  stops being a nicety: it is how a member discharges a duty the GO places on them
  personally.
- **Certifications that auto-transfer from Vector Solutions and already appear in the
  profile do not need to be re-uploaded.** Note the scope: Vector/Target Solutions covers
  only a *limited subset* of a volunteer member's record. BambooHR remains the most
  complete programmatically reachable source. So the duplicate check is a safety net,
  not the main filter — most BambooHR records are expected to be missing from EP.
- **A certification not listed in EP is requested by emailing Captain Eiseman with the
  full certification name.** An official process for catalogue gaps, which the tool
  should prepare rather than perform.
- **Single Sign-On with Active Directory is the only authorized login method.** There is
  no member-level API credential to obtain. This settles the architecture (below).
- Where a certificate cannot be located, a **full official transcript** is acceptable;
  **partial transcripts and individual transcript pages are not.** The tool must never
  try to satisfy a missing certificate with a fragment.

Out of scope deliberately: the Key Profile Data, Emergency Contact, and LODD forms are
also required by 30 November, but they are personal-data entry rather than certificate
transfer. Those stay manual — automating next-of-kin details into an HR system is not a
thing this tool should do.

## What EP looks like from the outside

Established by reading publicly served files and by observing an authenticated session,
read-only, on `lccfrs.essper.com`.

**Tenant per subdomain**, same shape as BambooHR. Config is served openly at
`/config.js`, naming the internal API base and an `X-ES-KEY` app header.

**There is a first-class external API** — `https://{tenant}.essper.com/external/api/v0`,
authenticated with `x-api-key` / `x-api-secret` from an API client an administrator
creates in-app, with an OpenAPI spec at `/app/api-admin/docs`. **It is not usable for
this job**, for two independent reasons:

1. Its scopes are `users`, `employees`, `training_events`, `cad_upload`,
   `users:profile_pic`, `firstdue_analytics`, `assignment_requests`. Nothing for
   certifications, credentials, or document upload.
2. Clients are admin-issued and tenant-wide. Part 1 deliberately gives every employee
   their own key so the app only ever sees their own record; shipping an
   organization-wide credential to every member's desktop would throw that away.

**The internal app API is clean REST** and is what the browser drives:

| Call | Purpose |
|---|---|
| `GET /api/certifications/settings` | the certification catalogue behind the dropdown |
| `GET /api/user-certifications?userId=…&skip=0&limit=10&sortQuery[expires]=asc&archived=false` | what EP already holds for a member |
| `POST /api/user-certifications` (presumed, multipart) | create — **shape not yet confirmed** |

**The upload form** is Profile → Specialties & Certifications → Actions → Add New:

| Field | Type | Source |
|---|---|---|
| Employee | fixed to the signed-in member | — |
| Select a Specialty/Certification | **dropdown, fixed catalogue** | needs matching |
| Institution Name | free text | `entry.instructor`, or a constant |
| Date Completed | date | `entry.completed` |
| Expires (blank = never) | date | `entry.expires` |
| Upload Certificate | file, max 100 MB | the PDF Part 1 saved |

There are Active / **Pending** / Archived tabs, which suggests member submissions await
approval. Worth confirming — if true, a mistake is caught by a human before it counts.

## The central problem: a fixed vocabulary

The certification is chosen from a controlled catalogue, not typed. BambooHR has names
like `[SWP] HAZMAT Awareness & Operations`; EP has `247.B: IPAWS for Alert Originators`.
So Part 2's core is **matching a name against a fixed vocabulary** — structurally the
same problem Part 1 solved for file-to-record matching, and the same reason a review
screen with explicit confirmation is not optional. A wrong pick files a real credential
under the wrong name in the county's system of record.

### Four outcomes, not three

| Outcome | Behaviour |
|---|---|
| Matched, absent from EP | propose an upload |
| Matched, already in EP | skip as a duplicate, say so |
| Previously decided | honour the saved decision, do not ask again |
| **No catalogue match** | **the member triages it** |

The fourth is the one the GO alone would get wrong. LC-CFRS does not track everything a
volunteer department does — AVFRD's Volunteer Recruit School will almost certainly never
be an EP category. So "unmatched" is not automatically a gap to escalate, and the triage
offers three answers:

- **Request it** — collect into an email-ready list for Captain Eiseman, per the GO.
- **Not applicable to LC-CFRS** — remember it, never ask again.
- **Pick from the catalogue by hand** — the matcher missed it; record as a confirmed
  pairing for all future runs.

**The default is to do nothing.** Neither uploading nor requesting happens without an
explicit answer. Anything else has the tool making a judgement about county policy it has
no basis for, and an unwanted request arrives in a captain's inbox under the member's name.

### Saved decisions must key off something stable

Part 1 already hit this: a certifications row with no id got a positional key, and a
saved decision could migrate to a *different* record between runs. `hasStableIdentity()`
and `POSITIONAL_ID_PREFIX` exist because of it. The same guard applies here, and the
failure is worse — a wrongly skipped certification is invisible, where a wrong upload is
at least on screen.

## Architecture

**Browser automation against an authenticated session, not an HTTP client.** SSO with
Active Directory is the only authorized login, the login sits behind Cloudflare Turnstile
and Stytch, and there is no member API credential. The member signs in themselves; the
tool drives the page afterwards. This also keeps every action attributable to the member
performing it, which is the correct posture for writing to a system of record.

**Part 2 consumes a canonical record set, not "BambooHR's manifest."** This is the seam
that matters. A member's own machine very likely holds certificates that exist in no
system at all, and reading those is worth doing (Part 3, below). If Part 2 is written
against the manifest specifically, that becomes either a retrofit or a parallel copy of
the same matching, review, dedupe, and upload logic.

```
sources ─────────────────┐
  BambooHR (Part 1)      │
  a local folder (Part 3)├──> one reviewed certification set ──> Essential Personnel
  EP's existing records  │      (match · dedupe · triage)
    (as the dedupe side) │
```

## Stages

1. **Read.** `manifest.json` from Part 1, plus `GET /api/user-certifications` for what EP
   already holds.
2. **Match.** Each record against `GET /api/certifications/settings`, reusing Part 1's
   scoring approach.
3. **Review.** Confirm pairings, drop duplicates, surface files the AI flagged as
   illegible or contradicted, triage the unmatched.
4. **Upload.** Drive the Add New form per confirmed record in the member's session.
5. **Report.** Uploaded · skipped as duplicate · **catalogue request list** (the Eiseman
   email) · needs a transcript · marked not applicable.

Records with no certificate file are not uploads. Part 1 already reports them, and the
GO's answer is a full official transcript — a human errand, and the report should say so
rather than attempt anything.

## Open questions

- **The exact `POST /api/user-certifications` shape.** Only observable by submitting once
  and watching. Needs the member's consent — it writes to a real HR record.
- **Does a member submission land in Pending for approval?** Determines how recoverable a
  mistake is, and therefore how hard the review screen has to push back.
- **Does the catalogue endpoint paginate?** `/api/certifications/settings` was fetched in
  one call, but the dropdown is virtualised and the full size is unknown.
- **Institution Name** — what EP expects. BambooHR's instructor field is a person, which
  is wrong for a field labelled "institution", so nothing is sent for it: the submission
  leaves it empty rather than writing a name into the system of record while the question
  is open. Candidates are the issuing body read off the certificate (the AI extraction
  already has it), a constant naming the department, or asking the member.
- **How the member settles a calculated expiry** — see below. The outcome exists; the way
  they answer does not, and belongs with the screen that asks.

## Expiry dates this app calculated

Part 1 derives an expiry from a training type's renewal frequency when BambooHR states
none. Neither way of submitting one is safe on its own:

- Sending the date writes this app's arithmetic into the system of record as though an
  issuer had stated it.
- Sending nothing is **worse**: Essential Personnel reads a blank expiry as *never
  expires*, so a renewable credential would be recorded as permanently valid.

So those records are held at `expiryNotStated` and never submitted. The member settles
them — it is their certification and, under the General Order, their responsibility — but
the choice has to be made by a person rather than fallen into by a default.

The review screen asks it with two buttons - the calculated date, or "does not expire" -
and both open questions are now answered against a real interface:

- **Remembered between runs?** No. Nothing the member decides on this screen is written to
  disk. That makes the positional-key hazard moot: an answer about a record BambooHR gave
  no id to would be keyed by its position and name a different certification next time, and
  since the member answers while looking at the list and submits once, there is nothing to
  gain by saving it. If re-answering ever proves worth avoiding, only keys passing
  `isStableKey` may be saved.
- **Does "does not expire" override a dated expiry EP already holds?** No. It counts as the
  member's word for what is submitted, but for deciding whether a record supersedes one EP
  already has, an absence is not treated as the furthest-off date. Uploading over an
  existing record on the strength of a blank is the wrong way round; a real renewal is
  still caught by the completion date.

## Part 3 — the folder no system knows about

Members likely hold certificates on their own machines that appear in neither BambooHR
nor EP. Same pipeline, a second source adapter.

The one real difference: BambooHR supplies a *record* (name, dates) with the file as
evidence, whereas a loose PDF has no record at all — name, completion and expiry must be
read off the page. Part 1's extractor already returns exactly those fields, so it becomes
a *record producer* rather than a *record checker*. That inversion is why review is
mandatory for folder-sourced entries: every field is a model's reading rather than an HR
system's assertion, and it is landing in the county's system of record. The thumbnail
column built in Part 1 is what makes that review possible.

Three things already fall out of existing work:

- **SHA-256 is in the manifest**, so a loose file byte-identical to one BambooHR already
  supplied is caught with no AI at all.
- **The person check earns its keep.** A folder on an instructor's machine plausibly holds
  *other people's* certificates. `comparePersonName` was built for this, and the
  surname-plus-a-given-name rule is what stops a colleague's certificate being filed under
  the member's name.
- **Legibility** is most likely to fail on exactly these old scans, and the GO makes it
  the member's responsibility.

Recommended sequencing: build Part 2 with a source-agnostic record set, ship the BambooHR
adapter first since it is the most complete source and already produced, then add the
folder adapter against the same pipeline. Same application, not a second one — a member
should not run two programs to satisfy one General Order.
