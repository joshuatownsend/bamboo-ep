# Exploration: AI verification of certificate files

**Status:** built 2026-08-22. All six build-order steps are implemented and committed; see
"What was actually built" at the bottom for where each one landed and how it differs from
the sketch above.

## The idea

Let a user supply their own API key for a vision-capable model (Anthropic, or any
OpenAI-compatible endpoint) and have each downloaded certificate read back by the model
to extract:

- the **certification name** printed on the certificate,
- the **completion / issue date** and, when present, the expiration date,
- the **person's name**, to confirm the certificate belongs to this employee.

Those three are then compared against the BambooHR record the file was paired with, and
disagreements are surfaced before anything reaches Essential Personnel.

## Why this is worth taking seriously

This is not a speculative quality problem. In the first live run against a real account,
**six certificates were saved under the wrong certification name**:

| Saved as | Actually was |
|---|---|
| Technical Rescue Module 1 | Module 2 |
| Technical Rescue Module 2 | Module 1 |
| Fire Instructor 1 | Fire Instructor 2 |
| Fire Instructor 2 | Fire Instructor 1 |
| Fire Officer 2 | Fire Officer IV |
| Fire Officer 3 | Fire Officer 1 |

The tokenizer bug behind that is fixed and regression-tested, but the underlying exposure
is structural and permanent: **BambooHR records no link between a file and a training
record**, so every pairing this app makes is a guess scored by heuristics over filenames.
Four of the six mislabels scored 0.37–0.57 — "medium confidence". Nothing looked wrong.
One current pairing (`HIPAA Training ← TOWNSEND JOSHUA RUSSELL.pdf`, score 0.20) is still
weak and has no numeric conflict for the scorer to catch.

Reading the document itself is the only signal that is *independent* of the filename. That
is the real argument for this feature — not field extraction for its own sake, but a
second opinion on the match.

---

## 1. The central technical fork: these are PDFs, not images

The prompt described "sending the downloaded image". In practice the pulled artifacts are
PDFs (`jtownsend_Introduction-to-Technical-Rescue-Module-1_2016.pdf` and similar), with
some JPG/PNG scans mixed in. How a PDF reaches a model differs sharply by provider:

| Path | Anthropic | OpenAI | OpenRouter | Ollama / LM Studio (local) |
|---|---|---|---|---|
| Send PDF bytes directly | Yes — native document block | Varies by model/endpoint | Depends on upstream model | No |
| Send a rendered page image | Yes | Yes | Yes | Yes |

So there are two designs:

**A. Provider-native PDFs where supported, images elsewhere.** Best fidelity on Anthropic
(the model sees embedded text *and* layout), but two code paths and a capability matrix to
maintain per provider.

**B. Always rasterize page 1 locally, always send an image.** One uniform path, works
everywhere including local models. Costs a rasterizer dependency — `pdfium-render` on the
Rust side, or `pdf.js` already available in the webview — and loses embedded text, which
matters for text-native PDFs where OCR-from-pixels is strictly worse than reading the text
layer.

A middle road: extract the embedded text layer locally (cheap, no API call) and send *both*
the text and a page image. Many certificate PDFs are generated, not scanned, and their text
layer alone would resolve most cases — possibly without any model call at all for the ones
where the printed name matches the record exactly.

**Recommendation to consider:** B as the baseline, with local text extraction as a
pre-filter so the model is only consulted when text alone is inconclusive.

## 2. "OpenAI-compatible" collides with the Tauri capability pinning

`apps/desktop/src-tauri/capabilities/default.json` currently pins outbound HTTP to:

```json
{ "identifier": "http:default",
  "allow": [ {"url": "https://*.bamboohr.com/*"}, {"url": "https://api.bamboohr.com/*"} ] }
```

That pin is a real security property — the app cannot exfiltrate to an arbitrary host. But
the entire point of "OpenAI-compatible" is a user-supplied base URL: OpenRouter, Together,
Azure, `http://localhost:11434` for Ollama, `http://localhost:1234` for LM Studio. Those
cannot be statically enumerated.

Options:

1. **Widen the allow-list to a known provider set** plus `http://localhost:*` and
   `http://127.0.0.1:*`. Keeps the pin meaningful; users on an unlisted provider are stuck
   until the app ships an update. Least flexible, most defensible.
2. **Route AI calls through a dedicated Rust command**, the same move already made for
   `write_export_file` when `tauri-plugin-fs` scoping proved wrong. The command owns the
   HTTP client and can apply its own policy — e.g. require HTTPS unless the host is
   loopback, refuse redirects, cap request size. This is the most controllable option and
   keeps the webview from ever holding the AI key.
3. Widen `http:default` to `https://*/*`. Simple, and throws away the pin. Not recommended.

Option 2 is the most consistent with how this codebase has already resolved the same class
of problem, and it composes with §3 (key never crosses into JS).

## 3. Key storage — precedent already set

The BambooHR key lives in the OS credential store via the `keyring` crate, one entry per
subdomain under service `com.bambooep.desktop`. The AI key follows the same rule: a
credential-store entry (e.g. account `ai:<provider>`), **never** `settings.json`, never
`localStorage`. Non-secret AI settings — provider, model id, base URL, enabled/disabled —
belong in `Settings` alongside `filenameTemplate`.

If §2 option 2 is taken, the Rust command can read the key from the keyring itself and the
key never enters the webview at all, which is strictly better than the BambooHR key's
current handling.

## 4. Where it fits in the two-phase pull

`gatherWorkspace()` reads metadata and proposes matches; `executePull()` downloads bytes.
**File bytes only exist in phase 2** — but the verification result is most valuable in the
Review screen, which sits between the two.

**Placement (a): verify during `executePull`.** Bytes are already in hand; verification is
nearly free to bolt on. Results land in the manifest and in a post-pull report. Downside:
the user has already committed. A contradiction discovered here means going back and
re-running.

**Placement (b): a separate verification pass before Review.** Requires downloading
candidate files earlier — for `avfrd` that is 78 files, which the existing bounded worker
pool already handles. Verification results then feed the Review screen directly, and the
mislabel is caught *at the moment the user is deciding*. Downside: pays download and API
cost for files the user may exclude, and puts a slow step in front of the screen the user
wants to reach.

**Placement (c): targeted, on demand.** Verify only pairings the scorer already flags —
say anything below high confidence, plus any row the user clicks "check this" on. For the
real dataset that is a small subset, not 78 calls. Cheapest and it aims the model exactly
at the cases the heuristic is worst at.

**Recommendation to consider:** (c) as the default with (b) as an opt-in "verify
everything" button. (c) targets the actual failure mode — medium-confidence pairings —
without making every pull slower and more expensive.

## 5. What the model is actually asked to do

Two distinct jobs, worth keeping separate:

**Extraction** — read the document, return structured fields. Use enforced structured
output (JSON schema on OpenAI-compatible endpoints, tool-forcing on Anthropic) so the
result is machine-comparable rather than prose to be parsed. Roughly:

```
certificationName   string | null
issuedDate          YYYY-MM-DD | null
expirationDate      YYYY-MM-DD | null
personName          string | null
documentType        "certificate" | "card" | "transcript" | "other" | "unreadable"
legible             boolean
```

**Comparison** — done in local code, not by the model. Compare the extracted name against
the record name using the tokenizer already in `matching.ts` (which now normalizes roman
numerals and preserves level digits — exactly what the Module 1/2 case needed); compare
dates with a tolerance window; compare the person name fuzzily.

Keeping comparison local matters: it is deterministic, testable, free, and it means the
existing `scorePair` reasoning and the AI signal speak the same vocabulary. The model
should never be asked "is this the right match?" — it should be asked "what does this
document say?", and the code decides.

The most useful output is a third confidence signal on the Review row:

- **Confirms** — extracted name agrees with the assigned record.
- **Contradicts** — extracted name matches a *different* record in the workspace. This is
  the money case: it names the correct pairing, not just the problem.
- **Inconclusive** — unreadable, or name matches nothing.
- **Wrong person** — printed name is not this employee. Serious enough to block by default.

### Prerequisite: the employee's name is not currently fetched

`getSelf()` reads only `id` from `GET /employees/0` (`packages/core/src/bamboo.ts:38`), and
`Connection` stores only `employeeId`. The "correct person" check needs the employee's
actual name, which means requesting `fields=firstName,lastName,displayName,preferredName`
and carrying it on `Connection`.

Then fuzzy matching is genuinely required — real data has
`TOWNSEND JOSHUA RUSSELL` where BambooHR would say `Joshua Townsend`. Surname-plus-given
token intersection, case- and order-insensitive, ignoring middle names and suffixes. And
the failure mode must be tuned carefully: a false "wrong person" on a legitimate
certificate is worse than a miss, because it trains the user to ignore the warning.

## 6. Manifest implications

The manifest is the Part 1 → Part 2 contract, so a verdict Part 2 should act on has to
live there. Sketch, per entry:

```
verification: {
  provider, model, verifiedAt,
  extracted: { certificationName, issuedDate, expirationDate, personName, legible },
  verdicts: {
    name:   "confirms" | "contradicts" | "inconclusive",
    date:   "confirms" | "contradicts" | "inconclusive",
    person: "confirms" | "contradicts" | "inconclusive"
  },
  suggestedItemKey: string | null   // set when it contradicts and matches another record
} | null
```

That bumps `MANIFEST_VERSION` to 2. `parseManifest()` already rejects a manifest newer than
the app understands, and `verification: null` is a valid absent state, so a v1 folder stays
readable and a v2 folder read by an old build fails loudly rather than silently.

Verification must be **advisory**, wrapped in the existing `softly()` pattern: a dead API
key, a rate limit, or an unreachable local model degrades to a warning in
`workspace.warnings`. It must never be able to prevent a pull from completing.

---

## Benefits

- **Catches the exact failure class that already occurred.** An independent read of the
  document is the only signal not derived from the filename the heuristic already used.
- **Contradictions are actionable.** When the extracted name matches a *different* record,
  the app can propose the swap rather than just flagging doubt.
- **Wrong-person detection has no other source.** Nothing in BambooHR's metadata reveals
  that a file on a profile shows someone else's name.
- **Fills in missing dates.** 106 records currently have no file, and some records have no
  `completed` date; the certificate itself often carries one.
- **Improves the low-quality-name cases.** Records whose `nameSource` is `file-name` or
  `placeholder` are exactly where the printed certificate title is most valuable.
- **User-supplied key means no cost or liability for the app.** Follows the same
  bring-your-own-credential model already established for BambooHR.
- **Local-model support makes it usable where cloud AI is not permitted.**

## Drawbacks

- **PII leaves the machine.** Certificates carry full legal names, certification numbers,
  sometimes DOB or license numbers, for a volunteer fire and rescue organization. Sending
  them to a third-party model is a materially different act from downloading them. This
  needs explicit, informed, per-run opt-in — not a checkbox buried in settings — plus
  plain statements of each provider's retention behavior, and a clear note that the
  local-model path keeps everything on the machine.
- **Organizational policy may simply forbid it.** Worth confirming with AVFRD before
  building, because it could make the cloud path unusable regardless of quality.
- **A new class of wrong answer.** The model can hallucinate a plausible certification
  name. A confident-but-wrong AI verdict that *overrides* a correct heuristic match is a
  regression, not an improvement — which is why the verdict must be advisory and shown
  alongside the heuristic reasoning, never silently applied.
- **Scanned and photographed certificates are hard.** Skewed phone photos, low-contrast
  scans, wallet cards. "Inconclusive" will be common and the UI has to make that a neutral
  outcome rather than an alarm.
- **Cost and latency.** Roughly: one image (~1–2k tokens depending on resolution) plus a
  short prompt and a structured response, per verified file. At 78 files that is a small
  batch — cents, not dollars, at current rates — but it is the user's own key and the app
  should show an estimate before running, and honor per-run limits. Local models cost
  nothing but are slower and noticeably weaker at reading poor scans.
- **Real maintenance surface.** Provider matrix, model deprecations, PDF rasterization,
  structured-output dialect differences, retries and rate limits. This is the single
  largest addition to the codebase since the initial build.
- **Two credential stores to explain.** Onboarding already has to teach BambooHR API key
  creation; adding a second key doubles the setup a volunteer has to complete.

---

## The cheap competitor: render a thumbnail in the Review screen

Worth weighing honestly, because it addresses much of the same problem at near-zero cost.

Render page 1 of each candidate PDF as a small preview next to each Review row. The user
sees the actual certificate while choosing. **This would have caught all six mislabels** —
the module numbers are printed on the documents in large type.

| | Thumbnails | AI verification |
|---|---|---|
| Cost | none | per-file API cost |
| PII egress | none | to the chosen provider |
| New dependency | PDF renderer | PDF renderer + AI client + key storage + provider matrix |
| Catches module swaps | yes, if the user looks | yes, automatically |
| Catches wrong person | only if the user reads it | yes, automatically |
| Scales without attention | no — needs a human per row | yes |
| Fills in missing dates | no | yes |
| Can be wrong | no | yes |

They are complementary rather than competing, and the ordering is clear: **thumbnails are
the higher-value, lower-risk change and should probably land first.** They make the Review
screen trustworthy on their own and reuse the same rasterizer the AI path would need
anyway. The AI agent's distinct value is what a human eye does not scale to — unattended
checking, the wrong-person check, and date extraction — which is a real but narrower case.

---

## Decisions

Recorded 2026-08-22.

### 1. Cloud AI providers are allowed, configured once — not gated per run

Anthropic and OpenAI-compatible endpoints are both in scope, alongside local models. The
user sets up a provider and key in settings; there is no per-run confirmation prompt.

The provider is still named in the UI wherever verification results appear, and in the
manifest's `verification.provider` field, so the folder records where the documents were
sent. That is a record-keeping requirement of the Part 2 contract, not a consent gate.

### 2. Thumbnails ship first

Render page 1 of each candidate file in the Review screen before any AI work begins. This
is the change that would have caught all six mislabels, it costs nothing, sends nothing
off-machine, and it builds the PDF rasterizer the AI path needs anyway. AI verification is
a follow-up on top of it.

### 3. Verification targets flagged pairings only

Verify pairings the scorer did not rate high confidence, plus any row the user explicitly
asks to check. Not every file on every pull.

Consequence worth stating: a **wrong-person** certificate that the scorer paired with high
confidence will not be checked. Filename and record name agreeing says nothing about whose
name is printed on the document. If that gap matters, the answer is the "verify everything"
sweep as an explicit user action — the default stays targeted.

### 4. A wrong-person verdict warns, it does not block

Show it prominently on the Review row and record it in the manifest, but never prevent the
user from proceeding. A false positive on a legitimately-named certificate then costs
nothing, which is what keeps the warning credible rather than trained-away.

---

## Build order

1. **PDF rasterization + Review thumbnails.** Page-1 preview per candidate file. Shared
   dependency for everything after.
2. **Fetch the employee's name.** `fields=firstName,lastName,displayName,preferredName` on
   the self lookup; carry it on `Connection`. Prerequisite for the person check.
3. **Manifest v2.** Add the optional `verification` block; bump `MANIFEST_VERSION`.
4. **AI client.** Rust-side command owning the HTTP call and reading the key from the
   keyring, so the key never enters the webview. Provider + model + base URL in `Settings`.
5. **Extraction + local comparison.** Structured output from the model; comparison in
   `core` reusing the `matching.ts` tokenizer.
6. **Review screen integration.** Third confidence signal per row: confirms / contradicts
   (naming the better record) / inconclusive / wrong person.


---

## What was actually built

All six steps shipped on `part-1-desktop-app`. Where the implementation departs from the
sketch above, the reason is recorded here rather than left as a silent difference.

| Step | Landed in | Note |
|---|---|---|
| 1. Rasteriser + thumbnails | `apps/desktop/src/preview.ts`, `usePreviews.ts`, `components/CertificatePreview.tsx` | pdf.js in the webview, not pdfium in Rust |
| 2. Employee name | `packages/core/src/bamboo.ts` (`getSelf`), `identity.ts` | Same request, `fields=` param, with a bare-call fallback |
| 3. Manifest v2 | `packages/core/src/manifest.ts`, `pull.ts` | Plus `summary.verified` / `summary.contradicted` |
| 4. AI client | `apps/desktop/src-tauri/src/ai.rs` | `reqwest`, not `tauri-plugin-http` |
| 5. Extraction + comparison | `packages/core/src/verify.ts`, `apps/desktop/src/useVerification.ts` | Prompt and schema live in `core` beside the parser |
| 6. Review integration | `apps/desktop/src/screens/ReviewScreen.tsx`, `components/VerificationSignal.tsx` | Third signal per row, plus a bulk flagged-only sweep |

### Decisions taken during the build

**pdf.js in the webview rather than `pdfium-render` in Rust.** The bytes have to reach the
webview to be displayed at all, and one canvas render produces both the thumbnail and the
image sent to the model. A Rust rasteriser would have meant rendering twice or shuttling
images back across the bridge, for no benefit. Cost: a 1.2 MB worker asset in the bundle,
and three CSP directives (`script-src 'wasm-unsafe-eval'`, `worker-src blob:`,
`img-src blob:`).

**The AI key is never returned to the webview.** The BambooHR key still is — `load_api_key`
predates this and the probe needs it in `core` — but there was no reason to repeat that for
the provider key. The web layer gets `save_ai_key`, `has_ai_key`, `delete_ai_key`, and the
request itself is built in Rust, so the secret goes from the keychain to the wire without
ever being a JavaScript string.

**Only https, or loopback.** A user-supplied base URL is where scans of someone's identity
documents get sent. Plain HTTP to a real host is refused outright; loopback is exempt
because it never reaches a network, and is how Ollama and LM Studio are addressed — the
configuration that sends nothing anywhere.

**`json_object`, not `json_schema`, on OpenAI-compatible endpoints.** Most servers that call
themselves compatible reject the stricter form. The schema is in the prompt regardless, and
`parseExtraction` in `core` is what actually enforces the shape — so strictness at the API
buys nothing and would lock out exactly the local models the privacy story depends on.

**The verification carries its file id.** A verdict is about a PAIR, not a record. Verifying
a row and then repointing it must lose the verdict; `executePull` re-checks the id before
writing, and the Review screen forgets the check as soon as the row moves. Without this, the
manifest could ship a confident claim about a document nobody looked at.

**A contradiction becomes a manifest warning.** Decision 4 said warn, not block, so the
certificate is still downloaded, still written, and still reaches the manifest — the warning
text names the record the document appears to belong to instead, which is only possible
because the comparison stayed in local code sharing the matcher's tokeniser.

### Not done

- The person check has never been run against a live BambooHR tenant, so whether
  `preferredName` exists on this account is still unverified. The fallback path is tested;
  the happy path is not.
- No end-to-end run against a real provider key. Every layer is unit-tested — including the
  Anthropic and OpenAI envelope unwrapping in Rust — but the two have not been connected.
- The CSV and PDF summaries carry no verification column. Contradictions reach the exported
  folder through `manifest.warnings`, which the result screen shows, and through
  `manifest.entries[].verification`. Adding a column was deliberately left out of scope.
