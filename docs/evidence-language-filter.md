# Evidence — Site picker category facet filter + unified browsing (tsk-copper-tiara-sweeps)

User-reported gaps addressed: (1) sites could not be filtered by language; (2) 'live browse' vs 'live-scrape' named an internal implementation detail in the UI. FMD2 ground truth: Options→Websites groups modules BY CATEGORY as language groupings (frmMain.pas:6400-6470) and browsing never asks the user where the list comes from (cbSelectMangaEditingDone :3001).

## What changed

### 1. Category/language facet filter (`?cats=`, URL-synced)
- `web/src/components/patterns/SiteFilterChips.tsx` — NEW design-system pattern: one toggle chip per category (with count badge, `aria-pressed`), an `All` chip that clears the selection; caller-owned state (the picker owns the set via the URL).
- `web/src/pages/SitePickerPage.tsx` — chips row ABOVE the list; `parseCatsParam`/`serializeCats` codec (`?cats=<csv>`, unknown categories dropped so a shared URL never filters to empty); `buildPickerItems(modules, needle, cats)` filters rows across the grouped list (chips OR within, AND with the search box); `categoryFacets` computes counts over the ENABLED registry (stable facet totals). Chip toggles PUSH history (back/forward restore the facet); picker now subscribes via `useRoute`.
- `BrowsePage` passes its `route` into the picker.

### 2. Unified browsing model (zero internal vocabulary)
- `web/src/pages/BrowsePage.tsx`:
  - `forceLive` state DELETED — live is the automatic fallback, not a user choice.
  - `fellThroughToSite = needsProvision && provisionView?.view === 'no-catalog' && directoryCapable` — a catalog-less directory-capable site opens its list AUTOMATICALLY (the server serves `/api/catalog/:id/*` live; the REST/WS `no-catalog` outcome needs no interaction).
  - `ProvisionPanel` simplified: `liveCapable`/`onLive` props and the 'Browse live instead' / 'Try live browse' buttons DELETED; no-list dead-end (non-directory-capable) and transient-failure/cancel panels rewritten in plumbing-free copy ('No list available for this site', 'Couldn't open this site', 'Cancelled').
  - The inline progress experience is one thing: `Preparing <site>…` + cancel (`data-testid="provision-status"`).
- `web/src/components/catalog/SourceBadge.tsx` — NEW muted per-list source badge: 'from site' (tooltip 'List fetched live from the site') / 'from catalog' (tooltip 'Prebuilt list from FMD2-DB'); `data-source` attribute; replaces the old 'live scrape' badge. Rendered on served lists from the required per-page `source` discriminator; transparency only — never on a control.
- `web/src/components/ProvisionToast.tsx` — toast copy reviewed to plumbing-free language: `Preparing <site>…` / 'Looking for the site's list…' / 'Downloading the site's list…' / 'Unpacking…' / 'Finishing up…' / `<site> is ready.`; no FMD2-DB, no 'provisioning', no channel words. On the automatic fall-through the toast unmounts (quiet dismissal — one progress experience, never an error).
- `web/src/components/CatalogStateChip.tsx` — the 'live browse' chip DELETED; binary readiness chip: 'ready' / 'needs setup' (tooltips explain, no modes).
- `web/src/components/CapabilityBadges.tsx` — the `live_scrape_fallback` badge renamed 'directory' with a user-facing tooltip ('…can list its titles straight from the site when no prebuilt list exists'). No 'scrape' string remains in any rendered UI.
- `web/src/components/catalog/UnionSearchChips.tsx` — excluded-site chip tooltip reworded (was '…is not scraped live to fill the gap'); a repo-wide sweep now finds 'scrape' only in the API field name (`live_scrape_fallback`, data — never rendered) and code comments.
- Known-broken modules: disabled-with-reason, unchanged (`siteRowDisabledReason`).

## Verdicts (commands + results)

| Gate | Command | Result |
| --- | --- | --- |
| Unit/integration (offline) | `npm test` | 174 files, 1760 passed / 3 skipped (was 1748 passed — +12: chips matrix, URL round-trip, unified-browse taxonomy, pattern unit tests) |
| Lint | `npm run lint` | clean |
| Typecheck (strict TS) | `npm run typecheck` | clean |
| Contract drift | `npm run contract:check` | OK — 0 mismatches (no contract change; `source` field kept, badge-only consumption) |
| Playwright smoke suite | `npx playwright test` (web) | 17 passed, incl. all 5 site-picker specs |
| Playwright visual regression | `npx playwright test -c playwright.visual.config.ts` (web) | 12 passed (per-page × per-theme fixtures) |
| Design-system gate | `bash scripts/design-gate.sh` | OK (tokens-only styling) |

## Test coverage mapped to acceptance criteria

1. **Chips filter matrix + URL sync + persistence**
   - `web/test/site-filter-chips.test.tsx` (new): pattern in isolation — counts, `aria-pressed`, multi-select toggle semantics, caller-owned state.
   - `web/test/site-picker.test.tsx`: single / multi (union) / All / toggle-off; AND-composition with search; `?cats=` round-trip at mount (chip pressed from URL); unknown-category drop; counts exclude disabled modules; empty-result copy.
   - `web/e2e/site-picker-smoke.spec.ts` 'category facet chips…': single → multi → reload persistence (facet + pressed chips restored from `?cats=`) → All reset → chips∧search.
2. **Unified browsing**
   - `web/test/browse-provision.test.tsx` 'FMD2-DB 404 on a directory-capable site → AUTOMATIC live fallback': one progress experience (`Preparing LiveSite…`), entries open with zero interaction, `entryCalls()==1`, badge 'from site', DOM grep — no `/live[ -]browse/i`, no `/scrape/i`, no mode-named buttons. Non-capable 404 → friendly no-list panel, nothing opens.
   - `web/e2e/site-picker-smoke.spec.ts` 'catalog-less directory-capable site → automatic live fallback': 'Preparing NoCatalogSite…' visible → entries open automatically → muted badge → `expectNoModeVocabulary` DOM grep on the live page; the provisioned path badges 'from catalog'.
   - `forceLive` branch deleted from source (grep: only the deleted file history references it).
3. **Muted source badge + toast copy** — `web/test/pagination.test.tsx` (both channels badged with exact tooltips); ProvisionToast copy table above; toast copy asserts ride the browse-provision + e2e specs ('Downloading the site's list…', 'Preparing …').
4. **Existing specs green** — full `npm test` + full Playwright smoke + visual suites green; updated where they asserted old labels: `site-picker.test.tsx` (chip/badge labels), `capability-badges.test.tsx` ('directory'), `pagination.test.tsx` (both badge variants), `browse-provision.test.tsx` (taxonomy), `site-picker-smoke.spec.ts` (labels + flows).

## Files touched

New: `web/src/components/patterns/SiteFilterChips.tsx`, `web/src/components/catalog/SourceBadge.tsx`, `web/test/site-filter-chips.test.tsx`, `docs/evidence-language-filter.md`.
Modified: `web/src/pages/SitePickerPage.tsx`, `web/src/pages/BrowsePage.tsx`, `web/src/components/ProvisionToast.tsx`, `web/src/components/CatalogStateChip.tsx`, `web/src/components/CapabilityBadges.tsx`, `web/src/components/catalog/UnionSearchChips.tsx`, `web/test/site-picker.test.tsx`, `web/test/browse-provision.test.tsx`, `web/test/capability-badges.test.tsx`, `web/test/pagination.test.tsx`, `web/e2e/site-picker-smoke.spec.ts`.

Out of scope (per story): Settings-module-list search parity (settings-parity story); API/contract changes (`source` kept as-is, badge-only consumption).
