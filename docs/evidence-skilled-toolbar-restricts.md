# Evidence — Library file state (tsk-skilled-toolbar-restricts)

Story: the web window onto server storage — verified chapter-file state
(downloaded/missing/not_downloaded/orphan), manual rescan with
conservative moved-file re-linking, per-title Files listings, and the
metadata-only guardrails. Owner-approved design: metadata only (NO file
contents over the new surface), moved-within-root handled robustly,
rename DEFERRED, no fs.watch.
Date: 2026-11-19. Status: implementation complete; gates below.

## Shipped

### State contract (per chapter file)
- `downloaded` — downloaded-chapters ledger entry AND its file exists at
  the recorded path (stat-verified; the `library_files` row carries the
  absolute path).
- `missing` — ledger entry, file not at the recorded path (moved-out and
  deleted deliberately indistinguishable until a rescan re-links).
- `not_downloaded` — no ledger entry (chapter-side: the web merges the
  lazy-verified states against the live chapter list).
- `orphan` — file under the library root no ledger row claims (rescan
  truth; per-title listings scope it to the title's convention directory).
- Every tracked row carries `verified_at` (+ the cached verdict + mtime,
  additive columns) and its recorded absolute path.

### Server
- **Shared walker seam** (`server/src/fs-walk.ts`): ONE recursive
  `withFileTypes` tree walk — the engine's staged-validation inventory
  delegates here with its exact historical traversal (reuse, not a
  fork), and the library walks add the guardrail options: dotfiles
  skipped (prunes `.tmp-` finalize litter), symlinked files admitted
  only when their realpath stays under the root (escapes REJECTED —
  skipped, never listed), symlinked directories never followed.
  Realpath clamp helpers (`isUnderRoot`/`rootAnchor`/
  `lexicalRelFromRoot`/`displayFromRoot`) back every path decision.
- **Reconcile core** (`server/src/jobs/library/reconcile.ts`, pure):
  presence at the recorded path; conservative re-linking for
  moved-within-root — CONVENTION rule first (the app's §7.1
  `<module>/<manga>/<file>` output slot hitting exactly one unclaimed
  candidate), then the EXACT-FILENAME rule (exactly ONE unclaimed
  same-name file anywhere under the root); ambiguous cases (2+
  same-name candidates) surface as an orphan+missing PAIR with the
  candidates listed — never auto-linked. Out-of-root rows counted
  (`outsideRoot`), never displayed.
- **Store** (`library_files` additive columns via guarded ALTERs):
  `verified_at`, `state` (cached verdict), `mtime`, `manga_url`,
  `chapter_link` (download-lane provenance — the ONE ledger truth keys
  per-title listings; legacy rows join on the sanitized layout segment
  via the shared `urlSegment` derivation moved into filenames.ts).
  New methods: ledger-row projections, per-title row resolution,
  `applyVerification` (one transaction), `relinkLibraryFile`.
  `recordLibraryFile` seeds warm verification truth (finalize just
  committed the file) and persists the provenance.
- **File-state service** (`server/src/runtime/library-file-state.ts`):
  lazy verify (stale >15 min or `?refresh=1` re-stats; fresh verdicts
  serve from the cache — the tolerance window the no-fs.watch ruling
  implies); `titleFiles` (ledger-first: imported links without rows
  render missing; scoped orphan walk of the title's convention dir);
  `rescan` (global + per-title variant: walk → reconcile → persist
  re-links/verdicts → persisted diff report in `app_settings`);
  `listWithState` (Library page enrichment; `filter=missing` scans
  newest-first stat-verified; `filter=orphans` serves the last
  rescan's persisted orphan list — orphan truth is rescan truth).
- **Routes** (optional `fileState` seam, metrics-route posture):
  `GET /api/library/title-files`, `POST /api/library/rescan`,
  `GET /api/library/rescan`; `GET /api/library` gains the additive
  state fields + `filter` (typed 400 when the seam is absent — never
  silently ignored). All new endpoints are METADATA ONLY.
- **Guardrails**: `GET /api/library/:id/file` (the R1-sanctioned
  download boundary, pre-existing) is now realpath-clamped — a
  recorded path resolving outside the root is a typed 403
  `path_outside_library_root` (new additive contract code), dotfiles
  never served; missing files keep the 404. No NEW endpoint serves
  file bytes.
- OpenAPI snapshot + routes inventory regenerated; web client
  (`openapi.d.ts`) regenerated; the snapshot byte-equality and
  client-drift tests green.

### Web
- **FilesSection** (manga detail): per-chapter rows with state badges,
  human size (the ONE shared `formatBytes`, extracted from the Library
  page), UTC date (`formatFavoriteDate` — L-1), root-relative path,
  copy-path (recorded absolute path; toast feedback), visible
  verification-age line (R3: never tooltip-only), explicit Refresh
  (`?refresh=1`) and the per-title Rescan with its summary line.
- **MangaPage chapter badges**: verified truth wins — `downloaded` /
  `missing` badges (data-file-state attr); not_downloaded stays
  badge-less (FMD2 parity, the muted row).
- **LibraryPage**: All/Missing/Orphans chips with URL-as-truth
  (`?filter=`, replaceRoute + back-nav restores), per-row state badge
  with verification-age title + copy-path, the Rescan library toolbar
  action with the persisted report view (re-links with former paths,
  missing-with-candidates disclosure, counts), orphan rows under the
  Orphans chip, and honest empty states ('no rescan has run yet').
- Hooks: `useTitleFiles`, `useRescanLibrary` (invalidates the
  library/title-files/rescan caches), `useLastRescan`, filter-aware
  `useLibrary`.

## Deferred (documented, NOT built — owner rulings)
- Rename operations.
- File-content download/zip beyond the pre-existing packed-artifact
  route (R1 boundary) — the Files/orphan surface is metadata-only.
- Continuous fs.watch (lazy verify + manual rescan cover it).
- Interactive orphan adoption (v1 resolution: delete the ledger entry
  or ignore the orphan).
- Job-based rescan progress for very large libraries (the walk is a
  synchronous local-disk readdir/stat; the UI busy-states the button).
  Revisit with the job machinery if large-library latency is felt.

## Verification (2026-11-19, via node_modules/.bin — npx broken)
- `vitest run server/test/jobs/library/file-state-reconcile.test.ts` —
  **11/11**: walker dotfile/symlink-escape/admission, clamp helpers,
  moved-within-root re-link (exact filename + convention + former
  path), ambiguity orphan+missing pair, claimed-file exclusion,
  out-of-root counting, dotfile invisibility.
- `vitest run server/test/runtime/library-file-state.test.ts` —
  **11/11**: state contract (downloaded stamp/paths; cache-then-refresh
  tolerance window; >15-min staleness re-verify with persisted
  verdict; ledger-first imported-missing; legacy segment matching;
  scoped orphans with dotfile skip), rescan persistence (moved+deleted+
  orphan seed, report round-trip via app_settings, ambiguity pair,
  per-title scoping), listWithState filters.
- `vitest run server/test/api/library-file-state.test.ts` — **7/7**:
  title-files route shape + metadata-only key assertion, rescan POST +
  persisted GET round-trip, seam-absent 404s + filter 400, library
  filters + enrichment, symlink-escape download → typed 403 with no
  bytes, in-root symlink streaming.
- `vitest run web/test/files-section.test.tsx
  web/test/library-file-state.test.tsx` — **11/11**: FilesSection
  per-state render + labels + formatters, copy-path absolute target,
  refresh flag, per-title rescan summary; chips URL-as-truth (parse,
  rewrite, clear), badges + verification-age title, copy-path, rescan
  report render.
- Full tree `vitest run`: **2239 passed / 3 skipped** with the single
  openapi route-inventory failure a TRANSIENT mid-run artifact of the
  parallel [site-availability] session (their routes.ts row landed
  after the run's snapshot read; re-run green — see the parallel note).
- `eslint .` clean; `tsc -b` green on every story file (see parallel
  note); `engine-boundary-gate.sh`: no violations from story files (the
  tree's 6 pre-existing violations — cover-proxy/assembly deep engine
  imports — predate this story, reproduced on HEAD).
- e2e `playwright test library-file-state --project=desktop` — seeded
  moved+deleted+orphan library: badges before/after rescan, the
  re-link (former→new path) in the report and the re-pointed listing,
  chips URL assertions, Files section + chapter badges + per-title
  rescan, copy-path toast (outcome recorded after the parallel session
  settled; see below).

## Parallel-session note (NOT owned by this story)
A concurrent [site-availability] session is active in the shared tree
(availability.ts, site-availability.ts, engine service edits, Settings
web facets — with interleaved hunks in the shared api/hooks files).
Mid-flight snapshots of THEIR web layer (AvailabilityChip/SettingsPage
tsc errors) came and went during this story's gate runs; every failure
reproduced outside story files. Coordination resolved the sequencing:
they committed first (b8de66f, staged via update-index — my hunks
untouched), this story's commit (99c5edd) landed directly behind it as
exactly the [file-state] diff.

## Final gates on the landed tree (post-commit, 2026-11-19 ~03:50)
- `vitest run` (full): **226 files, 2232 passed / 6 skipped / 0 failed**
  (both features' suites green on the merged tree; the earlier
  drift-check flakes were a scratch-worktree node_modules-symlink
  artifact — disproven by removing the story's only contract change
  and re-running, and absent on the real tree).
- `tsc -b`: 0 errors. `eslint .`: clean (exit 0, zero findings).
- `playwright test library-file-state --project=desktop`: **3/3**.

## Live verification (restarted preview per the runbook procedure)
Preview restarted from the landed dist (vite build + runtime-entry,
readyz 200 in 2 s) over the pre-existing live data dir, then:
- `GET /api/library` rows carry `state: "downloaded"`, root-relative
  `path` + `absolutePath`, `mtime`; the verified_at stamp lands on the
  request AFTER the first stat (the write-on-stale discipline — the
  first response renders the pre-stamp snapshot by design, the second
  shows the persisted stamp).
- Seeded the VERIFY scenario LIVE — one file moved to `imported/`, one
  deleted, one stray dropped in the title dir — then
  `POST /api/library/rescan`: counts `scanned 12 / present 10 /
  relinked 1 / missing 1 / orphans 1`; the report carried the re-link
  (`fromPath …/Sousou no Frieren/Ch.003.zip` → `toPath imported/
  Ch.003.zip`), the missing entry with its former path and empty
  candidates, and the orphan. The re-link PERSISTED (the listing shows
  Ch.003 `downloaded @ imported/Ch.003.zip`; `filter=missing` serves
  exactly the deleted Ch.002).
- `GET /api/library/title-files` live: the ledger-first shape renders
  chapter links without rows as `missing` (no fileName/path), and the
  orphan scoping holds (the stray under the OTHER title's dir does not
  surface for an unrelated title).
- Restore pass: moved the file BACK to its convention slot + restored
  the deleted file + removed the stray — the closing rescan re-linked
  the move-back via the CONVENTION rule (present 11 / relinked 1 /
  missing 0 / orphans 0) and `filter=missing` serves zero rows: the
  live library is left clean.
