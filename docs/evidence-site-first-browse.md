# Evidence — Site-First Browse (FMD2 parity, tsk-handsome-cliff-endures)

Named-site picker → transparent catalog provisioning → entries; hex IDs
retired from the UI. Ground truth (verified in FMD2 source this session):
`cbSelectManga.Items.AddObject(m.Name, TModuleContainer(m.P))` — sites
listed **BY NAME** with the module object attached
(`FMD2/mangadownloader/forms/frmMain.pas:6186`); selecting one
(`cbSelectMangaEditingDone`, frmMain.pas:3001) clears the list and either
opens the local catalog DB instantly or provisions it via
`DBUpdaterThread` (dialog on desktop). IDs are never user-visible; the
web keeps them in the URL/deep-links only.

## What landed

### 1. Browse default = SitePicker (sites BY NAME)

- `web/src/pages/SitePickerPage.tsx` — searchable (`#site-search`),
  category-grouped (A→Z headers with counts), virtualized above
  ListPanel's 100-row threshold (the 454-site registry scrolls);
  ENABLED modules only. Composed from design-system patterns only:
  PageHeader + FilterBar + ListPanel + Button/Input.
- `web/src/components/SiteRow.tsx` — the name is the primary identity
  (site-meta: category · host); `CapabilityBadges` ride the row; the
  hex id sits in `data-site-id` and the URL — **never text**.
- `web/src/components/CatalogStateChip.tsx` — `catalog ready` /
  `live browse` / `needs setup` (from `catalogInstalled` +
  `live_scrape_fallback`).
- Known-broken rows (D3 flags): disabled with the reason (title +
  badge + aria-label) — FMD2 hides unchecked sites; the web surfaces
  standing breakage instead of a mystery failure.
- Language badge: **not available** in the registry projection
  (`RegistrationRecord` carries no language field — §5.1 options are
  the only per-module text). Requirement says "where available": it is
  not, and inventing a fake language column would drift from the
  module contract. Dropped deliberately.

### 2. Selecting a site → `browse?site=<id>`

- URL contract: `?site=` supersedes `?catalog=`; both accepted
  (`site ?? catalog`), old deep links keep working (`web/src/pages/BrowsePage.tsx`).
- Catalog installed → the entries view (latest/title/search modes,
  cursor pagination) — unchanged behaviors and test hooks
  (`#browse-search`, `.catalog-list`, `.catalog-entry`, Load more).
- Not installed → **AUTO-PROVISION** (web default; FMD2 asks via
  dialog because desktop): `POST /api/sync/catalog/:id` +
  `useSyncCatalogProgress(jobId)` over the WS hub's `sync` frames →
  sonner progress toast (`ProvisionToast`) with phase text, a coarse
  determinate bar, and a **Cancel** action; inline `role=status`
  mirror pinned at `[data-testid=provision-status]`. Entries open on
  completion (`catalogInstalled` flips via live join + refetch).
- StrictMode-safe: the provision POST fires exactly once per
  (site, attempt) via a fired-key ref (dev double-invoke guarded).
- Cancel semantics (documented honestly): canceling withdraws the
  provisioning UX (toast + panel + no auto-open). The sync itself is
  ONE idempotent request — aborting the fetch transport was dropped
  after openapi-fetch's internal `new Request(...)` rejects jsdom's
  cross-realm AbortSignal (breaks the whole offline unit suite); a
  late server-side completion merely flips the chip to ready. Never a
  partial state (§6.3 atomic install).

### 3. Provision failure taxonomy

- **FMD2-DB 404** → `CatalogBlobMissingError` (sync/db/http-client.ts)
  with the stable `no-catalog:` error prefix;
  `WsPublishingSyncService` maps it to the terminal `no-catalog`
  WS outcome; the UI shows the friendly "No prebuilt catalog for this
  site" + **Browse live instead** offer when
  `capabilities.live_scrape_fallback` (§6.8 directory events) — live
  pages carry the `source:'live'` badge ("live scrape").
- **Transient network error** → "Catalog provisioning failed" with
  **Retry** (re-fires the sync POST; nothing partial was installed).
- **Known-broken module** (D3 flags) → row disabled in the picker with
  reason; a deep link shows "This site is unavailable" + reason, and
  never provisions.

### 4. API extension (additive contract)

- `ModuleSummary` gains `catalogInstalled: boolean` — joined LIVE from
  the CatalogStore receipts (`getMeta`, §6.4) per list/get, so a
  finished provision flips on the next read without cache
  invalidation. `server/src/api/schemas.ts` + `services.ts`
  (`InMemoryModuleService`/`RefreshableModuleService` lookup seam) +
  `runtime/assembly.ts` wiring.
- OpenAPI snapshot regenerated (`API_OPENAPI_SNAPSHOT=write vitest run
  server/test/api/openapi.test.ts`) — diff is exactly the additive
  field + description; typed client regenerated (`npm run gen:api -w
  @fmd/web`, `catalogInstalled: boolean` in `web/src/api/openapi.d.ts`).
- WS `sync` frames (additive contract surface): `contract/schemas.ts`
  gains `CatalogSyncProgress` (+phases/outcomes), `WsSyncEventMessage`
  (`{type:'sync', id, sync}`), `catalogSyncJobId('<moduleId>')` ring
  key; `WsHub.publishSync` reuses the D19 ring/replay machinery
  verbatim (backfill covers provisioning for free).
- `WsPublishingSyncService` (server) wraps the sync port: `checking`
  → service phases (`downloading`/`extracting`/`installing` from
  `CatalogSync.syncCatalog(id, onProgress)`) → terminal
  `done{outcome}` — REST responses pass through unchanged.

### 5. The hex-ID empty state is deleted

- `CatalogIdForm` and the "No catalog selected" empty state are gone
  with the component (`web/src/pages/BrowsePage.tsx` rewritten); the
  picker's empty registry explains the D20 bootstrap instead.
- Specs of the hex state deleted/rewritten: pagination.test.tsx hex
  case → picker assertions; e2e bootstrap-watch asserts the picker.
  No `Catalog id` label / `Open` button exists anywhere in the UI.

## Test evidence (all offline; commands re-run this session)

- `npm test` — **1690 passed | 3 skipped** (pre-existing live skips).
  New: `server/test/api/modules.test.ts` (catalogInstalled live join,
  flip-on-install), `server/test/api/ws/sync-events.test.ts`
  (publishSync live fanout, contract boundary, D19 replay, per-key
  rings), `server/test/api/sync-ws-publishing.test.ts` (phase stream,
  no-catalog mapping, throw path, caller-passthrough),
  `server/test/sync/db/no-catalog.test.ts` (404 → stable prefix over
  the mock GitHub server; phase order `downloading→extracting→installing`),
  `web/test/use-sync-catalog-progress.test.ts` (typed machine
  transitions, settled terminals, foreign-key filtering, reset),
  `web/test/site-picker.test.tsx` (name/group/chip/broken/search,
  hex-never-rendered, no catalog-id form),
  `web/test/browse-provision.test.tsx` (auto-provision → entries,
  cancel, 404 taxonomy + live offer, retry, broken-disabled, legacy
  `?catalog=` alias), `web/test/ws-contract-drift.test.ts` (sync
  frames round-trip the shared zod source; type-level pins).
- `npx playwright test` (web) — **13 passed**: the 4 new
  `site-picker-smoke.spec.ts` flows (picker → provision(mock) →
  browse → **manga deep-link**; cancel; 404 → live-scrape offer with
  source badge; broken disabled + hex-never-in-innerText) alongside
  the untouched smoke/a11y/perf suites (`?catalog=` legacy links
  still pass).
- `npm run e2e:visual` — **12 passed**; exactly the two browse
  fixtures regenerated (header identity: site name, not the hex chip);
  every other page byte-identical.
- `npm run lint` — clean. `npm run build` (tsc -b, all workspaces) —
  clean (FORCED clean re-verify — see the review addendum below).
  `npm run contract:check` — OK, 0 mismatches.

## Review addendum (bounce 1 — 2026-11-16, verifier pitchy-leopard-refrains)

The first review caught two `TS2459` type-import errors the original
session's INCREMENTAL `tsc -b` masked (stale per-project
`.tsbuildinfo` skipped rechecking the new test files), making the
original "build clean" evidence line false as stated:

1. `server/test/api/sync-ws-publishing.test.ts` imported
   `CatalogSyncProgressT` from `src/api/services.js` (declared there
   locally via `import type`, never re-exported) → now imported from
   `@fmd/contract` (the boundary source, alongside `catalogSyncJobId`).
2. `web/e2e/site-picker-smoke.spec.ts` imported `ModuleSummaryT` from
   `./fixtures` (imported there, never re-exported) →
   `e2e/fixtures.ts` now re-exports it
   (`export type { ModuleSummaryT } from '../src/api/hooks'`).

Post-fix re-verification, this session (dated):

- `npx tsc -b --force` (all workspaces, no incremental shortcuts) —
  exit 0, zero diagnostics; `npm run lint` — clean.
- `npm test` — 164 files / **1690 passed | 3 skipped** (unchanged).
- `npx playwright test` (web) — **13 passed** (unchanged).

## Divergences (deliberate, documented)

1. FMD2 asks before provisioning (desktop dialog); the web AUTO-
   provisions with visible progress + cancel (task requirement 2).
2. Cancel withdraws the UX; the idempotent request may complete
   server-side (atomic install; chip flips) — FMD2 kills the thread.
3. No language column: not present in the module registry projection.
4. FMD2 lists CHECKED sites; the web lists ENABLED modules (the
   module_state `enabled` flag is the web's checkmark equivalent).
