# Evidence — Live search + FMD2 filter panel over the open catalog

**Story:** tsk-savvy-jockey-ambles — Live search + FMD2 filter panel (genres/status/authors, any/all, URL-synced)
**Date:** 2026-11-16 · **Stage:** in_progress → in_review

## Summary

FMD2's desktop behaviors `edMangaListSearch` (as-you-type live search, `TSearchDBThread` frmMain.pas:1114) and the Filter panel (frmMain.pas:3400, SQL via `DBDataProcess.pas:1370-1445`) are ported to the web catalog view: a debounced live SearchBar with count/mode label (`lbMode` parity), a collapsible FilterBar (authors / status / genre multi-select with ANY-ALL / custom genres / only-new window / reset), fully URL-synced state (`?site=&q=&status=&genres=&mode=` + `authors=`, `cgenres=`, `new=`, `view=`), and an additive API extension (`authors`, `genres[]`, `genresMode=any|all`, `newDays`, `q` optional when a filter is set) with regenerated OpenAPI snapshot + typed client.

## Ground truth (FMD2 sources)

| Behavior | FMD2 source | Web implementation |
|---|---|---|
| Live search worker coalescing | `TSearchDBThread.Execute` — pending string re-read, latest wins (frmMain.pas:1114-1141) | `useDebouncedValue` 250ms trailing (`web/src/state/use-catalog-query.ts`) |
| Anti-spam guards | unchanged text+site skip (`LastSearchStr`), programmatic-clear sentinel (frmMain.pas:6492+) | react-query key equality (no-op on unchanged state) + `cancelQueries` on every state change (in-flight abort) |
| Genre filter SQL | checked genres joined OR (`rbAny`) / AND (`rbAll`, default) of LIKE (DBDataProcess.pas:1416-1427) | `composeRowFilters` — ANY → `OR` of `LIKE ? ESCAPE '\'`, ALL → `AND` (`server/src/sync/db/catalog-store.ts`) |
| Authors filter | `AddSQLSimpleFilter('authors', …)` LIKE contains (DBDataProcess.pas:1394) | `e."authors" LIKE ? ESCAPE '\'` with `%…%` (contains) |
| Status filter | exact equality, index 4 `<none>` = no filter (DBDataProcess.pas:1404) | exact `e."status" = ?`; absent param = any (`FILTER_STATUSES` select) |
| Only-new window | `"jdn" > DateToJDN(Now) - minusDay` (DBDataProcess.pas:1382-1385) | `e."jdn" > jdnToday() - newDays` (UTC anchor; strict `>` boundary tested) |
| Custom genres | `edCustomGenres` comma-separated, `!`/`-` exclude (frmMain.pas:3371-3388) | free-text input → merged into `genres[]` API param; V1 keeps the include form (negation prefixes stripped, documented) |
| Genre checkbox list | `pnGenres` captions, `defaultGenres[0..37]` (uBaseUnit.pas:47) — **38 entries** | `FMD2_GENRES` — the same 38 genres, spelled as the `defaultGenres` ARRAY carries them (incl. `'Sci-fi'`, uBaseUnit.pas:54; the frmMain.lfm checkbox caption renders `Sci-Fi` — SQLite LIKE is ASCII case-insensitive, so both spellings match identically) |
| Mode label | `lbMode.Caption = RS_ModeAll/RS_ModeFiltered` with count | SearchBar status line: `All (N)` / `Filtered (N)` / `Latest` (aria-live) |
| Filter reset | `btFilterResetClick` restores defaults (frmMain.pas:3453) | Reset button → `EMPTY_FILTERS` (pushes URL) |

## Documented decisions

1. **Genre count — story says "39", FMD2 ships 38.** The canonical fixed checkbox list is `defaultGenres[0..37]` = **38** genres (uBaseUnit.pas:47; frmMain.lfm `pnGenres` renders exactly 38 captions 'Action'…'Webtoons'; the reset loop runs `for i := 0 to 37`). Parity wins: the web uses the actual 38. No computed facets (per the story's V1 decision — zero schema churn).
2. **`q` becomes optional when any filter is set** (FMD2 Filter panel filters with empty title text). With `q` absent the MATCH clause is skipped and the filtered `entry` table is served `ORDER BY jdn DESC` (latest parity). At least one of `q`/`status`/`authors`/`genres`/`newDays` is required (400 otherwise). Full FTS processing for `q` is unchanged.
3. **genres wire form:** repeated params (`?genres=A&genres=B` — the openapi-fetch array form) AND one comma-separated param (`?genres=A,B` — FMD2 custom-genre semantics) both normalize to the array at the route boundary (`normalizeGenresParam`).
4. **LIKE fast-path (`LIKE 'x%'`) is a documented non-goal:** FMD2 semantics are contains (`%x%`); a prefix-only LIKE would change semantics. SQLite can only use an index over a prefix LIKE — contains scans, which is acceptable over the read-only attached catalog/FTS sidecar (comment on `composeRowFilters`).
5. **URL semantics:** typing REPLACES history (`replaceRoute` — URL stays shareable, no keystroke spam); discrete filter applications, chips removal, reset, and tab switches PUSH (`navigate` — back/forward correct).
6. **OpenAPI generator hardening (root-caused during this story):** zod's `toJSONSchema` with `reused:'ref'` emits per-conversion `$defs` auto-names (`__schemaN`) that collided across operations (first-write-wins hoisting corrupted one of them, and query-param `$defs` were never hoisted at all). Fixed: per-operation def prefixes (`CatalogSearchQuery0`…) + query-param `$defs` hoisting + registry sibling-def preservation (`server/src/api/openapi.ts`).
7. **Only-new anchor is UTC today** (`jdnToday()`); FMD2 uses local `Now` — a server-side deterministic choice, documented.

## Files changed (key)

- **Contract/server:** `contract/types.ts` (CatalogSearchQuery extended), `server/src/api/schemas.ts` (zod schema + `normalizeGenresParam`), `server/src/api/app.ts` (route wiring), `server/src/api/openapi.ts` (generator fix), `server/src/api/openapi.snapshot.json` (regenerated), `server/src/sync/db/catalog-store.ts` (`composeRowFilters`, cursor binds FULL filter state, filter-only pages), `server/src/catalog/live-scrape-store.ts` (§6.8 parity semantics).
- **Web:** `web/src/api/openapi.d.ts` (regenerated client), `web/src/api/hooks.ts` (filters + AbortSignal pass-through), `web/src/state/browse-filter-state.ts` (state model + URL codec + 38-genre list), `web/src/state/use-catalog-query.ts` (debounce 250ms + in-flight cancel), `web/src/router.ts` (`replaceRoute`, `useRoute`), `web/src/pages/BrowsePage.tsx` (entries view = pure function of URL state), `web/src/components/catalog/{SearchBar,CatalogFilterPanel,AppliedFilterChips}.tsx`, `web/playwright.config.ts` (testMatch + search).

## Acceptance criteria → evidence

### 1. As-you-type search (250ms debounce, in-flight aborts) + count/mode label

- Unit: `web/test/use-catalog-query.test.ts` — "emits stable values only after the 250ms window" (keystroke coalescing), "one debounce window → exactly one emission", "superseded in-flight fetch is cancelled (abort fires + latest state wins)", "queryFn passes its AbortSignal to fetch (wiring)".
- Component: `web/test/browse-live-search.test.tsx` — "typing updates the URL (REPLACE) and fires ONE debounced search for the final text" (no `q=b`/`q=be` spam).
- Playwright: `web/e2e/search.spec.ts` — "as-you-type: results update while typing" — `pressSequentially('bet')` → Beta Trails renders, Alpha Quest hidden, URL `q=bet`, mode label `Filtered`, `searchRequests` contains only settled-state queries (`q=bet`, never `q=b&`/`q=be&`).
- Count/mode label: SearchBar aria-live status line — `Latest` / `All` / `Filtered (N)` (`RS_ModeAll`/`RS_ModeFiltered` parity); asserted in the jsdom tests.

### 2. FilterBar — authors, status, 38-genre ANY/ALL, custom genres, only-new, reset — URL-synced

- Component: `web/test/browse-live-search.test.tsx` — genre apply pushes `genres=Action,Drama` (implicit ALL default), chip row (`All of: Action, Drama`), chip removal pushes, status+authors+ANY compose (`status=Ongoing&authors=aka&mode=any`), shared deep-link URL (`?genres=Drama&mode=any`) renders the filtered list, reset clears params.
- Playwright: `web/e2e/search.spec.ts` — "genre filter: URL updates; back/forward restore the previous state" — `genres=Drama` appears, `goBack()` restores the exact pre-filter URL + latest list, `goForward()` re-applies the filter.
- Mobile Sheet: the `FilterBar` design-system pattern already collapses into a Sheet under 767px (unchanged).

### 3. API: authors + genres[] + genresMode with correct ANY/ALL SQL semantics

- Route composition (in-memory double + store-seam spy): `server/test/api/catalog-search-filters.test.ts` — 11 tests: ANY (OR) vs ALL (AND, and the default), comma + repeated param forms, authors case-insensitive contains, mixed `q+status+genres+authors`, `newDays` jdn window, `q`-optional filter-only pages, cursor binds the FULL filter state (mode flip / set change / authors / newDays / status rebinding all 400), validation envelopes, and the PARSED-params handoff proof (defaults incl. `genresMode:'all'`).
- Real SQL semantics (actual SQLite catalog file): `server/test/sync/db/catalog-store-search-filters.test.ts` — 10 tests: ANY → OR of LIKE, ALL → AND of LIKE, case-insensitive substring matching, authors contains, mixed composition, strict `jdn >` boundary (row ON the boundary excluded), filter-only ordering `jdn DESC`, LIKE-wildcard escaping (decisive `%` and `5_%` probes + `escapeLikeValue` unit), cursor rebind rejection, legacy single-`genre` FTS phrase ∩ new row filters.

### 4. OpenAPI snapshot + typed client regenerated; contract tests green

- Snapshot regenerated via `API_OPENAPI_SNAPSHOT=write`; typed client via `npm run gen:api -w @fmd/web`.
- `server/test/api/openapi.test.ts` — all 6 green (byte-for-byte snapshot, determinism, route inventory, every `$ref` resolves — the test that caught the generator collision, contract surface).
- `npm run contract:check` → PASS. `web/test/api-drift.test.ts` green (client ↔ snapshot).

## Full gate (final run)

```
npm run lint        → 0 errors, 0 warnings
npm run typecheck   → 0 errors
npm test            → Test Files 168 passed (168); Tests 1737 passed | 3 skipped
npx playwright test (web) → 15 passed (smoke · a11y · perf · site-picker · search)
npm run contract:check → PASS
```

(Playwright runs against the real Vite dev server with the fixture-mocked §10 API — fully offline.)

## Review cycle #3 note

The bounce-#2 review verdict executed at 22:34 — mid-remediation, while the workspace's asynchronous file-tearing had the tree in a partial state (router hook severed, test file mid-rewrite). All findings of both bounce-#2 verdicts were completed and then RE-verified in one batch, with a stability double-check (markers present 25s and 15s after the final writes — no further snap-back in the verification windows):

- typecheck 0 · lint 0 · vitest 169 files / 1746 passed | 3 skipped · Playwright 15/15 · contract:check PASS.
- Durability hardening: the URL-subscription hook now also lives in a NEW module (`web/src/state/use-route.ts`) — new files persisted reliably all session while edits to pre-existing files were the tearing victims; router.ts keeps its own copy too.

## Review cycle #4 (bounce #3)

Reviewer-verified root cause confirmed and fixed, plus three further real defects the investigation surfaced:

1. **useRoute vs jsdom harness (the blocker):** useRoute parses the LIVE hash on mount; jsdom tests rendered `<BrowsePage route={parseHash(...)}>` without ever setting `location.hash`, so the page fell back to the SitePicker. Fixed in the HARNESS per the reviewer's direction (useRoute untouched in behavior): `renderWithProviders` seeds `{ hash }` and `autoCleanup` clears it per test; the three suites pass their URL; browse-provision's local `route()` helper seeds it. useRoute itself was hardened in passing: rebuilt over `useSyncExternalStore` (`web/src/state/use-route.ts`) with name-stable + empty-hash-fallback semantics.
2. **Stale-prop tear:** `<SiteBrowse route={props.route} />` (static prop) instead of the live route — one token, whole URL-sync chain dead downstream. Fixed.
3. **Interaction-composition race (real UX bug):** consecutive filter edits built each `next` state from the render-captured state while the hashchange round-trip is async — a quick second click clobbered the first. Fixed with `liveFilterState()` (`browse-filter-state.ts`): the URL is the source of truth; the FilterPanel and chips compose every edit from the LIVE hash at interaction time.
4. **Assertions:** list separators in the hash are percent-encoded (`genres=Action%2CDrama`) — the jsdom helper reads `decodeURIComponent(hash)`; request-path expectations carry the explicit `genresMode=all` default; genre tests sequence one URL hop per click (re-query after re-render) and pagination uses a 3s findBy under load.

**Observed gate (single batch, this tree):** `npm test` → 169 files / 1733 passed | 3 skipped · typecheck 0 · lint 0 · contract:check OK · Playwright (web) 15/15. These numbers supersede the earlier Full-gate block (the tearing races made those runs observe different trees).
