# Evidence — Favorites full lifecycle (FMD2 favorites-tab parity)

**Task**: tsk-lean-spangle-triumphs — create-from-UI, columns, check-all + new-chapter batch decision, enable/disable, import & transfer.
**Date**: 2026-11-17
**Epic**: v0.3.0 — Full-UX parity ([favorites-parity] row of docs/UX-PARITY.md §C)

## What shipped

### Server (additive API — every gap the LLD listed)

- **Columns parity**: `favorite` rows gain `save_to` / `enabled` / `date_added` (idempotent `ALTER TABLE` migration in
  `ensureLibrarySchema`, server/src/jobs/library/store.ts) and the `Favorite` wire projection carries `saveTo` / `enabled` /
  `dateAdded` (server/src/api/schemas.ts). Website resolves client-side through the `/api/modules` join (no server coupling).
- **Batch check**: `POST /api/favorites/check` `{scope: all|enabled|disabled}` → sequential DoCheck cycles with per-row
  results (`favorite`/`status`/`newChapters`/`queuedDownloads`/`error`) + `POST /api/favorites/check/cancel` (stop between
  rows; the response reports `cancelled`). Second concurrent batch = typed 409. (server/src/api/app.ts, services.ts,
  runtime/favorites-service.ts)
- **Transfer**: `POST /api/favorites/:id/transfer/preview` (catalog title match → exact case-insensitive hit → GetInfo
  dry-run; reasons `no-catalog|not-found|get-info-failed`) and `POST /api/favorites/:id/transfer` (validates via the same
  preview — invalid targets are a typed 409; remaps onto the target module+link under a new id, keeps
  title/status/currentChapter/saveTo/enabled/dateAdded, optional `clearDownloadedList` runs the tag-100 re-ingest).
  Engine: `FavoritesEngine.transferFavorite` (server/src/jobs/favorites/engine.ts).
- **Row patch**: `PUT /api/favorites/:id` now carries `saveTo` + `enabled` alongside `title`/`autoDownload` (the empty-patch
  400 guard knows all four).
- **Scheduler settings**: `GET /api/settings` carries `favorites: {intervalMinutes, checkAtStartup}`;
  `PUT /api/settings/favorites` applies the interval LIVE (`FavoriteScheduler.setDefaultIntervalMs` — idle favorites re-arm;
  0 = off clears every pending wake) and persists to app.db (`app_settings` kv, new table) so the startup toggle gates the
  next boot's sweep (assembly reads the seed before `scheduler.start()`). Disabled favorites are excluded from the
  scheduler's list (never auto-checked; manual check-now still works).
- **OpenAPI**: 5 new operations + schema extensions; snapshot regenerated (`npm run api:snapshot`),
  `openapi.test.ts` green, web client regenerated (`npm run gen:api -w @fmd/web`).

### Web

- **FavoritesPage** (web/src/pages/FavoritesPage.tsx): toolbar (Check for new chapters → scope menu
  All/Enabled/Disabled + Stop check while running + Import list), FMD2 column grid
  (`FavoritesColumns.tsx`: # / Title / Current chapter / Website / Save to / Date added / Last checked / Last updated —
  responsive secondary line on narrow), per-row Check now (kept), auto-download toggle (kept), and the row overflow menu
  (pmFavorites parity): View manga info / Download all new / Rename (inline) / Transfer website / Change save-to /
  Enable-Disable / Delete (confirm dialog — the visible Remove button routes there too).
- **NewChaptersSheet** (web/src/components/favorites/NewChaptersSheet.tsx): the frmNewChapter ADAPT — ONE sheet after any
  check with results; per-row + global Download / Add-to-queue / Dismiss; auto-download rows render pre-queued
  (`auto-queued (auto-download)` badge, actions disabled); "Add to queue" creates PAUSED jobs (cbAddAsStopped parity);
  Download dedupes through `idempotencyKey: fav:<id>:<link>`. Decision state machine
  (`useNewChapterDecisions`) is unit-tested standalone.
- **TransferDialog** (components/favorites/TransferDialog.tsx): target-site picker, valid/invalid mapping preview
  (`transfer-preview-valid|invalid` + reason), clear-downloaded-and-reload checkbox, apply.
- **ImportFavoritesDialog** (components/favorites/ImportFavoritesDialog.tsx): the frmImportFavorites ADAPT — JSON list
  (FMD2 db field names `moduleid|website|link|title` or fmd-web names), website-name resolution against `/api/modules`,
  per-row round-trip of the EXISTING `POST /api/favorites/import` (tag-100: imported marked fully downloaded), result
  report (imported/failed/pending per row + summary).
- **Settings** (components/FavoritesSettingsForm.tsx): check interval (minutes, 0 = off) + check-at-startup toggle →
  `PUT /api/settings/favorites`.
- Create-from-UI lives on the manga page + browse rows (the [manga-page-parity]/[browse-list-polish] interplay stories);
  this story's e2e drives the manga-page create as the entry point.

## Evidence

| Claim | Proof (re-run 2026-11-17) |
|---|---|
| Batch check scope matrix + cancel | `npx vitest run server/test/api/favorites-batch-transfer.test.ts` (re-run 2026-11-17 11:01) — 21 passed (scope all/enabled/disabled, cancel mid-run via gated service, typed 400/409, per-row new-chapter sets) |
| Transfer incl. invalid-target report | favorites-batch-transfer.test.ts (21 above) — preview valid + `not-found` AND the full miss taxonomy `no-catalog`/`get-info-failed` through the route (double's transferIndex extended to reason-bearing misses), apply remap (new id, old key gone), invalid apply = 409 envelope (taxonomy targets too), clearDownloadedList reload; the REAL engine taxonomy (`server/test/jobs/favorites/service.test.ts`:252) covers no-catalog/get-info-failed against the production store |
| Production transfer + batch on the REAL engine/store | `npx vitest run server/test/jobs/favorites/service.test.ts` — 13 passed (6 new: preview reasons, field carry-over, tag-100 reload, scope matrix + failed-row sweep, concurrent 409) |
| Scheduler runtime interval | `npx vitest run server/test/jobs/favorites/scheduler.test.ts` — 9 passed (2 new: shorter interval re-arms due-now, interval 0 clears wakes) |
| rename/saveTo/enabled persistence + DELETE | favorites-batch-transfer.test.ts (`PUT /api/favorites/:id` block incl. the empty-patch 400; `DELETE /api/favorites/:id` block: 200 {ok:true}, listing drops the row, repeat/unknown delete = typed 404 `not_found`) + service.test.ts (field carry-over through the real store) |
| Settings surface | favorites-batch-transfer.test.ts (`PUT /api/settings/favorites` block) — round-trip through GET, 0 legal, negative 400 |
| Store migration + server favorites gate | `npx vitest run server/test/api/favorites-batch-transfer.test.ts server/test/jobs/favorites` (re-run 2026-11-17 11:01) — 5 files / 61 tests passed (library store round-trips the new columns; ALTERs idempotent). The WIDER `server/test` tree currently carries 10 failed files / 34 failed tests — ALL in the parallel in-flight engine/module-sync refactor (hostFactory now required by `ModuleSyncOptions`, `LuaHost.dispose` removed: runtime/drain, runtime.test, sync/modules/*, accounts/account-login-engine) with zero favorites-file intersections; same shared-workspace pattern as the web note in Known scope |
| Sheet decision state | `npx vitest run web/test/new-chapters-sheet.test.tsx` — 4 passed (auto rows pre-decided, decide/decideAll only-pending, reset on new rows) |
| Page surface (columns, toolbar, sheet, menus, import) | `npx vitest run web/test/favorites-page.test.tsx` — 17 passed |
| End-to-end on mock | `npx playwright test e2e/favorites-parity.spec.ts` (in web/) — 2 passed: create-from-manga-page → columns → check scope → sheet → Download all → downloads page lists the two created jobs; auto row pre-queued, 0 pending decisions |
| Import round-trips existing endpoint | favorites-page.test.ts import suite (1 ok + 1 failed row report; only the resolvable entry POSTs `/api/favorites/import`) |
| Types/lint/contract (re-run 2026-11-17 11:01) | `npx eslint` on every favorites-touched file (pages, components/favorites/*, tests, e2e, api app/services/schemas, runtime/favorites-service, jobs/favorites, jobs/library/store) — 0 problems, exit 0. `npx tsc -b --pretty false 2>&1 | grep -E 'favorites|api/services'` — ZERO hits (no favorites-touched file has a type error; the test file's earlier indexed-access/override strictness errors were fixed in this pass). `npm run contract:check` — OK, 0 mismatches. The full `tsc -b` still fails ONLY inside the same parallel engine refactor (module-sync.ts TS2741 hostFactory, directory-walk/account-login TS2339 LuaHost.dispose, assembly TS6133/TS2345 Lua wiring, tools/smoke TS2322 FacadeBridge) — favorites files typecheck through the same projects once that story lands its refactor |

## Known scope

- FMD2's SQLite `favorites.db` FILE import (FMD1/FMD2/Domdomsoft binary formats) is ADAPTED to a JSON list with the same
  field names — browsers cannot read SQLite client-side; a server-side file parser is a v0.4 candidate if the binary
  format matters.
- Transfer operates on ONE favorite (the row-menu entry); FMD2's batch transfer-all dialog is a v0.4 candidate once
  multi-select lands.
- "Download all new" on a row runs check-now then enqueues (no auto-download double-enqueue: rows the check already
  queued are skipped).
- Pre-existing failures in `web/test/settings-bootstrap.test.tsx` / `web/test/browse-list-polish.test.tsx` belong to the
  parallel in-flight settings/browse story (verified identical with my changes disabled).
- The full-tree `tsc -b` + `server/test` failures current at this writing (10 files / 34 tests, all engine/module-sync:
  `ModuleSyncOptions.hostFactory` now required, `LuaHost.dispose` removed, `FacadeBridge` reworked) belong to the parallel
  in-flight engine refactor in this SHARED uncommitted workspace — every favorites-scoped gate above is green and no
  favorites-touched file appears in the type-error list. Re-run the favorites commands if the tree moves again.
