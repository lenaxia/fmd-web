# Evidence — All-sites union search with Website badges (FMD2 cbSearchFromAllSites parity)

**Story:** tsk-ethereal-tiara-shines — All-sites union search (`GET /api/search` + `?allsites=1` UI)
**Date:** 2026-11-17 · **Stage:** in_progress → in_review

## Summary

FMD2's "search from all sites" checkbox (`cbSearchFromAllSites`) is ported: an **All sites** toggle in the search bar switches the open-site catalog view into a union view (`#/browse?allsites=1`) backed by a new **`GET /api/search`** that fans out FTS over every **INSTALLED** catalog of every enabled site (`Promise.allSettled`), merges by a documented deterministic comparator, paginates through a stable per-site-window cursor, and tags every row with its source **Website** (badge). Per-site counts surface as facet chips; a broken catalog is a **typed partial state** (warning chip naming the site — the rest of the union still returns); enabled sites without a catalog are **excluded and explained** (no-catalog chip). Installed-only, exactly like FMD2's local-DB union — never live scraping.

## Ground truth (FMD2 sources)

| Behavior | FMD2 source | Web implementation |
|---|---|---|
| All-sites toggle | `cbSearchFromAllSites: TCheckBox` (frmMain.pas:335); checked → `dataProcess.FilterAllSites := True` and `SitesList.Assign(cbSelectManga.Items)` — EVERY enabled site (frmMain.pas:3411-3416) | `AllSitesToggle` beside the SearchBar; on → `#/browse?allsites=1` carrying the typed `q`; participation = enabled modules with an installed catalog (`CatalogStore.getMeta` receipt) |
| Union = LOCAL catalog union, not live scraping | the filter iterates SitesList over the installed local DBs (`DBDataProcess.Filter`); sites without a DB are simply absent | `UnionSearchService` fans out over `CatalogStore.search` only — the §6.8 live fallback is deliberately NOT in the union; catalog-less enabled sites surface in `excluded[]` (`reason: 'no-catalog'`) so the UI chip explains why |
| Result rows carry the source Website | `vtMangaListGetHint` prepends `RS_InfoWebsite + LineEnding + TModuleContainer(Module).Name` when `FilterAllSites` (frmMain.pas:5170) | every response row carries `site` + `siteName`; the UI renders a `WebsiteBadge` (site name via the `/api/modules` join — never a hex id) |
| Clicking a row opens that site's manga | node data carries the module; the manga form resolves in that site's context | row click → `#/manga?catalog=<site>&module=<site>&url=<link>&title=…` — the unchanged deep-link shape |

## The API

`GET /api/search?q=&status=&genres=&genresMode=&cursor=&limit=` (+ `authors=`, `newDays=` — the same filter vocabulary as the per-site search; `q` optional when a filter is set; comma- or repeated-param `genres` normalized at the boundary).

Response (zod source of truth `server/src/api/schemas.ts`, OpenAPI operation `allSitesSearch`):

```jsonc
{
  "entries":  [ { …CatalogEntry, "site": "<32hex>", "siteName": "MangaDex" } ],
  "nextCursor": "…",          // absent on the last page
  "facets":   [ { "siteId": "…", "siteName": "…", "count": 123 } ],  // sites that answered
  "warnings": [ { "siteId": "…", "siteName": "…", "error": "file is not a database" } ],
  "excluded": [ { "siteId": "…", "siteName": "…", "reason": "no-catalog" } ]
}
```

## Documented decisions

1. **Windowed k-way merge, K = 2×limit** (HLD): each site is read through the store's PUBLIC page semantics (`{ page: 1 + floor(offset/K), limit: K }`, sliced past the consumed prefix) — no coupling to the store's private cursor encoding. Catalogs are read-only after install (§6.4 invariant), so per-site orderings are stable across pages.
2. **Union cursor** = base64url `{ v: 1, k, s }`: `k` binds the FULL issued filter state (reuse against a different filter → typed 400, same class as the per-store cursors); `s` is the per-site **consumed-row count** as site-id-sorted pairs — canonical bytes under any permutation of the site set. `limit` is deliberately NOT bound: consumed counts are page-size-independent, so a client may change `limit` between pages without invalidating its position.
3. **Merge comparator — documented total order** (`normalized title`, `site id`, `link`; `server/src/api/search-service.ts`): normalizing is trim + lowercase + whitespace-collapse. The comparator orders every page's merged pool, and both the output and the cursor bytes are **identical under any permutation of the site set** (property test, 25 seeded permutations over registration AND install order).
4. **Cross-page global order is a documented best-effort** (honest divergence from a naive "globally sorted" reading of the HLD): per-site stores serve rows in their OWN order (FTS rank / jdn DESC / title — store-specific), which cannot be assumed to agree with the union comparator, so a row deep in one site's window may comparator-sort before a row an earlier page emitted from another site. What IS guaranteed (and pinned by tests): **completeness** (every matching row appears exactly once across the walk — no losses, no duplicates across window boundaries), **per-page comparator order**, and **determinism** (the whole stream is a pure function of the per-site offsets). FMD2's own all-sites list is site-APPENDED — the web union is strictly more ordered than the parity target.
5. **Partial failure is typed, never silent, never full failure**: every window round runs `Promise.allSettled`; a rejected site becomes a `SiteSearchFailure` row (`warnings[]`) and its lane drops — the remaining sites still fill the page. The warning persists on every subsequent page (each request's fan-out retries the broken site naturally). Facets only list sites that ANSWERED (a count a broken site could not report would be a lie). HTTP status stays 200 even if every site fails (the request itself succeeded; the UI shows the warning chips).
6. **Participation / exclusion**: enabled + installed → in the union; enabled + catalog-less → `excluded[]` with `reason: 'no-catalog'` (the UI chip explains installed-only semantics); disabled sites are invisible (FMD2 parity — `cbSelectManga` lists enabled sites only). Zero installed catalogs → 200, empty entries, excluded chips.
7. **Facet chips route site-scoped**: clicking a chip navigates to `#/browse?site=<id>&q=<current q>` — the union's per-site drill-down. The **All sites** toggle off returns to the site picker.
8. **URL semantics** match the site view: typing REPLACES history (`replaceRoute` — shareable, no keystroke spam); the toggle PUSHES (back/forward correct).
9. **Radix toggle in e2e**: `click()`, not `check()` — the control navigates immediately and detaches before `check()` could re-assert its state.

## Files changed (key)

- **Server:** `server/src/api/search-service.ts` (NEW — `UnionSearchService`, comparator, union cursor, typed `SiteSearchFailure`), `server/src/api/schemas.ts` (`AllSitesSearchQuery/Response`, `SearchEntry`, `SearchFacet`, `SiteSearchFailure`, `ExcludedSite`), `server/src/api/app.ts` (`GET /api/search` wiring), `server/src/api/routes.ts` (inventory), `server/src/api/openapi.ts` (operation `allSitesSearch`), `server/src/api/openapi.snapshot.json` (regenerated, snapshot test green).
- **Server tests:** `server/test/api/search-all-sites.test.ts` (7: merge order, site tiebreak, window-boundary walk, empty-q, cursor binding, filter passthrough, 25-permutation property), `server/test/api/search-all-sites-partial.test.ts` (2: corrupted-catalog fixture over the REAL `CatalogFileStore`, pagination across the corrupted site), `server/test/api/helpers.ts` (`InMemoryCatalogStore.search` gains real-store `page` parity — the union reads windows through it).
- **Web:** `web/src/api/openapi.d.ts` (regenerated client), `web/src/api/hooks.ts` (`useAllSitesSearch` infinite query), `web/src/pages/AllSitesSearchPage.tsx` (NEW), `web/src/pages/BrowsePage.tsx` (`?allsites=1` delegation + toggle in the site FilterBar), `web/src/components/catalog/WebsiteBadge.tsx`, `AllSitesToggle.tsx`, `UnionSearchChips.tsx` (NEW — facets/warnings/excluded chips).
- **Web tests:** `web/test/all-sites-search.test.tsx` (5), `web/e2e/all-sites-search.spec.ts` (Playwright, 2 installed mock catalogs + 1 failing + 1 catalog-less).

## Acceptance criteria → evidence

1. **GET /api/search fans out over installed catalogs; merge order deterministic under site permutation (property test); cursor pagination stable across window boundaries**
   → `server/test/api/search-all-sites.test.ts`: fan-out over 2 installed catalogs (disabled + catalog-less sites correctly handled); *PROPERTY* — 25 seeded LCG permutations of registry order AND store install order produce byte-identical entries, cursor and facets; *window walk* — `limit=2` (K=4) pages through 9 rows in 5 pages, per-page comparator-ordered, complete and duplicate-free across the K boundary, disabled site's rows never appear.
2. **Partial failure returns others' results + typed warning naming failed sites (integration test with a corrupted catalog fixture)**
   → `server/test/api/search-all-sites-partial.test.ts`: REAL `CatalogFileStore`, two real FMD2-DB-schema catalogs (`createCatalogDb`) + one garbage-bytes `catalogs/<id>.db` with a valid install receipt (getMeta self-heals → "installed"); `/api/search` answers **200** with both good sites' merged results + `warnings: [{ siteId, siteName: "Corrupt Site", error: "file is not a database" }]`; the cursor walk completes over the healthy union with the warning on EVERY page.
3. **UI: All-sites toggle + Website badge per row + per-site count chips; row click routes to the correct site context; installed-only semantics explained in the UI (chip on catalog-less sites)**
   → `web/test/all-sites-search.test.tsx` (5 tests): toggle routes `browse?site=&q=` → `browse?allsites=1&q=`; merged rows from both sites each carry `WebsiteBadge`; facet chips show site names + counts; the failed site's warning chip names it; the catalog-less chip explains "no catalog installed"; a row click lands on `#/manga?catalog=<siteB>&module=<siteB>&url=…`; a facet chip routes `#/browse?site=<siteB>&q=union`; toggle off → picker; typing REPLACES the URL.
4. **Playwright: all-sites search across ≥2 installed mock catalogs returns merged, badged, correctly-routed results**
   → `web/e2e/all-sites-search.spec.ts` (real Vite dev server, network-edge mock API): 2 installed mock catalogs (+1 failing, +1 catalog-less); the toggle switches to the union; `q=quest` renders merged rows from BOTH catalogs with `Website: FixtureSite` / `Website: BetaSite` badges (≥2 BetaSite badges for its two rows); facet chips with counts; `DeltaBroken didn't answer` warning chip; `GammaNoCatalog: no catalog installed` chip; the BetaSite row click routes to `#/manga?…module=<BetaSite id>`; the facet chip routes to `#/browse?…site=<BetaSite id>&q=quest`. **1/1 passed** (and the full vite e2e suite: **16/16 passed**).

## Gates run

- `npm run lint` — clean · `npm run typecheck` — clean
- `npm test` — **172 files, 1747 passed / 3 skipped** (includes the 9 new server tests + 5 new web tests + the OpenAPI snapshot drift test against the regenerated snapshot)
- `bash scripts/design-gate.sh` — OK (tokens-only styling)
- `npm run corpus` — **912/912 = 100%**, gate passed, `docs/COMPAT.md` + `docs/corpus-report.json` byte-stable (this story touches no engine/lua code)
- `npm run e2e -w @fmd/web` — **16/16 passed** (smoke + a11y + perf + search incl. the new spec)
- `bash scripts/e2e.sh` (phase-2 process twin) — **blocked by a PRE-EXISTING mid-flight inconsistency owned by the parallel db-url story**: `scripts/compose-check.sh` (uncommitted diff, expects `FMD_DB_URL=…/FMD2-DB/master`) vs the compose file still carrying `…/FMD2-DB/db`. None of this story's files are involved; verified via `git diff scripts/compose-check.sh`.

## FMD2 cross-reference pin

`/workspace/FMD2/mangadownloader/forms/frmMain.pas:3411-3416` (`FilterAllSites := cbSearchFromAllSites.Checked; … SitesList.Assign(cbSelectManga.Items)`) and `:5170` (`if dataProcess.FilterAllSites then HintText += RS_InfoWebsite + LineEnding + TModuleContainer(Module).Name`) — quoted verbatim in `server/src/api/search-service.ts` and `WebsiteBadge.tsx` headers.
