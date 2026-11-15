# Evidence — tsk-native-kitchen-loses (Favorites engine: DoCheck parity, scheduler, UI wiring)

Date: 2026-11-14T23:30Z (review-fix rev 2: 2026-11-15T00:10Z) · Environment: node v24, vitest 3.2.7, better-sqlite3 12 — offline (§13 no-network guard active for every test)

## Review-fix rev 2 (bounce findings, both addressed)

- **Blocker** (`web/test/fixtures.ts`): the restored file's import line
  differed from the one my append script anchored on, so
  `favoriteFixture` landed WITHOUT its `FavoriteT` import → 2× TS2304
  under `npx tsc -b tsconfig.json`. Fixed: `FavoriteT` imported from
  `../src/api/hooks`; the full workspace typecheck now shows ZERO
  favorites-scoped errors (the only remaining errors are the
  reviewer-noted out-of-scope WIP: `web/e2e/download-flow.spec.ts`,
  `server/src/engine/sidecar/bypass-adapter.ts`).
- **Minor** (`web/test/favorites-page.test.tsx`): the two-row badge
  test shared the default fixture id → React duplicate-key warning.
  Fixed: distinct `id` overrides per row.

Re-verified after the fixes: favorites suites green (6 files /
50 passed), eslint clean on both touched files.

## Scope

`server/src/jobs/favorites/` — the §7.2/D8 favorites engine with
**`uFavoritesManager.TFavoriteThread.DoCheck` parity (NOT uUpdateThread)**:

- `diff.ts` — the new-chapter set-difference over the stored
  `DownloadedChapterList` with case-insensitive `IndexOf` membership
  (uFavoritesManager.pas:364-370): positions ascend, live order preserved.
- `do-check.ts` — the pure DoCheck outcome: immediate
  `CurrentChapter = ChapterLinks.Count` + `Status` update (:346-348),
  the tag-100 transfer-favorite branch (:356-361 — every live chapter
  becomes the favorite's stored list, tag reset, no diff),
  `DateLastChecked` always / `DateLastUpdated` only on new chapters
  (:376-380), and the keep-live-info rule (:384-389).
- `engine.ts` — the orchestration: live `GetInfoFromURL` (§5
  `InfoService`, §5.8-normalized) → immediate favorite persist → diff →
  auto-download enqueues through the Phase-3 pipeline (each payload
  carries the favorite `mangaKey`) → the `:1131-1133` DUAL-WRITE merge
  into BOTH the favorite's stored list (`MergeCaseInsensitive`) and the
  global `downloaded_chapters` (`SetChapters` semantics: new row as-is,
  existing row merges, `''` no-op). `createFavorite` = FMD2 `Add`
  parity (no live fetch, empty list → first check reports all new);
  `importFavorite` = the D4 tag-100 transfer-favorite bulk-ingest path
  (D15 `DoCheckMissing` out of scope).
- `scheduler.ts` — `OptionMaxFavoriteThreads` (default 1, FMDOptions
  .pas:130) bounded concurrency, per-favorite interval
  (`OptionAutoCheckFavIntervalMinutes` = 60 min default, FMDOptions
  .pas:153-154), deterministic jitter in `[I, I+J)`, injected
  `FavoriteClock` (`now()/delay()` — same shape as the §6.1 SyncClock)
  for FakeClock tests, completion-driven re-dispatch (a slow check
  blocks only its slot), failure-tolerant loop, rescan for
  create/delete, check-now-only favorites (`intervalMs <= 0`).

Wiring: `library/store.ts` favorite rows gained `auto_download`,
`new_chapter_count`, `last_updated` + `getFavorite`/`listFavorites`;
`queue/payloads.ts` download jobs + `runtime/download-lane.ts` carry
`mangaKey` so per-chapter completion dual-writes the favorite ledger;
`runtime/assembly.ts` builds engine + `SqliteFavoritesService` +
scheduler (env knobs `FMD_FAVORITE_THREADS/_INTERVAL_MS/_JITTER_MS`)
with dispose-drain.

API (§10, typed): `GET/POST /api/favorites`,
`GET/PUT/DELETE /api/favorites/{id}`, `POST /api/favorites/{id}/check`
(manual check-now → one DoCheck cycle), `POST /api/favorites/import`
(D4). Zod schemas in `api/schemas.ts` (`FavoriteSchema` + requests +
check response), the `FavoriteService` port in `api/services.ts`
(in-memory double for route tests), routes + inventory (`routes.ts`)
+ OpenAPI operations, snapshot regenerated (`openapi.snapshot.json`),
web client regenerated (`web/src/api/openapi.d.ts`). Contract gained
`'DELETE'` in `ApiMethod`.

Web (§11): favorites hooks (`useFavorites`, create/import/update/
delete/check-now), `pages/FavoritesPage.tsx` — new-chapter badge
(`new-chapter-badge`, hidden at 0), auto-download toggle (PUT +
invalidate-refetch), check-now (POST + refetch), remove, explicit
empty state; router/nav entry.

## Acceptance criteria → evidence

All favorites suites green:
`npx vitest run server/test/jobs/favorites server/test/api/favorites.test.ts web/test/favorites-page.test.tsx`
→ **6 files, 50 passed (50)**.

1. **Golden diff tests (fixtures committed)** —
   `server/test/jobs/favorites/golden-diff.test.ts` (6 tests): every
   corpus `getinfo-normalization-*.triples.json` batch replayed —
   `normalizeMangaInfo` (§5.8) → diff → expected set (odd/even
   suffix positions + link order), case-mangled stored lists hide their
   chapters (ASCII case-flip ≠ SameText-equal), mid-download
   dual-written chapter not re-detected, empty stored list → all new,
   and the normalization→diff→dual-write→re-diff convergence sweep.
   Engine tests (`engine.test.ts`, 12): immediate CurrentChapter/Status
   persist BEFORE download steps, case-variant membership, auto-download
   enqueue + dual-write assertions on BOTH rows, mid-download parity,
   tag-100 import (global row untouched), create = no fetch, empty-link
   skip (:332-334), GetInfo failure leaves the row untouched, queue
   payload schema round-trip incl. `mangaKey`.
2. **Scheduler (fake clock)** — `scheduler.test.ts` (7 tests): at most
   `maxConcurrent` in flight (FMD2 default 1 pinned), freed slots serve
   the next due favorite (slow favorite starves nobody), next due in
   `[interval, interval+jitter)` with a deterministic jitter source,
   per-favorite override + `interval <= 0` never auto-runs, failing
   check feeds `onError` without breaking the loop, post-start rescan,
   `drain()` settle. Two real scheduler bugs found + fixed by these
   tests: an interval-0 infinite rescan loop and duplicate armed timers.
3. **API integration** — `server/test/api/favorites.test.ts` (12):
   create 201/409/400, listing order, one + 404, PUT toggle
   (autoDownload true→false, empty patch 400), DELETE + repeat 404,
   check-now 200 (favorite + `queuedDownloads` + `newChapters` + badge
   persist) + 404, import 201. Production adapter
   `service.test.ts` (7): `SqliteFavoritesService` over the REAL
   engine + SQLite store — wire projection validating against
   `FavoriteSchema`, check-now, toggle→enqueue→dual-write, import,
   typed 404s, ledger survival on delete, 502 mapping of fetch
   failures at the route.
4. **UI component tests** — `web/test/favorites-page.test.tsx` (6):
   listing render, badge only when `newChapterCount > 0`, toggle PUT
   payload + refetch, check-now POST + badge update, remove → empty
   state, explicit empty list.

Gates: `npx tsc -b server/tsconfig.json` and `npx tsc -b
web/tsconfig.json` clean for every favorites file; `npx eslint` clean
on all touched files; OpenAPI snapshot test + web api-drift test green
(`server/test/api/openapi.test.ts`, `web/test/api-drift.test.ts`).

Known non-blocking: `server/test/engine/shims/http-proxy-routing
.integration.test.ts` (5 failures) belongs to the in-flight proxy
story — unrelated to favorites.

## Deviations

- Web `create` does not live-fetch (FMD2 `Add` parity: the row seeds
  from the caller's known state; the scheduler checks promptly). The
  first check stamps `currentChapter`/`status`/`lastCheck`.
- Web `autoDownload` is a per-favorite flag defaulting OFF (FMD2's
  global `OptionAutoCheckFavDownload = False`), settable at create and
  via the PUT toggle; the scheduler/engine read it per check.
- Dual-write timing follows `:1131-1133` (merge when the downloads are
  QUEUED), so re-detection is prevented immediately — the per-chapter
  pipeline completion (`mangaKey` provenance) additionally merges into
  the same case-insensitive sets, which is idempotent.
