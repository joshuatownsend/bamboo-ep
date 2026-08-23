# Insights

<!-- insight:db779fbbe45b | session:0afa3046-6d2f-4f58-99ba-04b679faae6e | 2026-08-22T03:12:30.983Z -->
## ★ Insight
- Both hosts are in the HTTP allowlist deliberately. The probe falls back from `{sub}.bamboohr.com` to the legacy `api.bamboohr.com` gateway — if only the first were allowed, the fallback would work in the CLI (unscoped Node) and mysteriously fail inside the packaged app. Scope mismatches between dev and bundle are a classic Tauri v2 trap.
- `fs` permissions are write-only here (`write-file`, `mkdir`, `exists`). The app never needs to read the user's disk, so granting read access would widen the attack surface for no benefit — the user picks a folder via the dialog, and that's the only path we touch.

---

<!-- insight:839989b3e8c5 | session:0afa3046-6d2f-4f58-99ba-04b679faae6e | 2026-08-22T02:54:31.492Z -->
## ★ Insight
- That `escapeCsv` guard isn't cosmetic. A BambooHR notes field containing `=HYPERLINK(...)` becomes a live formula the moment someone opens the CSV in Excel — CSV injection. Prefixing with `'` neutralizes it. Any CSV built from remote data needs this, and almost no one remembers.

---

<!-- insight:0b4e5017506a | session:0afa3046-6d2f-4f58-99ba-04b679faae6e | 2026-08-22T02:51:39.611Z -->
## ★ Insight
- Notice `listTrainingRecords` and `listFiles` swallow **404 only** and re-throw everything else. That distinction matters: 404 is BambooHR's way of saying "nothing here / nothing visible to you," while 403 genuinely means the user's key lacks permission. Collapsing both into "empty" would produce a silently empty download folder with no explanation — the exact failure mode the probe screen exists to prevent.
- `extractCategories` accepts three response shapes on purpose. The reference project hit object-map-vs-array inconsistency on two separate endpoints; betting on one shape is how that codebase ended up with defensive normalization scattered across files instead of centralized.

---

<!-- insight:9592ab91e596 | session:0afa3046-6d2f-4f58-99ba-04b679faae6e | 2026-08-22T02:48:39.819Z -->
## ★ Insight
- The retry table is inverted from every other API you've used: **503 means "slow down" and 429 means "your company bought too few employee seats."** Retrying a 429 will never succeed, so `isThrottle` deliberately maps to 503 only. Getting this backwards would produce an app that hammers a hard failure and gives up on a soft one.
- `getJson` treats a JSON parse failure as "BambooHR served XML" rather than "malformed response." That's not a guess — BambooHR defaults to XML and only returns JSON when `Accept: application/json` survives, so a parse error is nearly always a lost header. Naming the real cause in the error saves an hour of debugging later.

---

<!-- insight:bafce5dca13e | session:0afa3046-6d2f-4f58-99ba-04b679faae6e | 2026-08-22T02:46:48.523Z -->
## ★ Insight
- `verbatimModuleSyntax` + `isolatedModules` force `import type` at every type-only import. That sounds pedantic, but it's what lets the same source compile cleanly under both `tsc` (for Node/CLI) and Vite's esbuild (for the Tauri frontend) without the bundler silently dropping a runtime import.
- `noUncheckedIndexedAccess` is deliberately on: BambooHR returns object-maps keyed by record ID, so almost every access into parsed API data is an index lookup that genuinely can be `undefined`. The compiler will force us to handle exactly the case that would otherwise crash at runtime.

---
