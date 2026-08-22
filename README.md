# bamboo-ep

Pulls your BambooHR training records and certificate files to disk, named after the
certification, ready to submit to Essential Personnel.

Two parts:

1. **Retriever** (this repo, in progress) — a desktop app that downloads your own
   training records and certificate files from BambooHR into a folder.
2. **Uploader** (later) — sends that folder to Essential Personnel. It reads
   `manifest.json` from the folder; it does not re-derive anything from filenames.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | All BambooHR logic. Pure TypeScript, no Tauri, no DOM, fully unit-tested. |
| `apps/desktop` | Tauri v2 shell and React UI. |

`core` takes `fetch` as a dependency rather than importing it, so identical code runs
under Node (tests, the probe CLI) and inside Tauri. This matters because **BambooHR
sends no CORS headers** — a browser `fetch` can never reach it directly, which is why
the desktop app issues its HTTP from Rust via `@tauri-apps/plugin-http`.

## Getting an API key

Log in to BambooHR → click your name in the **lower-left corner** → **API Keys**.

If "API Keys" is not in that menu, your account is not permitted to create one; ask a
BambooHR administrator to enable API access for you. Keys are used as HTTP Basic
credentials with the key as the username and the literal `x` as the password.

## Run the capability probe

Three things about any given BambooHR account cannot be determined from the
documentation — only by asking. The probe asks them:

1. Does the company answer on `{subdomain}.bamboohr.com/api/v1` (current docs) or on
   the legacy `api.bamboohr.com/api/gateway.php/{subdomain}/v1` gateway?
2. Can a regular employee's key read `/training/type`? That endpoint is the **only**
   source of human-readable training names, and BambooHR's docs say it requires
   "access to training settings" — so a normal employee may get a 403, leaving records
   identified by nothing but a numeric type id.
3. Which sources does this company actually populate — Training records, the
   `employeeCertifications` table, Employee Files, or some combination?

```bash
pnpm install

# The key goes in the environment so it never lands in shell history.
BAMBOO_API_KEY=your-key pnpm probe --subdomain your-company

# Optionally capture the result (credentials are stripped before writing):
BAMBOO_API_KEY=your-key pnpm probe --subdomain your-company --json probe-report.json
```

The probe writes nothing to BambooHR and downloads no files. Every check is reported
independently, so one refusal does not hide the rest.

### Findings

> Record the answers here after running against a real account. The app degrades based
> on these, but knowing them up front makes the degradation paths easier to test.

| Question | Non-admin key | Admin key |
|---|---|---|
| Endpoint form | _unrecorded_ | _unrecorded_ |
| `/training/type` readable | _unrecorded_ | _unrecorded_ |
| Populated sources | _unrecorded_ | _unrecorded_ |

## How a certification gets its name

A BambooHR training record contains a numeric `type` and no name. So the name is
resolved by falling through, and every record remembers which link produced it — the UI
shows that, so a fallback name is never mistaken for the real title.

1. `employeeCertifications.title` — the best source; also carries a real expiry date.
2. `/training/type` → `name`, joined on the record's `type` id.
3. The matched file's own name.
4. `Training {typeId}` as a last resort.

Expiry works the same way: read from the certifications table when present, otherwise
derived as `completed + frequency` months when the training type is renewable, and
flagged `expiresDerived` so a computed date is never presented as authoritative.

## How files get matched to records

**BambooHR documents no relationship between an employee file and a training record.**
No shared id, no back-reference. So matching is a heuristic — scored on name overlap,
document category, and upload-date proximity — and it is treated as one: the app
proposes pairings and requires you to confirm them before writing anything. Confirmed
pairings are remembered, so corrections are made once.

## Run the desktop app

```bash
pnpm install
pnpm --filter @bamboo-ep/core build   # the app imports core's build output
pnpm --filter @bamboo-ep/desktop tauri dev
```

Requires the Rust toolchain. The app walks through four steps — connect, check
access, review matches, save — and writes nothing until you have reviewed the
proposed file-to-record pairings.

Output folder contents:

| File | Purpose |
|---|---|
| `<Certification>.pdf` etc. | One file per certificate, named from your template. |
| `Training Summary.pdf` | Printable list of every record, including those with no file. |
| `Training Summary.csv` | The same list as a spreadsheet. |
| `manifest.json` | Machine-readable record of everything. **Part 2 reads this.** |

Your API key is stored in the operating system's credential manager (Windows
Credential Manager, macOS Keychain, Linux Secret Service) — never in a config
file. Stronghold was considered and rejected: its vault password would mean
asking every employee to invent a second secret in order to store the first.

## Development

```bash
pnpm install
pnpm test        # 81 unit tests in packages/core
pnpm typecheck
```

Tests cover the parts with rules worth pinning down: Windows filename sanitisation
(reserved device names, trailing dots, case-insensitive collisions), template
rendering, BambooHR's object-map-vs-empty-array response inconsistency, month
arithmetic for derived expiry, the match scorer, and retry behaviour.

One retry rule is worth calling out because it is inverted from most APIs:

- **503 means throttling** — retry, honouring `Retry-After`.
- **429 means the account's employee-seat limit** — retrying can never help.
