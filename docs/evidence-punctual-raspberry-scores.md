# UX audit P2 polish sweep — evidence (tsk-punctual-raspberry-scores)

Scope: docs/UX-AUDIT.md §10 "P2 — polish (grouped)". Favorites P0/P1 layout items were
owned by the concurrent Favorites rework; every Favorites item below was reconciled
against that rework's tree state before acting. The P1 lane (back-context, nulls,
timestamps, settings nav) landed adjacently; where this sweep's edits share a file with
that lane, both are called out.

## Item → change → proof

### Loading skeletons (H-1, B-3, M-6)
- `web/src/pages/SearchHomePage.tsx` — union-search pending renders a 5-row skeleton list
  (`data-testid="search-skeleton"`, EntryRow sizing `min-h-row`+`px-3 py-2`) inside a
  `role="status"` region labelled "Searching every installed catalog"; no layout pop-in.
- `web/src/pages/BrowsePage.tsx` — catalog pending renders `data-testid="catalog-skeleton"`
  (5 rows, same EntryRow metrics, `aria-label="Loading catalog entries"`).
- `web/src/pages/MangaPage.tsx` — info pending renders `data-testid="manga-skeleton"`: a
  Card mirroring the loaded layout (cover block + metadata lines, `max-md:flex-col`) with
  an `sr-only` "Fetching live info…" status; the bare text line is gone.

### Consistency (SP-1, SP-2, B-1, B-2, H-2, AS-2)
- SP-1 `SitePickerPage.tsx` — both bare `role="status"` empties are now shared
  `EmptyState` cards with recovery actions: registry-empty → "Open Settings"
  (also drops the "(D20)" ticket id from the copy), no-match → "Clear filters"
  (`data-testid="site-picker-clear-filters"`, clears `?cats=` + search). The
  no-match sentence text is unchanged (test regex still pins it).
- SP-2 — the no-op Search submit button is removed (live per-keystroke filtering;
  `type="search"` carries its own clear); the form stays for Enter focus stability.
- B-1 `BrowsePage.tsx` — the "Filters •" glyph is a count badge
  (`data-testid="filters-count"`, `text-[11px]`) driven by the new
  `activeFilterCount()` in `web/src/state/browse-filter-state.ts` (mirrors the
  AppliedFilterChips dimensions exactly); button `aria-label="Filters, N active"`.
- B-2 — "Change site" moved from the PageHeader *description* into the `actions` slot
  (`data-testid="change-site"`, `max-md:min-h-touch-target` kept).
- H-2 `SearchHomePage.tsx` — with recents on screen the idle EmptyState collapses to a
  one-line compact card (`data-testid="idle-compact"`) + the shared
  `CategoryQuickChips`; the full teaching copy (guide link) shows only for fresh users.
- AS-2 `AllSitesSearchPage.tsx` — the duplicate idle EmptyState below the search bar is
  removed; the PageHeader description is the single teacher.

### Favorites polish (F-6, F-7, F-8 — post-reconcile)
- Reconciliation: the concurrent Favorites rework already landed F-1..F-5, F-8
  (rename `col-span-full` + Enter/Esc handlers) and F-7 (xl+ meta collapses to
  "added …" only — `FavoriteColumnMeta.addedOnly`), plus a chevron-affordance
  menu-button for the check scopes.
- F-6 (this sweep): TRUE split-button — the label half RUNS the default (last-chosen)
  scope (`data-testid="check-all-button"`, `aria-label="Check <scope> favorites for new
  chapters"`); the caret half opens the scope menu (`data-testid="check-scope-trigger"`),
  whose picks re-set the default and run. Shared `runBatchCheck()` carries the F-5 error
  toast for every path. Tests updated: `web/test/favorites-page.test.tsx` (action runs
  'all'; caret+item for 'enabled'), `web/e2e/favorites-parity.spec.ts`,
  `web/e2e/touch-audit.spec.ts` (R3a opens the menu via the caret).

### Mobile (M-4, T-7)
- M-4 `MangaPage.tsx` — info Card is `max-md:flex-col` (cover stacks above the dl);
  the M-6 skeleton mirrors it.
- T-7 — settings (and app-wide) inputs render ≥16px on mobile: the vendored `Input`
  already carried `text-base md:text-sm`; this sweep fixed the stragglers —
  `patterns/NativeSelect.tsx` (`text-base md:text-sm`), `ui/select.tsx` SelectTrigger
  (`max-md:text-base`), and the module-editor cookies `textarea`
  (`max-md:text-base`) in `SettingsPage.tsx`. No iOS focus-zoom remains.

### Downloads / Library (D-2, D-3, D-4, L-2, L-3)
- D-2 `JobRow.tsx` — the raw job-id `<code>` chip is out of the scan line; the full id
  rides the title tooltip and a muted `job <id>` line atop the row menu
  (`data-testid="job-id-<id>"`).
- D-3 `JobsToolbar.tsx` + `DownloadsPage.tsx` — the bulk-delete confirm names the exact
  count: "This will delete N completed job(s)…" (`data-testid="delete-completed-count"`),
  fed by a new `completedCount` prop; the "(FMD2 RemoveAllFinishedTasks)" jargon is gone.
- D-4 `JobRow.tsx` — long errors (>60 chars) are expandable in place
  (`data-testid="job-error-toggle"`, `aria-expanded`, truncated↔`break-all`), not
  tooltip-only.
- L-2 (full stack): `DELETE /api/library/:id` — `LibraryService.remove(id)` in
  `server/src/api/services.ts` (InMemory) + `server/src/runtime/library-service.ts`
  (Sqlite, reusing the guarded `deleteLibraryFileByPath` unlink), the route in
  `server/src/api/app.ts`, the `deleteLibraryFile` OpenAPI operation + regenerated
  `openapi.snapshot.json` / `web/src/api/openapi.d.ts`, the `useDeleteLibraryFile` hook,
  and the LibraryPage row menu → "Delete file…" → confirm dialog naming the file
  (`library-menu/delete-file/delete-dialog/delete-confirm` testids; error banner on
  failure; list invalidated + refetched). Regression:
  `server/test/api/jobs-cancel-library.test.ts` (DELETE describe: file+row removed from
  disk and listing; row removed when file already gone; 404 unknown / 400 malformed) and
  `web/test/library-page.test.tsx` (meta + delete flow + cancel).
- L-3 — the filename lost its `<code>` chip: muted trailing text on the meta line
  (`text-muted-foreground/70`), full name still on the title tooltip.

### A11y nits (S-2, S-3, palette check)
- S-2 — top-nav badge `text-[10px]` → `text-[11px]` (`App.tsx`); bottom-nav badge
  `text-[9px]` → `text-[11px]` (`BottomTabNav.tsx`); tabular-nums/leading preserved.
- S-3 — header brand link carries `aria-label="FMD Web home"`.
- Palette check — "Check favorites for new chapters" now surfaces results instead of a
  toast dead-end: on completion it invalidates `['favorites']` and navigates to
  Favorites (`navigate('favorites', {})`), toasting the result count ("…; opening
  Favorites"). (`CommandPalette.tsx`.)

### Jargon/copy leftovers (T-5, T-6)
- T-5 — module editor success reads "Saved. Module <name> updated (disabled)." — the
  module NAME, never the hex id (the id also no longer rides module-meta — that was the
  P1 lane's strip).
- T-6 — the post-sync walls at the top of Settings collapsed: one-line statuses
  ("Module sync complete: N modules." / "Catalog sync complete: N catalog(s).") +
  `<details>` ("Sync details" / "Catalog sync details") carrying the tree SHA / file
  counts / per-catalog CSV; FAILURES stay expanded and visible. The first-run bootstrap
  empty-state summary is untouched (teaching copy, pinned by its own test).
  `web/test/settings-bootstrap.test.tsx` updated to the new copy + details content.

## Gates (all via node_modules/.bin — npx is broken in this env)
- `eslint .` — clean (one unused `navigate` import left mid-flight by the P1 lane in
  DownloadsPage removed).
- `tsc -b tsconfig.json` — clean.
- Targeted vitest (library/jobs-cancel-library/openapi/favorites/site-picker/
  settings-bootstrap/downloads-feed) — 7 files, 56/56 green.
- Full vitest — 2189 passed; the ONLY failures are `web/test/fmd2-import-card.test.tsx`
  + `server/test/import/apply.test.ts`, the concurrent FMD2-import lane's own in-flight
  feature files (not touched by this sweep).
- Playwright e2e (full) — 90 passed / 10 skipped, then the two real failures fixed
  (touch-audit scope-menu trigger → caret; settings enabled-label `max-md:min-h-touch-target`)
  and their specs re-run green (touch-audit 12/12).
- Visual fixtures regenerated through the reviewed-update flow
  (`playwright test -c playwright.visual.config.ts --update-snapshots`): all 32
  committed fixtures (browse/manga/downloads/favorites/library/settings/search-home/
  palette × dark/light × desktop/mobile), then the 4 settings fixtures re-taken after
  the label touch fix. Fixture deltas in the commit are the review artifact.

## Concurrency notes (shared working tree)
- Three lanes were live in one tree during this sweep (Favorites rework; P1 fixes;
  FMD2 import). Two mid-flight rewrites clobbered this sweep's additive server edits
  (DELETE /api/library route + deleteLibraryFile op) — re-applied each time and a
  coordination note was sent to the import lane; final state verified by grep-marker +
  green regression tests immediately before commit.
- Files co-committed here that also carry sibling-lane hunks (FavoritesPage rework,
  SettingsPage T-1 nav, MangaPage M-1/M-2, App.tsx/CommandPalette em-dash sweeps,
  favorites tests) follow the repo's coalesce convention (cf. 61cc9c2); the sibling
  tasks' own commits will note their sides.
