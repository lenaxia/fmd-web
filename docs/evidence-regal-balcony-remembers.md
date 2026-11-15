# Evidence — tsk-regal-balcony-remembers (FMD2 lua/ tree sync: SHA pin, atomic swap, module diff report)

Date: 2026-11-13T19:20Z (rev. 2 — review-fix bounce 1, 19:30Z) · Environment: node v24.20.0, vitest 3.2.7, linux · Offline (loopback-only)

## Scope

`server/src/sync/modules/` — the `ModuleSyncService` per DESIGN §2, §6, §8.5 and
D9: fetch the FMD2 repo `lua/` subtree at a PINNED commit (codeload zipball,
base URL configurable for forks), stage into a temp dir on the data volume,
run strict Init-pass validation on the staged tree, ATOMIC swap into
`data/lua/`, record `sync_state(repo, sha, fetched_at, report)`, and emit a
module diff report vs the previous pin (added/removed/changed by ID/Name) for
the D9 review gate. `FMD_LUA_DIR` local-dir override skips fetching.
Auto-bump DISABLED by default — sync runs against the configured pin only.

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Fixture-zipball integration tests: install, verify, atomic swap; SHA-mismatch and broken-module refusal leave the previous tree intact | `module-sync.integration.test.ts` (13 tests, **offline** — codeload is a loopback `node:http` mock upstream, allowed by DESIGN §13): (1) **happy path** — v1 zipball built at runtime from REAL module sources of the local FMD2 checkout (`11Toon.lua`, `AsuraScans.lua`, `Hentai2Read.lua`, `YoungAceUp.lua` + `templates/Madara.lua`, `utils/jsunpack.lua`, `modules/MangaPlus.proto`), root dir `FMD2-97c903b340` (codeload convention); asserts the pinned URL was requested (`/dazedcat19/FMD2/zip/97c903b3…`), the full `lua/` subtree landed in `data/lua/` (modules + templates + utils + the non-lua asset, nothing outside the subtree), report counts (4 module files, 6 parsed lua files, 1 other file, 4 modules registered, zero warnings), first-sync diff = all-added, and `sync-state.json` holds `{repo, sha, fetched_at, report}` with the injected clock; (2) **atomic swap v1→v2** — exact tree replacement (removed file gone, added file present, rename visible in file content), no `.sync-*` staging leftovers, `previousSha` recorded; (3) **SHA-mismatch refusal** — zipball rooted `FMD2-0000000000` → `ModuleSyncError(reason 'sha-mismatch', details {expectedRoot, actualRoot})`, and the previous tree is **byte-identical** (per-file SHA-256 fingerprint) with `sync-state.json` unchanged; (4) **broken-module refusal** — v1 + `modules/Broken.lua` (Lua syntax error) → `reason 'staged-init-failed'` with `failures: ['modules/Broken.lua']`, previous tree fingerprint + state byte-identical, no staging leftovers; (5) first-install refusal variant proves `data/lua` is **never created** on a failed validation; (6) corrupt archive / no-`lua/`-subtree / unreachable-upstream refusals; (7) **zip-slip regression (review blocker fix)** — pinned-root zipball carrying `../../../pwned.txt` + `modules/../../../../pwned2.txt` → refused `zip-corrupt` ("escapes the lua/ subtree"), previous tree + sync_state byte-identical, and `pwned.txt`/`pwned2.txt` proven absent in the data dir AND every ancestor dir (the pre-fix bug wrote them outside staging during extraction); plus a `safeSubtreeRelative` unit test (clean path accepted; `..`/`.`/`\`/`//`/foreign-root refused). | met |
| Diff report golden test (added/removed/changed detection by module ID) | `module-diff.golden.test.ts` vs committed `server/test/sync/golden/module-diff.golden.json` (regenerate `UPDATE_GOLDEN=1`): inventories carry the REAL fixture module IDs (same keys the integration syncs produce) — added `CraftedFixture` (`aaaacccc…`), removed `Hentai2Read` (`053da850…`), changed `11Toon` (`c7b742a4…`, name `11Toon`→`11Toon Classic`, same file). Also proves: identical inventories → empty diff; first sync = all-added sorted by ID; same-ID file move flagged as changed with name context. The integration v1→v2 sync asserts the live report's diff matches the same three entries — the pure function and the service agree. | met |
| Local-dir override path tested; auto-bump disabled by default (config default asserted) | `module-sync.integration.test.ts` local-dir describe: `FMD_LUA_DIR` config stages+validates+installs a local tree with a fetch spy asserting the fetcher is **never called** (`source: 'local-dir'` in result + report); missing local dir → `reason 'local-dir-missing'`, target tree untouched. `module-sync-config.test.ts` (6 tests): `loadModuleSyncConfig({})` defaults asserted (repo `dazedcat19/FMD2`, pin = `DEFAULT_FMD2_PIN_SHA` = the checkout SHA the corpus was captured from, codeload base, **`autoBump === false`**, no override); `FMD_SYNC_AUTO_BUMP=true/1/yes/on` → `ModuleSyncConfigError` mentioning D9; constructed `autoBump: true` config → refused at `createModuleSyncService`; env overrides (`FMD2_REPO`, `FMD2_LUA_SHA` — invalid SHA refused, `FMD2_CODELOAD_URL`, `FMD_DATA_DIR`, `FMD_LUA_DIR`); `codeloadZipballUrl` shape incl. trailing-slash fork base; `expectedZipballRoot` = `FMD2-97c903b340`. | met |

## Implementation notes

- **`service.ts`** — orchestration: previous sync_state → stage (mkdtemp under
  `dataDir` so the final rename is same-filesystem) → validate → `installStagedTree`
  → diff + record. Every refusal path throws `ModuleSyncError` with a typed
  `reason` (`fetch-failed | zip-corrupt | sha-mismatch | local-dir-missing |
  staged-init-failed | config`) **before** `data/lua/` is touched; the
  `finally` removes the staging dir (asserted: no `.sync-*` leftovers).
- **SHA verification** (`expectedZipballRoot` + `verifyZipballRoot`): GitHub
  codeload names the zipball root `<RepoName>-<first 10 hex of the SHA>`. The
  extracted archive must contain exactly one root dir matching
  `FMD2-<sha10>` (case-insensitive) — a response for any other ref (branch,
  tag, other commit) is refused before extraction into staging. Only the
  `<root>/lua/` subtree is staged.
- **Zip-slip guard** (`safeSubtreeRelative`, review-fix): extraction writes
  the path AFTER the `<root>/lua/` prefix, and that sliced relative path must
  be clean — any `..` traversal, `.` segment, empty segment (incl. leading
  `/`, which also catches absolute-path entries), or backslash segment is
  refused `zip-corrupt` ("escapes the lua/ subtree") BEFORE any byte is
  written; a belt-and-suspenders `resolve()` containment assert runs as
  well. Regression-tested both at the function level (clean path accepted;
  `..`/`.`/`\`/`//`/foreign-root refused) and end-to-end (crafted pinned
  zipball with `../../../pwned.txt` + `modules/../../../../pwned2.txt` →
  loud refusal, previous tree + sync_state byte-identical, probes of the
  data dir and all ancestor dirs prove neither file exists, no staging
  leftovers). Note: entries with an empty FIRST segment (absolute paths)
  were already refused inside `verifyZipballRoot` as archive-root escapes.
- **`zipball.ts`** — self-contained ZIP reader (central directory + local
  headers): stored + deflate (`zlib.inflateRawSync`), CRC-32 verify per entry
  (standard check vector `123456789 → 0xCBF43926` tested), loud refusals for
  zip64/encrypted/unknown-method/truncation. No new dependencies.
- **Strict staged validation** (`validate.ts`): non-module `.lua` files
  (templates, utils) are compile-checked via the chunk cache (parse failures
  throw); every `modules/*.lua` runs the REAL production Init pass
  (`WasmoonModuleRegistry.loadFile` over a fresh `createLuaHost`). The Init
  pass is tolerant by design (FMD2 DoInit semantics — errors logged, module
  dropped), so the gate derives strictness from the log: any new
  error-level record for a file — or a parse throw escaping the tolerant
  catch — is a fatal `StagedFileFailure`. Zero registrations from a clean
  Init is a warning (missing-ID/Name drops are FMD2-legal). Inventory =
  `{id, name, sourceFile}` per registration.
- **Atomic swap** (`swap.ts`): previous tree renamed aside → staged tree
  renamed in → backup deleted; rename-in failure rolls the previous tree
  back. Consumers never observe a partial tree.
- **`state.ts`** — `SyncStateStore` port + `FileSyncStateStore` (JSON at
  `<dataDir>/sync-state.json`, tmp+rename writes) mirroring the §9 table
  shape `sync_state(repo PK, sha, fetched_at, report)`; the SQLite store
  lands with the db stories and swaps in via the port. Reports embed the
  installed inventory so the next sync diffs without a re-Init pass.
- **`diff.ts`** — `diffModuleInventories(previous, current)` keyed by module
  ID; `changed` = same ID with different Name or source file; entries sorted
  by ID for deterministic (golden-stable) reports.
- **`fetcher.ts`** — `ZipballFetcher` port; `CodeloadZipballFetcher` uses
  global fetch with timeout (60 s) + size cap (200 MiB); base URL is
  config, so forks sync via `FMD2_CODELOAD_URL`.

## Verification

- `npx vitest run server/test/sync/modules` → **4 files, 27 tests passed**
  (integration 13, config 6, zipball 5, diff golden 3).
- Full monorepo suite mid-session: `npm test` → 61 files / 724 tests passed
  (incl. `corpus/test/no-network.test.ts` — the whole run stayed offline
  while the loopback codeload mock was active); `npm run typecheck` passed
  at the same point. Final re-run (after the review fix): **every test
  outside `server/test/sync/db/` passes** — that dir is the parallel
  catalog-sync story's mid-flight work (12 failures there are theirs, zero
  in any file this task added or touched).
- `npx eslint server/src/sync/modules server/test/sync/modules` → clean.
  (Repo-wide lint currently flags one `prefer-const` in
  `server/src/sync/db/sync-service.ts` — the parallel catalog-sync story's
  file, in flight during this task; not part of this change.)

## Review-fix note (bounce 1)

- **Blocker (zip-slip)**: extraction wrote `join(stagedDir, relative)` with
  no containment check, so a `<root>/lua/../../../pwned.txt` entry passed
  root verification and escaped staging. Fix: `safeSubtreeRelative` refuses
  any `..`/`.`/empty/backslash segment in the sliced relative path (thrown
  before any write) plus a `resolve()` containment assert; regression tests
  added at both the unit and end-to-end level (see criterion 0 row). During
  the fix, an adjacent latent bug surfaced: `posix.join(root, 'lua', '')`
  drops the trailing slash, which made every sliced path start with `/` —
  the subtree prefix is now the explicit `` `${root}/lua/` `` template.
- **Major (evidence accuracy)**: the previous claim "Multi-root or escaping
  entries → zip-corrupt" was false for `..`-segment entries at the time;
  the code now enforces exactly that, and the implementation note above
  states the precise refusal set (incl. where absolute-path entries are
  refused).
- Note on shared workspace: two parallel stories are mid-flight in the same
  tree (`server/src/engine/registry/`, `server/src/sync/db/`, both untracked).
  During setup, `engine/registry/module-sync.ts` had a one-line string-literal
  syntax error that made `tsc -b` fail for the whole server package; it was
  repaired with the minimal intended fix (`DO_INIT_SUFFIX = '")> '`). All
  other files under those dirs are untouched by this task.

## Files

- `server/src/sync/modules/`: `config.ts`, `zipball.ts`, `fetcher.ts`,
  `diff.ts`, `validate.ts`, `swap.ts`, `state.ts`, `service.ts` (exported
  from `server/src/index.ts`).
- `server/test/sync/modules/`: `fixture-zipball.ts` (stored-zip builder +
  real-source fixture trees), `module-sync.integration.test.ts`,
  `module-sync-config.test.ts`, `module-diff.golden.test.ts`,
  `zipball.test.ts`; golden `server/test/sync/golden/module-diff.golden.json`.
