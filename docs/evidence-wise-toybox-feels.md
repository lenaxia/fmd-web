# Evidence — Library layout: flat series folders (tsk-wise-toybox-feels)

Story: the default library layout `<libraryRoot>/<module>/<manga>/<file>`
was hostile to browsing by series (hundreds of site folders to dig
through). Owner decision: `<libraryRoot>/<manga>/<file>` — the module is
NOT a path segment; duplicates (same series followed from two sites)
get a module suffix on the FOLDER name. One-time idempotent migration
for ledger-recorded files; non-ledger stragglers stay with the existing
rescan/orphan machinery.
Date: 2026-11-19. Status: implementation complete; gates below.

## Shipped

### Rule 1 — the flat default target
- `LibraryFinalizer.targetPath` (server/src/jobs/library/finalize.ts):
  the default dir is `path.join(libraryRoot, safeComponent(manga))` —
  ONE folder component, the effective manga folder. The
  `FinalizeRequest.moduleId` component is REMOVED from the interface
  (the module is not part of the layout anywhere). Sanitize/truncate
  policy unchanged (`sanitizeFileName` RemoveSymbols parity +
  `truncateKeepTail(255)` per component; the manga folder segment
  itself keeps the shared `urlSegment` derivation — sanitize +
  truncate-80 + url-tail fallback — exactly the pre-change component).

### Rule 2 — duplicates: `<manga> [<module>]`, first writer keeps the clean name
- New `server/src/jobs/library/layout.ts`: `suffixedMangaFolder`
  (`<sanitized manga> [<sanitized module>]`, whole component
  tail-truncated so the discriminating suffix always survives the cap),
  `safeFolderComponent`, and the pure `isForeignClaim` decision
  (a different module among the ledger claimants, OR an unattributed
  on-disk folder → the newcomer suffixes).
- The effective folder resolution lives on the store
  (`SqliteLibraryStore.resolveMangaFolder`), called by the download
  lane ONLY for default-layout downloads:
  1. the favorite's persisted `library_folder` (computed-once seam —
     the same additive-column pattern the edSaveTo `save_to` override
     rides; guarded ALTER in `ensureLibrarySchema`);
  2. else the folder this module's own recorded ledger rows already
     use (rows whose recorded path is exactly
     `<root>/<row.manga>/<row.fileName>` — layout rows; saveTo rows at
     other shapes never seed a folder) — this also HEALS migration-era
     favorites that predate the column;
  3. else the clean title folder, suffixed when
     `distinctModuleIdsUnderPath(<root>/<clean>)` (substr equality,
     never LIKE — `%`/`_` in folder names are not wildcards) holds a
     different module, or the folder exists on disk with no ledger
     attribution (unknown claim, conservative).
  The computed value is persisted onto the favorite when one exists
  (`setFavoriteLibraryFolder`, UPDATE-only) and onto every recorded
  ledger row (path + `manga` column = the effective folder) — it is
  NEVER recomputed: deleting other favorites (or their files) can never
  re-point an existing folder (regression-pinned). Same-name-different-
  actual-series across sites follows the identical rule (accepted).
- Lane (server/src/runtime/download-lane.ts): `effectiveManga` feeds
  both `finalize` and `recordLibraryFile`; the WORK dir
  (`dataDir/downloads/<module>/<manga>/<chapter>`) keeps its module
  segment — it is job staging, not library layout.

### Rule 3 — saveTo precedence unchanged
- `saveTo` still REPLACES the computed prefix entirely
  (`path.resolve(libraryRoot, saveTo)`); when present the lane derives
  NO effective folder (and persists none) and the ledger row keeps the
  clean segment as display metadata. Lane-level regression: an
  overridden download lands at `<root>/<saveTo>/…` with NO clean-name
  folder created.

### File-truth surfaces (the tsk-skilled-toolbar-restricts coordination)
- Reconcile CONVENTION rule (server/src/jobs/library/reconcile.ts):
  the slot is now `<root>/<row.manga>/<row.fileName>` — the recorded
  manga segment IS the effective folder (clean or suffixed); the
  module-qualified 3-segment form is gone. The conservative discipline
  is intact: exact-one-unclaimed-candidate convention match, the
  EXACT-FILENAME fallback, ambiguity never auto-links (the orphan+
  missing pair).
- `titleConventionDirs` (server/src/runtime/library-file-state.ts):
  dirs are the recorded `row.manga` folders plus the predicted
  `urlSegment(manga ?? url)` — no module prefix; the claimed-set
  discipline (ANY row recording into a dir claims its files —
  cross-title saveTo rows never false-orphan) is unchanged.
- Legacy segment matching (`rowsForTitle`): candidate segments now
  ALSO include the suffixed form `<segment> [<sanitized module>]`, so
  pre-provenance rows recorded under a duplicate folder still resolve
  for their title.
- Files listing / rescan / copy-path surfaces render the new
  root-relative display paths (web unit + e2e seeds updated).

### One-time idempotent migration (server/src/jobs/library/migrate.ts)
- Runs at startup post-upgrade (assembly wiring, right after the store
  opens; logged through the structured logger,
  `event: library_layout_migration`).
- OLD-LAYOUT DETECTION: a row is old-layout only when its recorded
  root-relative path is exactly `<row.moduleId>/<row.manga>/<row.fileName>`
  — the depth-3 shape the pre-change finalizer wrote, segment-matched
  against the row's own recorded components (saveTo rows at any other
  shape never match; the one documented edge is a saveTo that literally
  resolved to the module/manga pair — shape-identical, migrated with
  it). Out-of-root rows are never touched.
- First-writer-keeps-clean: rows process ascending id; clean-folder
  claims seed from rows ALREADY on the new layout (a partial earlier
  run) and register as rows migrate; a DIFFERENT module claiming the
  clean name (or an unattributed on-disk folder) suffixes the newcomer
  per rule 2, persisting the effective folder on the row (path + manga
  column). No retroactive renames — an already-suffixed folder never
  collapses onto a freed clean name.
- Moves are `renameSync` into `mkdir -p`'d targets; moved rows get
  fresh stat truth (bytes/mtime/verified_at/state='downloaded' — the
  `applyLayoutMigration` one-transaction persist). A file missing at
  its old path still re-points (stays missing at the new location
  until a rescan re-links). An OCCUPIED target is a collision —
  nothing moves, the row keeps its old-layout path (retried next boot,
  logged), the stray stays rescan truth. Empty `<module>` shells are
  pruned bottom-up after the moves (never a dir still holding
  anything, never the root).
- Summary log: `[library-layout-migration] done: moved=… repointed=…
  suffixed=… skipped=… collisions=… failures=… prunedDirs=…`.
- Re-running is a no-op (detection finds only new-layout rows).
  Non-ledger files are NOT adopted — the existing rescan/orphan
  machinery owns them.

## Regressions
- server/test/jobs/library/layout.test.ts (new): folder computation —
  sanitize parity, component cap, the suffix form (sanitization,
  tail-surviving truncation, idempotence, module-sanitizes-away
  fallback), the pure claim decision, the unchanged clean-segment
  derivation.
- server/test/jobs/library/manga-folder.test.ts (new, real store +
  temp root): first-clean, different-module-suffixes, persisted +
  NEVER recomputed (the other favorite's rows and files vanish — the
  suffix stays), ledger claims without favorites, own-row healing of
  migration-era favorites, unattributed-disk-folder suffix,
  saveTo-only favorites never gain a folder, favorite re-create after
  delete, distinctModuleIdsUnderPath exactness.
- server/test/jobs/library/migrate-layout.test.ts (new): detection
  triple (flat/deeper/mismatched/outside never match), move + ledger
  re-point with fresh stamps, duplicate suffixing during migration
  (first clean / second suffixed, folder recorded on the row),
  same-module stays clean, unattributed disk folder, saveTo rows
  untouched, missing-file re-point, occupied-target collision (row
  keeps the old path, the log names it), empty-shell pruning vs a
  stray-holding tree, IDEMPOTENT re-run (all-zero second pass),
  partial-earlier-run claim seeding, empty-root no-op.
- server/test/runtime/download-lane-layout.test.ts (new, REAL queue +
  packers + store over the loopback fixture site): the same series
  from two seeded modules lands as `Alpha Quest/` and
  `Alpha Quest [<moduleB>]/` (both artifacts on disk, ledger rows
  carry folder + module metadata); module B's SECOND chapter lands
  beside the first (sticky folder); saveTo replaces the prefix and no
  clean folder is created.
- Updated to the flat convention: finalize.test.ts (target +
  component guards), finalize-saveto.test.ts (default prefix +
  override semantics unchanged), dual-write.test.ts (finalize
  integration), file-state-reconcile.test.ts (present/moved/convention/
  ambiguity/out-of-root/dotfile seeds + a NEW suffixed-slot convention
  re-link case), library-file-state.test.ts (svc seeds), api/
  library-file-state.test.ts (route seeds), web e2e
  library-file-state.spec.ts (display paths; 3/3 green), web
  files-section/library-file-state unit fixtures.

## Gates
- tsc -b (root, --force): CLEAN. eslint (full repo): CLEAN.
- vitest full tree: 236 files / 2322 passed / 3 skipped / 0 failed
  (the parallel [auth] lane's own grep gate green after their landing).
- web e2e (desktop + mobile): 107 passed; the 2 Settings
  virtualized-scroll perf specs flaked identically to the documented
  pre-existing loaded-runner budget (b8de66f/99c5edd triage — not a
  regression; library/file-state surfaces unaffected).
- library-file-state e2e spec: 3/3. openapi snapshot byte-equality 6/6
  + web client drift green after the merged-surface regen.
- LIVE PREVIEW (restarted per the runtime-entry procedure against the
  carried-over OLD-layout data dir): boot migration logged
  `[library-layout-migration] done: moved=12 repointed=0 suffixed=0
  skipped=0 collisions=0 failures=0 prunedDirs=4`; the real
  `library/<module>/<manga>/…` tree flattened to `library/<manga>/…`
  (module shells pruned); GET /api/library serves the flat display
  paths with downloaded states; POST /api/library/rescan reconciles
  clean (scanned=12 present=12 missing=0 orphans=0 relinked=0); a
  SECOND restart logged the all-zero no-op (moved=0 skipped=12) — the
  idempotency contract live; /readyz 200 throughout.

## Sequencing note
Landed behind the parallel [auth] session (same worktree, coordinated:
each staged its own files; the openapi snapshot + web client were
regenerated over the MERGED surface as the final pre-commit step of
whichever lane landed last).
