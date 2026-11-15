# Evidence — Live-Scrape Catalog Fallback (§6.8, tsk-novel-carousel-supports)

Audit bucket B closure: browse endpoints (`server/src/api/routes.ts:16-18`)
were catalog-only while DESIGN §6 item 8 promises a live-scrape path for
enabled modules without an FMD2-DB catalog — those sites were
**un-browsable** rather than degraded. This story ships the §6.8 fallback.

## What landed

### Boundary contract (`contract/types.ts`)

- `CatalogSource = 'catalog' | 'live'` — the §6.8 discriminator.
- `CatalogFallbackStore` — the fallback read side (`supports`, `latest`,
  `byTitle`, `search`, `invalidate`), same page shapes as `CatalogStore`,
  async (each call may drive a module-engine walk).
- `CatalogFallbackError` with typed kinds: `fallback_unavailable` → 404,
  `walk_failed` → 502, `lane_closed` → 503.
- `UpdateLaneGate` — the §4 slot port (scrapes run on the update lane's
  budget, never the download lane's).

### Capability flag (`server/src/engine/registry/capabilities.ts`)

`ModuleCapabilities.live_scrape_fallback` = the module declares BOTH
directory events (`OnGetDirectoryPageNumber` + `OnGetNameAndLink`,
§5.1). Published via `GET /api/modules` (`ModuleCapabilitiesSchema` in
`server/src/api/schemas.ts`; projected in `toSummary`).

### Directory walk (`server/src/catalog/directory-walk.ts`)

`EngineDirectoryWalker` — one wasmoon engine per walk (the
`EngineInfoService` model), real module file, §5.4 shims (egress,
per-host `SyncHostGate`, proxy, sidecar bypass):

1. `GetDirectoryPageNumber` with the §5.2 PAGENUMBER read-back (in →
   read back, the ONLY such global). Failed/net_problem → typed
   `walk_failed`. Divergence (documented, deliberate): FMD2's update
   thread logs-and-continues with 1 page (`uUpdateThread.pas:198`);
   the fallback REFUSES instead — a browse response must never be a
   silently truncated directory. A page count over
   `MAX_DIRECTORY_PAGES` (10 000) is `walk_failed`, not a crawl.
2. `GetNameAndLink` per page, `URL` = 0-based page index (modules do
   `URL + 1` against their pagination template — uUpdateThread loop
   parity). NAMES/LINKS are read back host-side via `runLua` (the same
   reads the e2e golden harness uses). ANY page failure discards the
   whole walk → `walk_failed`, **never a partial page**.
3. §5.8 post-processing via `normalizeMangaInfo`
   (`engine/normalize/udata.ts` — REUSED, not duplicated): title
   cleanup chain + the link fallback from URL (`removeHostFromURL`,
   uData.pas:111-113 — the same host-strip uUpdateThread.pas:236-239
   applies to scraped links). Link-less entries dropped
   (RemoveHostFromURLsPair :983 parity). `numChapter`/`jdn` are 0
   (directory snapshots carry no chapter/jdn data).

### Fallback store (`server/src/catalog/live-scrape-store.ts`)

`LiveScrapeCatalogStore implements CatalogFallbackStore`:

- **TTL cache per module** (default 6 h = `DEFAULT_LIVE_SCRAPE_TTL_MS`,
  configurable via `FMD_CATALOG_LIVE_TTL_MS`; constructor override for
  tests) with **per-module single-flight** (concurrent cold requests
  share ONE walk; waiters double-check the cache under the slot they
  finally get).
- `latest` keeps walk order (site directories are newest-first);
  `title` sorts NOCASE + link tiebreak (same ordering as §6.6).
- `search` = in-memory LIKE index over the snapshot (q terms ANDed
  across title/alttitles/summary, exact `status`, substring `genre`) —
  the §10 search params; cursor pagination with the catalog
  endpoints' scheme (opaque base64url JSON `{q, o, g?, s?}`,
  query-bound, reuse mismatch → 400 class).
- `invalidate(id)` — called by the assembly when a catalog sync lands
  (`state === 'updated'`); the routes ALSO re-check
  `CatalogStore.getMeta` on every request, so the live→catalog switch
  is immediate even without the hook.

### Routes (`server/src/api/app.ts`)

`resolveCatalogPage` — lookup order: installed catalog first
(`source: 'catalog'`), fallback second (`source: 'live'`), typed 404
envelope otherwise (message names the §6.8 requirement). Error mapping:
`walk_failed` → 502 upstream_error, `lane_closed` → 503, cursor
complaints → 400 — identical mapping class for both channels. Every
response carries the `source` discriminator
(`CatalogPageResponseSchema.source`, required).

### Runtime wiring (`server/src/runtime/assembly.ts`)

- `EngineDirectoryWalker` over the run transport/egress + a dedicated
  `SyncHostGate` (`FMD_CATALOG_LIVE_HOST_LIMIT`, default 4) — per-host
  connection limits + start-interval delays apply to every scrape page
  fetch.
- `UpdateLaneScrapeGate` (`server/src/catalog/update-lane-gate.ts`,
  `FMD_CATALOG_LIVE_CONCURRENCY`, default 2) — FIFO semaphore, direct
  hand-off release (PerHostSiteLimiter release shape), `close()` fails
  queued waiters fast (§4).
- Catalog arrival (`syncCatalog`/`syncAllCatalogs` → `updated`) calls
  `catalogFallback.invalidate(id)`.

### UI

- `web/src/components/CapabilityBadges.tsx` — "live-scrape browse"
  capability badge per module.
- `web/src/pages/BrowsePage.tsx` — "live scrape" badge next to the
  catalog header when the served page's `source` is `live`.

## Acceptance criteria → evidence

### 1. Catalog-less module: browse+search live through the module API with §5.8 normalization

- `server/test/catalog/directory-walk.test.ts` — the REAL Hentai2Read
  module file (both directory events bound, `modules/Hentai2Read.lua`)
  driven offline over recorded `script[data-page="app"]` directory
  pages: page count read-back drives 2 pages → 3 page fetches
  (`page-1` by BOTH events, `page-2` once) → §5.8-normalized entries
  asserted **not raw module output**:
  `https://hentai2read.com/manga/Alpha_Manga/` → `/manga/Alpha_Manga/`
  (host stripped), `  Alpha Manga  ` → `Alpha Manga` (trim chain),
  `Beta &amp; Tales` → `Beta & Tales` (CommonStringFilter).
- `server/test/catalog/live-scrape-store.test.ts`
  (normalizeDirectoryEntries) — host-relative links pass through,
  link-less entries dropped, breaks removed, `numChapter`/`jdn` 0.
- `server/test/api/catalog-fallback.test.ts` — route serves
  `source: 'live'` for the catalog-less capable module; `latest`,
  `title` (NOCASE order), page params, all from ONE walk (cache).

### 2. TTL cache + mid-flight catalog-arrival switch; cursor scheme identical

- TTL: one walk per window; expiry re-walks
  (live-scrape-store.test.ts, injected clock).
- Cursor stability within TTL: page1 cursor → clock +1 h → page2
  decodes against the SAME snapshot (walk count stays 1), page walk
  completes every match exactly once.
- Mid-flight arrival: live served (`source: 'live'`) → catalog
  installed + `invalidate` (exactly the assembly's sync hook) → next
  request `source: 'catalog'` with catalog rows.
- Scheme: live search cursors decode to base64url JSON `{q, o, g?, s?}`
  — the FTS store's scheme family; query/genre/status rebinding and
  garbage cursors → 400, same as §6.5. Browse pages emit `{o}` offset
  cursors like the ordered §6.6 pages.

### 3. source discriminator + capability flag + scrape isolation

- API: every catalog page response carries `source`; `GET /api/modules`
  carries `capabilities.live_scrape_fallback`
  (catalog-fallback.test.ts).
- UI: CapabilityBadges "live-scrape browse" badge (capability-badges
  tests, both render and no-invention directions); BrowsePage "live
  scrape" badge for `source: 'live'` pages and none for `catalog`
  (pagination.test.tsx).
- Isolation under concurrent load
  (`server/test/catalog/lane-isolation.test.ts`, deterministic event-
  loop polling, real SQLite queue + LaneRunner download lane):
  - scrape slot budget 1 + 3 cold scrapes → 1 walking, 2 FIFO-queued;
    3 download jobs enqueue and complete end-to-end WHILE all scrape
    work is parked (`completed.length === 3` with `gate.queued === 2`
    still standing) — download slots never touched by scrape
    saturation; slot hand-off FIFO proven (scrape 2 then 3 proceed on
    release); downloads never re-ordered or lost.
  - inverse: a parked (wedged) download handler does not block a fresh
    scrape — independent lane budgets by construction.
  - per-host limiter: directory-walk.test.ts wires a CountingGate over
    the REAL `SyncHostGate(limit 1)` — 3 page fetches → 3 gated
    acquisitions, `maxObserved === 1` (never over the host limit).

### 4. Module without directory events AND without catalog → typed envelope

- `catalog-fallback.test.ts` — capable=false module and a registry-
  unknown id both get `404 { error: { code: 'not_found', message:
  '…cannot serve a live directory walk…' } }`.
- walk failure → `502 upstream_error` envelope; no entries field ever
  (unit: `walk_failed` also leaves the previous cache entry untouched;
  engine: net_problem on page 2 discards the whole walk).

## Test run (offline; recorded fixtures only)

```
npx vitest run server/test/catalog server/test/api/catalog-fallback.test.ts
  → 4 files, 25 tests, all green
npx vitest run server/test
  → 121/123 files green; the 7 failures are gzip-shim.test.ts /
    pcre2-shim.test.ts — pre-existing breakage from the in-flight
    pcre2/gzip story (TS errors in those files predate this task's
    first change; untouched here).
npx vitest run web/test
  → 11/12 files green; downloads-feed.test.tsx fails against a
    DownloadsPage edit landed mid-flight by the parallel jobs story
    (page rewritten 10:23 today, its test not yet updated) — outside
    this task's surface.
npx tsc -b tsconfig.json
  → clean for every file this task touched; remaining errors confined
    to the same pre-existing gzip/pcre2/accounts files.
npx eslint <all files this task touched> → clean.
```

## Deliberate divergences (documented)

1. `GetDirectoryPageNumber` failure: typed `walk_failed` instead of
   FMD2's log-and-continue with 1 page — "never a partial page" wins
   over truncation-parity for a browse surface.
2. Page-count ceiling (10 000): refuse rather than crawl.
3. Live `latest` ordering = walk order (site newest-first), not `jdn`
   (directory snapshots carry no dates); live search is title-ordered
   (no FTS rank exists in memory).

## Out-of-scope, completed en passant

`PUT /api/modules/:id` silently dropped `patch.proxy` (accepted in the
schema, never passed to `ModuleService.update`) — the proxy story's own
test (`settings.test.ts`, per-module override) demanded the pass-through;
one line added (`server/src/api/app.ts`). No other behavior touched.
