# Evidence — Downloads parity (tsk-retro-fountain-tasks)

Story: downloads-tab task controls, bulk ops, filters, search, progress rendering.
Date: 2026-11-17. Status: implementation complete + re-verified by the fresh claim; ready for review.

## Shipped

### Server (additive API)
- `POST /api/jobs/:id/action {type: pause|resume|retry|redownload|enable|disable}` — one typed-union route; state-matrix enforced; illegal → 409 typed envelope carrying `details: {job: {id, state, paused}, action}`.
- `DELETE /api/jobs/:id[?data=true]` — row-only | row + recorded library artifact (`progress.libraryPath` recorded at finalize; `SqliteLibraryStore.deleteLibraryFileByPath` removes file + row).
- `POST /api/jobs/bulk-action` — `{pause|resume, scope: all}` (Stop All / Resume All) and `{delete, scope: completed}` (RemoveAllFinishedTasks, done rows only, artifacts kept). Idempotent: chain-aware resume counts only fresh re-enqueues → settled queue = `affected: 0`.
- `GET /api/jobs` extended: `states` (csv multi-select, 400 on unknown), `q` (title/chapter substring), `addedFrom`/`addedTo` (inclusive UTC days).
- Queue: `hold`/`remove`; `idempotencyKey` surfaced on rows; WS publishes hold/lift snapshots (delete not published — no deletion frame in D19; clients invalidate).
- Lane: `rate` (5s-window transfer meter over new `onImageSaved` byte ticks), stages `compress` (zip/cbz) / `convert` (pdf/epub), `libraryPath` in finalize progress.

### Web
- `DownloadsPage` rewrite: `JobsToolbar` (search + Resume all / Pause all / Delete completed with confirm dialog), `JobFilters` (state chips + date windows Today/7d/30d/Older/custom From/To — URL-synced via `downloads-filter-state`), `JobRow` (real progress bar done/total, FMD2-palette status badge via `job-status.ts` tokens, transfer rate, overflow menu with full action set + delete choice + View info → manga page). No raw JSON.
- Hooks: `useJobAction`, `useDeleteJob`, `useJobBulkAction`, filtered `useJobsList`.
- OpenAPI snapshot + `openapi.d.ts` client regenerated (`npm run api:snapshot`, `npm run gen:api`).
- UX-PARITY.md Part 3: drag-reorder row now INTENTIONALLY-DIFFERENT (server-ordered queue; stable cursor pagination).

## Verification (originally run 2026-11-17 by the first claim; re-verified 2026-11-17 by the fresh claim — commands and outcomes below)

- `npx vitest run server/test/api/jobs-{actions,test,batch,cancel-library,paused-saveto}.test.ts server/test/runtime/download-lane{,-knobs,-output}.test.ts` — jobs cluster: **60/60 passed** (incl. the new 15-test `jobs-actions.test.ts`: full action×state matrix incl. held variant, bulk idempotence double-pass, delete+data artifact assertion, scope-pairing 400s, filter params). Plus adjacent API/WS cluster (`pagination`, `openapi`, `api/ws/*`): **64/64 passed** — the openapi snapshot-consistency test and the client-vs-snapshot byte-identity drift test both green (criterion 4 regen proof).
- `npx vitest run web/test` — **189/189 passed** (incl. updated `downloads-feed.test.tsx` chip-based flow).
- `npx playwright test downloads-parity --project=desktop` — **4/4 passed** (pause/resume round-trip with fresh-row chain; progress bar advances + no-raw-JSON DOM grep; URL-sync for chips/search/window/custom range; toolbar bulk round-trip with confirm). First run of the day had 1 `ERR_CONNECTION_REFUSED` (vite dev-server cold drop, the documented f5f7df0 flake class); immediate rerun: clean 4/4.
- `npm run lint` (eslint . whole repo) — **clean** after one fix by the fresh claim: `DownloadsPage.tsx` carried an inline `eslint-disable react-hooks/exhaustive-deps` comment, but this repo's flat config registers no react-hooks plugin, so the reference itself was the only lint error in the tree (converted the disable to a plain prose comment documenting the deliberate dep array).
- tsc: **0 errors in story files**. `tsc -p web/tsconfig.json --noEmit` fully clean; root `tsc -b` errors are 100% confined to the parallel-session engine/lua/sync mid-refactor files disclaimed below (verified by file-by-file filtering of the full 64-error list).

## Intentionally different (documented)
- Drag/Del/Ctrl-arrow reordering → UX-PARITY.md Part 3: queue is server-ordered (`priority DESC, id ASC`); stable keyset pagination prevents row jumping.
- Filter tree → chips + dropdowns (multi-select supersedes the tree's single-choice nodes).
- FMD2 STOP/DISABLED distinct states → single `paused` hold; pause-on-running = cancel-with-markers (resumable via chained re-enqueue).

## Claim continuity note
The first claim lapsed mid-story after completing the implementation above (uncommitted working tree, like the epic's prior stories); the row requeued and was re-claimed. The fresh claim re-verified every cluster (outcomes above), fixed the single lint error found (unloaded-rule disable comment in `DownloadsPage.tsx`), and moved the story to review with this file + `docs/UX-PARITY.md` as evidence.

Parallel-session breakage NOT owned by this story (present in the shared tree, left for their owners — none of these files are story files): the `engine/lua` + `runtime/assembly` + `sync/modules` mid-refactor tsc errors (`LuaHost.dispose`, `ModuleSyncOptions.hostFactory`, `EngineInfoOptions`/`EngineDownloadOptions` `exactOptionalPropertyTypes` — 64 errors total incl. `runtime.test.ts`, `auth-token.test.ts`, `favorites-batch-transfer.test.ts`).
