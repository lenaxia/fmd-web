# Evidence — Settings parity (tsk-ethereal-verdict-orders)

Date: 2026-11-17 · Stage: in_progress → in_review · Workspace tree: uncommitted
in-flight slices (this story's slice rides the same tree as [parity-sweep],
R4 API-token, downloads-filters and engine-shim work, per the orchestrator's
coalescing policy).

## Scope delivered (Requirements 1–5)

| Req | Surface | Files |
| --- | --- | --- |
| 1 Accounts UI (frmAccountManager ADAPT) | Per-site `AccountCard` for `accountSupport` sites: masked password + show toggle, Save (PUT, omitted credential keeps the sealed store), Remove (DELETE), Check login (POST `/api/accounts/:id/login`) with the §5.2 status badge (asValid/asInvalid/asChecking/asUnknown), cookies link-out that opens + scrolls to the module row's existing cookies editor. Render cap (24 unstored cards + Show all) for the 400+-site registry | `web/src/components/AccountsSection.tsx`, wired in `web/src/pages/SettingsPage.tsx` (`onOpenCookies` → `setSearch('')` + `setOpenEditorFor`) |
| 2 Module list search + bulk | `ModuleListSearch` (name/category contains + live match count), `GlobalBulkControls` (Select all / None — FMD2 pas:6400 Select All/Unselect All), `CategoryBulkControls` per interleaved category header (Enable all / Disable all); one `POST /api/modules/bulk` write each; react-query invalidation flips the site picker immediately | `web/src/components/ModuleListControls.tsx`, grouping/rows in `SettingsPage.tsx` |
| 3 Filter panel artist + summary | `edFilterArtists`/`edFilterSummary` inputs (plus the existing authors field) in `CatalogFilterPanel`; state round-trips `artists=`/`summary=` URL params; server params on BOTH the per-site search and the all-sites union (`CatalogSearchQuerySchema`, `AllSitesSearchQuerySchema` — LIKE contains, cursor-bound) | `web/src/components/catalog/CatalogFilterPanel.tsx`, `web/src/state/browse-filter-state.ts`, `server/src/api/schemas.ts`, SQL in the catalog store + `live-scrape-store.ts` |
| 4 Output defaults (Save-to subset) | Format select zip/cbz/pdf/epub, chapter filename template (%WEBSITE%/%MANGA%/%AUTHOR%/%ARTIST%/%CHAPTER%/%NUMBERING%/%FILENAME%), digitPadding, removeMangaName, unicodeReplacement(+char); full-document PUT; per-job read at pack/finalize. DEFERRED and documented: FMD2 `None` loose-images format (§7.1 = one packed artifact/chapter) and PDF quality (D16 packer is DCT passthrough — no re-encode) — `docs/UX-PARITY.md` "Output defaults" row | `web/src/components/OutputDefaultsForm.tsx`, `server/src/api/schemas.ts` (`OutputDefaultsSchema`), honoring in `server/src/runtime/download-lane.ts` (packer select + stage palette + `resolveChapterFileName`) |
| 5 Per-site Re-sync catalog | Row action on every installed-catalog site: existing `POST /api/sync/catalog/:id` behind a sonner progress toast (start → sync `updated/unchanged/failed`) | `ResyncCatalogButton` in `SettingsPage.tsx`, `ProgressToast` pattern |

## Verification (this session, on the coalesced tree)

Server integration (`npx vitest run …`, all green):

```
server/test/api/accounts.test.ts                   10 passed  (CRUD, sealed-credential keep, OnLogin asValid + cookies persist, 404/409/502 paths)
server/test/api/modules-bulk.test.ts                7 passed  (category rewrite of module_state, exact-category isolation, global select-all/none)
server/test/api/catalog-search-filters.test.ts     21 passed  (artists/summary LIKE, case-insensitive, cursor binding; incl. describe "artists + summary filters")
server/test/api/settings.test.ts                   21 passed  (output defaults round-trip, per-format acceptance, 'none' rejected as DEFERRED)
server/test/api/openapi.test.ts                     6 passed  (snapshot pinned to the shared zod incl. artists/summary params)
server/test/runtime/download-lane-output.test.ts    2 passed  (NEW — see below)
```

New test added this session — the "honored on NEW jobs" proof
(`server/test/runtime/download-lane-output.test.ts`): real SQLite queue +
real packers + real library store end-to-end over the §13 loopback fixture
manga site, with only the wasmoon engine seam stubbed (`vi.mock` of
`EngineDownloadHooks.create` onto the same fixture-site hooks the §7.1
download suite drives):

1. `format + chapterNameTemplate: a NEW job packs .cbz under the template
   name (COMPRESS stage)` — library ledger row
   `Fixture Manga - Chapter 1 - The Beginning.cbz` on disk, COMPRESS stage
   observed, §7.2 downloaded-chapters dual-write recorded.
2. `a settings CHANGE applies to the NEXT job only (per-job read): epub +
   the chapter-name fallback` — job 1 `Chapter One.zip`, provider flipped
   (PUT semantics), job 2 `Chapter Two.epub` with the CONVERT stage.

Web unit (`npx vitest run …`, all green): `web/test/browse-filter-state.test.ts`
17 passed (incl. "artists + summary filter fields" round-trip describe),
`web/test/parity-sweep-ui.test.tsx` 9, `web/test/settings-bootstrap.test.tsx` 3,
`web/test/api-drift.test.ts` 3.

Playwright (`npx playwright test e2e/settings-parity.spec.ts --project=desktop`):

```
4 passed — account card round-trip (mask/show toggle, PUT body {username,password},
           password field clears, badge asValid → asInvalid on the second check);
           bulk category Disable all → picker hides the site immediately → global
           Select all re-enables (exactly 2 bulk writes: {enabled:false,category},
           {enabled:true}); per-site Re-sync catalog → 1 POST /api/sync/catalog/:id
           + "FixtureSite catalog sync updated" toast; module search name/category
           hit + miss empty state.
```

Lint: `npx eslint web/e2e/fixtures.ts web/e2e/settings-parity.spec.ts
server/test/runtime/download-lane-output.test.ts` — clean.

## Fixes made this session (beyond the prior attempt's slice)

1. **e2e mock swallow crash** — `API('settings')` in `web/e2e/fixtures.ts`
   and the settings-parity override was UNANCHORED, so it also answered
   `GET /api/settings/api-token` (R4 ApiTokenSection, coalesced tree) with
   the SettingsResponse — `data.token` undefined → `mask()` crashed and
   killed the whole SettingsPage render (all settings e2e red). Fixed:
   anchored to `settings$` in both files + a deterministic
   `settings/api-token` fixture route (`{token:null, envManaged:false,
   mode:'none'}`) added to `installMockApi`. Re-verified: settings-parity
   4/4 and site-picker-smoke 5/5 green.
2. **Missing honoring proof** — added
   `server/test/runtime/download-lane-output.test.ts` (above); the lane's
   per-job `deps.outputDefaults?.()` read had no test pinning the
   NEW-jobs-only semantics before.

## Pre-existing issues observed OUT OF SCOPE (other in-flight slices, not touched)

- `npm run typecheck` fails in other stories' files:
  `server/test/api/favorites-batch-transfer.test.ts` (FavoriteService
  override shape), untracked `server/test/api/jobs-actions.test.ts`
  (relative import ext), `server/test/runtime/runtime.test.ts`
  (RuntimeConfig gained password/apiTokenEnv), `server/tools/smoke/smoke.ts`
  (LuaFacadeBridge vs FacadeBridge).
- `server/src/runtime/engine-info.ts:163` calls `createContractDispatcher`
  WITHOUT importing it (engine-shim refactor in flight) →
  `server/test/runtime/runtime.test.ts` "live info" fails at runtime with
  `ReferenceError: createContractDispatcher is not defined`. One-line
  import fix, left to the engine slice's owner.
- `web/e2e/smoke.spec.ts` + `a11y.spec.ts` strict-mode failures: the
  coalesced BrowsePage row menu added a second `Actions for <title>`
  button, so the loose `getByRole('button', { name: /Alpha Quest/ })`
  locators resolve to 2 elements (browse-list-polish slice).
- `parity-sweep.spec.ts` open-by-URL (M14) — 2 failures, unrelated.
- Full-suite e2e under a REUSED vite server shows ERR_CONNECTION_REFUSED
  cascades when a prior run's spawned server is reaped mid-run; isolated
  runs (the CI pattern) are stable.

## Deferred (unchanged, documented)

`docs/UX-PARITY.md` → "Output defaults" row: PDF quality and the FMD2
`None` loose-images format DEFERRED with reasons; rename toggles
(digitPadding / removeMangaName / unicodeReplacement) wired via the
[parity-sweep] M5/M6/M8 merge. Accounts, module search/bulk and per-site
re-sync rows all marked PARITY [settings-parity].
