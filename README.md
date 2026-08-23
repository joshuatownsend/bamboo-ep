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

The key is passed through the environment rather than as a flag, so it is not
visible in the process list to other users on the machine while the probe runs.

**It does still reach your shell history**, because the assignment itself is a
command you typed. To keep it out, read the key from a prompt instead:

```powershell
# PowerShell — the key is never typed as part of a command
$env:BAMBOO_API_KEY = (Read-Host "BambooHR API key" -AsSecureString |
  ConvertFrom-SecureString -AsPlainText)
```

```bash
# bash/zsh — -s hides the typing, and the leading space keeps the read itself
# out of history where HISTCONTROL=ignorespace is set
 read -rs -p "BambooHR API key: " BAMBOO_API_KEY && export BAMBOO_API_KEY
```

Clear it when you are done: `$env:BAMBOO_API_KEY = $null`, or `unset
BAMBOO_API_KEY`. The desktop app never has this problem — it stores the key in
the OS credential store and no shell is involved.

**PowerShell** (note: `VAR=value cmd` is bash-only and fails here):

```powershell
pnpm install

$env:BAMBOO_API_KEY = "your-key"
pnpm probe --subdomain your-company

# Optionally capture the result (credentials are stripped before writing):
pnpm probe --subdomain your-company --json probe-report.json

# $env: persists for the whole session; clear it when you are done:
Remove-Item Env:\BAMBOO_API_KEY
```

**Bash / zsh / Git Bash:**

```bash
pnpm install

BAMBOO_API_KEY=your-key pnpm probe --subdomain your-company

# Optionally capture the result (credentials are stripped before writing):
BAMBOO_API_KEY=your-key pnpm probe --subdomain your-company --json probe-report.json
```

If you omit the environment variable entirely, the probe prompts for the key
instead, which sidesteps the shell difference. Note that the prompt echoes what
you type, so prefer the environment variable if anyone can see your screen.

The probe writes nothing to BambooHR and downloads no files. Every check is reported
independently, so one refusal does not hide the rest.

### Findings

Probed against the **avfrd** company on 2026-08-21:

| Question | Answer |
|---|---|
| Endpoint form | **modern** — `https://avfrd.bamboohr.com/api/v1` answered; the legacy gateway fallback was not needed |
| `/training/type` readable | **yes** — 885 training types returned, so records get real certification names |
| Populated sources | Training records **166**, certifications table **1**, employee files **78** |

What this means for this account:

- **Naming works properly.** The feared 403 on `/training/type` did not occur, so the
  join from `record.type` to a real certification name succeeds and the placeholder
  fallback (`Training {typeId}`) should rarely appear.
- **Training records, not the certifications table, are the real source here** — 166
  records against a single certification row.
- **Most records will have no file.** 166 records and 78 files means at least 88
  records can have no certificate attached, which is exactly why record-only entries
  still reach the summary and the manifest.

Not yet established: whether the key used was admin or non-admin. BambooHR permissions
the API as the underlying user, so a non-admin key may still be refused on
`/training/type` — the degradation path remains untested against a real refusal even
though the code path is unit-tested.

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

These commands are identical in PowerShell and bash:

```bash
pnpm install
pnpm --filter @bamboo-ep/core build   # the app imports core's build output
pnpm --filter @bamboo-ep/desktop tauri dev
```

### Build prerequisites

- **All platforms:** the Rust toolchain.
- **Linux:** the `keyring` crate's Secret Service backend needs dbus development
  headers (`libdbus-1-dev` on Debian/Ubuntu) plus the usual Tauri WebKitGTK
  dependencies. Only Windows has been compiled so far — see *Not yet verified*.

The app walks through four steps — connect, check
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
pnpm test        # 154 unit tests in packages/core
pnpm typecheck
```

There are 9 further tests on the Rust side (`cd apps/desktop/src-tauri && cargo
test`), covering the filename guard and the AI client's destination rule.

Tests cover the parts with rules worth pinning down: Windows filename sanitisation
(reserved device names, trailing dots, case-insensitive collisions), template
rendering, BambooHR's object-map-vs-empty-array response inconsistency, month
arithmetic for derived expiry, the match scorer, retry behaviour, fuzzy person-name
matching, and the tolerance of whatever shape a model returns its answer in.

One retry rule is worth calling out because it is inverted from most APIs:

- **503 means throttling** — retry, honouring `Retry-After`.
- **429 means the account's employee-seat limit** — retrying can never help.

## Not yet verified

Everything below compiles and passes tests, but **no request has yet been made
against a real BambooHR account**. In rough order of what to do first:

1. ~~Run the probe with a real key.~~ **Done** — see Findings above. All three
   questions answered against the `avfrd` account.
2. **Click through `pnpm tauri dev`.** The keychain commands, the plugin-http
   host allowlist, and the dialog/filesystem plugins have compiled but never
   executed. The capability allowlist in particular can only fail at runtime —
   if the legacy-gateway fallback works in the probe CLI but not in the app,
   that scope is the first place to look.
3. **A full pull against a real account** — confirm downloaded files open, that
   filenames match the template, and that the record count matches what the
   BambooHR web UI shows.
4. **Packaging.** Only a Windows debug binary has been built. Signed installers
   for Windows and macOS, notarisation, and a Linux build are all untouched.
