# DESIGN-NORTHSTAR — the "pipe with an inbox" decision record

Status: **owner-ruled record of decisions already made** (post-v0.3.2
product batch). This is not a proposal and not a redesign: nothing here
is open for re-litigation inside a story. New design may be invented
only where this record is silent, and only inside a story's own charter.

Relationship to the other authorities:

- [`../DESIGN.md`](../DESIGN.md) remains the engineering authority for the
  engine/API surface that already ships (§5 module contract, §7 downloads, …).
- [`UX-PARITY.md`](UX-PARITY.md) holds the permanent product rulings R1–R5
  and the FMD2 disposition matrix. This record *derives from* those rulings
  and the batch decisions; where they overlap, the ruling text wins.
- Every story in this epic ("Pipe with an Inbox") is chartered by a
  section of this document, and §8 binds them all.

---

## 1. Identity

fmd-web is **Sonarr-for-manga**: a headless acquisition pipeline that
runs whether or not anyone is looking. The product shape is a **pipe
with an inbox** — chapters flow in on a schedule, land in the library,
and surface an inbox of what arrived. The web UI exists for
**exceptions and oversight only**: it is where you add things, where
you look when something failed, and where you confirm the pipe is
healthy. The happy path is hands-off (scheduler → download → library →
webhook); no screen needs to be open for it to work.

Consequences: arrival is a *feed*, not a notification you must catch;
failure is a *queue you clear*, not an alert storm; and nothing in the
UI is the only path to a feature the scheduler already does
(the R4 API rule restated for this batch).

## 2. The five stages

Work flows through five stages. Each has one job; none acquires a
second.

### ENTER — how manga get in

Three doors, no fourth: **paste-URL** (the universal front door — any
series URL resolves to its module), **search-with-scope** (catalog-index
search over a preferred scope, not the all-sites firehose), and
**site browse** (pick a site, browse it). Scoping rides the
**preferred-sites global allowlist**: one canonical, user-ordered list
of sites you actually use; search and add flows prefer it. **One-decision
add**: adding a site to the preferred list (or a manga to favorites) is
a single decision made once — never re-asked per manga, never a wizard.

### PIPE — how chapters move

The **existing scheduler** (favorites check loop) is the pump; this
batch adds no second scheduler. New-chapter detection is
**link-keyed diff** (the chapter list is a set of links; new links =
new chapters — never title/number comparison). **Per-host pacing**
spreads checks and downloads per origin (no synchronized fan-outs).
Outbound notification is **one single webhook** (§3 pipeline). The pipe
never blocks the UI and never blocks on module I/O (§3).

### INBOX — what arrived

A reverse-chronological feed of chapters the pipe delivered, with
**per-chapter seen state** (each chapter row marks read individually)
and a **shared caught-up** action ("I've seen everything up to here")
that is *server-side state* — caught-up once, caught-up everywhere;
marking read on one device must not replay on another. Inbox entries
**archive after 30 days** (they are a feed, not a ledger — the
downloaded-truth ledger is separate and permanent).

### TRIAGE — what failed

One attention surface. Failures arrive **grouped by cause**
(network/anti-bot, module breakage, engine faults — not per-chapter
noise), with a **paced retry-all** (per-host pacing applies to retries
exactly as to fresh work — retry-all is never an instant fan-out).
Site **availability is a hint, never a gate**: an unreachable record
dims a row and explains itself, but never blocks an attempt the user
explicitly made (the [site-availability] posture, kept).

### EXIT — where files land

The library is a **scan target for dedicated readers** (Komga/Kavita),
which do all parsing and reading (R1). The contract:

- **Flat `<manga>/` layout** — one folder per series, no module/site
  subdirectory; on a duplicate title from a second site, the later
  series writes `<manga> [<module>]`; the first writer keeps the clean
  name.
- **`<numbering> <chapter>` filenames** (§7).
- **ComicInfo metadata-only**: ComicInfo.xml is *written into* each
  archive as metadata for the scanner; fmd-web never reads, parses,
  edits, or displays ComicInfo.
- **Komga/Kavita scan-target guarantees**: `folder name = ComicInfo
  Series`, files appear atomically at the final path, `.cbz` is the
  convention, no dotfiles or staging residue in the tree — a scanner
  can sweep the library root at any moment and see a consistent,
  series-grouped, correctly-named library.

## 3. Invariants

These bind every story in the batch. A story that needs one broken
stops and escalates; it does not bend it quietly.

### Identity

- A **favorite = (module, canonical URL)**. Not title, not id, not a
  generated key — the pair is the identity.
- A **chapter = its link** (within a module's listing). Detection,
  seen state, and the ledger key on links; never on parsed numbers or
  names.
- The **preferred-sites list order is canonical** — it fixes scope
  ordering, presentation order, and duplicate-title resolution order.
- The **series folder is computed once and persisted** at first
  finalize; nothing later (title change, module label change, folder
  collision discovered afterward) recomputes or moves it.

### Safety

- **No file bytes served** beyond the existing packed-artifact
  download route (the one R1-sanctioned boundary); everything else on
  the library surface is metadata.
- **realpath clamp** on every path that reaches the disk from stored
  state — a path resolving outside the library root never serves,
  walks, or lists.
- **Module-validated outbound**: every outbound HTTP hop is validated
  against the addressed module's permitted hosts (the cover-proxy
  posture); fmd-web is never an open proxy or a generic fetcher.
- **GET never mutates** — no state change rides a GET; the *arr gate
  ordering stays.
- **Idempotent import and detection**: running the FMD2 import twice,
  or the scheduler detecting chapters twice, produces the same state —
  no duplicates, no re-downloads.
- **Nothing auto-deletes or auto-renames user files.** The app's file
  operations are create-at-final-path; the operator owns the tree
  after that.
- **Hints never block** — availability, staleness, and advisories dim
  and explain; they never gate an explicit user action.

### Pipeline

- The **main loop never blocks on module I/O** — all module HTTP lives
  off the main event loop (the engine-worker topology is the shipped
  enforcement; do not regress it).
- **Label changes never re-download**: when a site renames a manga or
  chapter titles shift, identity (links) is unchanged, so nothing
  re-downloads and folders never move.
- The **downloaded-chapters ledger is downloaded-truth**, and disk
  reconcile is **conservative**: ambiguity resolves to the
  orphan+missing pair, never to a guess; the ledger is not rewritten
  to match the disk.
- **API-key-only auth** — the single app-wide token is the only
  credential (the R4/*arr ruling, as amended: no optional password
  mode exists).
- **At most one webhook, zero channel adapters** — one generic JSON
  POST outbound; Discord/Telegram/ntfy/etc. bridging is the operator's
  business, not adapters in this app.
- **Files appear atomically at the final path** — temp-stage outside
  the scan surface, rename into place; scanners never observe partial
  files.
- **`.cbz` is the convention**; **no dotfiles or residue** in the
  library tree; **folder name = ComicInfo Series** (the scan-target
  contract in one line).

## 4. Core assumptions

Decision inputs, held as assumptions — a story may *rely* on them, not
re-derive them.

1. **Single user per instance** (R2) — one operator, one queue, one
   trust domain.
2. **A reverse proxy owns user auth**: Authelia/Authentik/PocketID in
   front of fmd-web is the expected deployment; we do not re-implement
   user identity, and the API token is for scripts, not people.
3. **Readers are the parsers** — Komga/Kavita parse, organize, and
   render; our exit format exists to be scanned, not read.
4. **FMD2-DB remains the module source** — we sync and run the real
   Lua ecosystem; no fork, no curated subset.
5. **Chapter lists are append-mostly with stable links** — sites add
   chapters; links do not churn. Link-keyed diff is sound under this
   assumption; when a site breaks it, TRIAGE shows it, we do not build
   alignment machinery.
6. **SQLite-scale** — one box, one `app.db`, one library root; nothing
   designs for multi-node, high write concurrency, or dataset sizes
   SQLite cannot serve.

## 5. Killed-ideas ledger

Each row is a decision **not** to build the thing, with its reason —
recorded so no future story re-proposes it. (Rows marked *deferred* are
the same ruling with a named reopen trigger.)

| Idea | Verdict | Reason (one line) |
|---|---|---|
| In-browser reader | KILLED | R1: acquisition layer only; readers are the parsers — any page-turner proposal is rejected on principle. |
| Stored series linkage (cross-site series table) | KILLED | Identity is (module, canonical URL); a linkage table is a second identity system that drifts; duplicates are a folder suffix, not a join. |
| Cross-site fallback downloading | KILLED | Breaks downloaded-truth attribution (chapter = link per module) and multiplies anti-bot exposure; a dead source belongs in TRIAGE, not silent substitution. |
| Chapter-number parsing / cross-site alignment | KILLED | Numbers parsed from titles are lossy and site-idiosyncratic; numbering is positional per site (§7) — alignment is unbounded toil with zero ledger value. |
| Batch site probing ("check all sites") | KILLED | A synchronized fan-out across ~454 sites is exactly the traffic shape that gets an IP challenged; the opportunistic availability record covers real use ([site-availability] ruling). |
| Export / backup feature | KILLED | SQLite-scale: a cold file-level copy of the data dir *is* the backup (runbook); an export format duplicates it worse. |
| Reverse-proxy documentation | KILLED | We do not document other products' deployments; auth belongs to the operator's proxy (§4.2), not to this repo. |
| Multi-user / per-user preferences | KILLED | R2: single-operator is a feature — one auth model, one queue, one trust domain; not "later", not behind a flag. |
| Rename operations (library UI) | KILLED | Renames desync ledger from disk and violate "nothing auto-deletes/renames user files"; the folder is computed-once-persisted (§3). |
| File contents over HTTP (beyond the artifact route) | KILLED | R1 boundary: the packed-artifact download route is the only byte-serving surface; everything else is metadata under the realpath clamp. |
| fs.watch / continuous disk watching | KILLED | Inotify drift and platform variance buy nothing over lazy stat-verify with a staleness window (the shipped [file-state] posture). |
| Orphan-adoption UI | KILLED | Conservative reconcile renders ambiguity as the orphan+missing pair the operator resolves on disk; interactive adoption invites wrong joins. |
| Disk monitoring | DEFERRED | Nothing gates on disk state at SQLite scale; reopen only if a story truly needs quota/health enforcement. |

## 6. Parity rule

When any question touches FMD2:

- **Semantics are the oracle.** What a feature *means* (what a favorite
  check does, what a chapter list is, what downloaded means) follows
  FMD2's behavior, verified against the Pascal source.
- **Mechanisms are a strong prior, not a contract.** *How* FMD2
  implements a thing (threads, dialogs, desktop idioms) informs but
  does not bind; the web-native mechanism wins when it fits better
  (R5).
- **Experience is ours.** Workflow, sequencing, and interaction design
  are fmd-web's to shape for the pipe-with-an-inbox identity (§1) —
  parity is never a justification for a worse workflow.

## 7. Numbering decision & FMD2 template tokens

**Decision**: chapter files are named **`<numbering> <chapter>`** —
e.g. `0123 Some Chapter Title.cbz`.

- `<numbering>` is the chapter's **1-based ordinal position in the
  site's chapter list**, zero-padded — FMD2's own semantics
  (`Format('%.4d', [i + 1])`, uSilentThread.pas:338), *not* a number
  parsed out of the chapter title and *never* aligned across sites
  (§5). The existing digit-padding setting governs the minimum width.
- `<chapter>` is the chapter name (post-§5.8 normalization, sanitized
  per the shipped filename policy).
- FMD2 grounding for the shape: `CustomRename` prepends the numbering
  when a chapter template contains neither `%NUMBERING%` nor
  `%CHAPTER%` (uBaseUnit.pas:1823–1825) — the decision fixes that
  default as a **single space** between the parts.

**FMD2 template tokens** (CustomRename placeholders,
uBaseUnit.pas:251–257) remain the rename vocabulary, with the shipped
`%CR%` substitution seam: `%NUMBERING%` · `%CHAPTER%` · `%WEBSITE%` ·
`%MANGA%` · `%AUTHOR%` · `%ARTIST%` · `%FILENAME%`. The default
chapter filename above is exactly `%NUMBERING% %CHAPTER%`.

## 8. Standing constraints

Bind **every story in this epic**, alongside the toolchain
non-negotiables in the README.

1. **Gates run via `/workspace/fmd-web/node_modules/.bin` directly —
   `npx` is broken in this sandbox.** Invoke `node_modules/.bin/tsc`,
   `node_modules/.bin/vitest`, `node_modules/.bin/eslint`, … never
   `npx <tool>`.
2. **Typed seams, no `any`-shaped crossings.** Every cross-boundary
   interface lives in `contract/types.ts` (or the generated web
   client); when the API changes, the **OpenAPI snapshot is
   regenerated** in the same change — snapshot drift is a failed gate,
   not a follow-up.
3. **Restart canon** (dev-preview restarts): find the real pid with
   `pgrep -af 'runtime-entr[y]'`, `kill` it, then

   ```sh
   FMD_WEB_DATA_DIR=/tmp/opencode/fmd-data PORT=3000 \
     FMD_STATIC_DIR=web/dist-web FMD_HTTP_ALLOW_HOSTS='*' \
     setsid nohup node server/dist/src/runtime-entry.js \
     > /tmp/opencode/fmd-app.log 2>&1 < /dev/null & disown
   ```

   then wait for `/readyz` = 200. **Never `pkill -f` a pattern that
   appears verbatim in your own command line** — bracket it like
   `'runtime-entr[y]'` so the matcher cannot see its own shell.
4. **Long-form commits.** Commit messages carry the full reasoning —
   what, why, the decisions honored, the gates run, the evidence — in
   the house style of this repo's history. A one-liner is a redo.
5. **No release tag.** Stories in this batch land untagged; tagging is
   the release story's act alone.
