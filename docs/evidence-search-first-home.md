# Evidence — Search-first home + '/' shortcut + Cmd/Ctrl+K command palette (R5 web-native IA)

**Story:** tsk-amber-squeegee-leaves — R5 license on the biggest parity-capped workflow
**Date:** 2026-11-17 · **Stage:** in_progress → in_review

## Summary

The primary job ("I want to read X") now starts at a SEARCH box, not a 454-row site
combobox. `#/browse` with no site param renders the **search home** — a prominent
search input running the EXISTING union search (`GET /api/search`, every installed
catalog at once) as-you-type (250ms debounce, q URL-REPLACE while typing — shareable,
no history spam), Website badge per row, per-site facet chips that narrow into the
site's browse context. Site-first survives untouched as the SECONDARY mode: the
**Browse sites** toggle (and the site view's "Change site") opens the full picker at
`#/browse?sites=1`; `?site=` / `?catalog=` deep links render exactly as before;
`?allsites=1` (FMD2 cbSearchFromAllSites parity view) is unchanged. A **global '/'**
focuses the search input from anywhere (navigating first when needed; literal inside
any input/textarea/contenteditable; Esc blurs; desktop-only kbd affordance — mobile
reaches search via the always-visible input, R3). A **Cmd/Ctrl+K command palette**
(vendored `cmdk` via `components/ui/command.tsx`) offers navigate (5 routes),
jump-to-site (searches the FULL module registry by name/category, capped at 20 rows
per query; non-enabled/known-broken rows render disabled like the picker), open
recent manga, and three run-actions (Sync all catalogs → `POST /api/sync/catalog/all`,
Check favorites → `POST /api/favorites/check` scope=all, Toggle theme). The palette
opens via a VISIBLE header affordance on every viewport (R3 — icon on mobile, label
+ ⌘K/Ctrl K hint on desktop), is focus-trapped + Esc-closable (Radix Dialog) with
cmdk's combobox semantics, and its state is ephemeral by design — query resets on
every open, never URL-synced. **Recents plumbing**: shared localStorage stores
(`fmd.recent-sites`, `fmd.recent-manga`) — capped at 8, deduped (re-open moves to
front), clearable — written by the site entries view (resolved site name, never hex
ids in UI) and the manga page (exact deep-link params), consumed by the home rows
AND the palette; a clear on the home is immediately reflected in the palette.
Composition only: **zero new API surface**.

## Ground truth / design anchors

| Element | Source of truth | Implementation |
|---|---|---|
| Search-first default | R5 ruling (65083e3): web-native is the design authority | `BrowsePage` arbitration: no site param → `SearchHomePage`; picker → `?sites=1` |
| Union search, Website badges, facet chips | Existing machinery (f4f09ac, frmMain.pas:5170) | `SearchHomePage` recomposes `useAllSitesSearch` + `WebsiteBadge` + `FacetChips` + `CatalogEntryRow` |
| '/' / Cmd-K shortcuts | GitHub/Linear-class web pattern | `App.useGlobalShortcuts` + `state/search-focus.ts` bus (pending-flag survives navigate-then-mount) |
| Palette | cmdk (vendored `ui/command.tsx`, shadcn CLI) | `components/palette/CommandPalette.tsx` |
| Recents | localStorage pattern (theme, highlight-new) | `state/recents.ts` — useSyncExternalStore + module store, same as `highlight-new.ts` |
| R3 both-viewport | ruling 61f1300 | Playwright `desktop` + `mobile` projects (Pixel 7 — Chromium mobile surface; Webkit binary not in the offline sandbox toolchain, documented in config) |

## Key decisions

1. **Picker address is `#/browse?sites=1`** — bare `#/browse` is the search home per
   the story. The picker PRESERVES its own param on category-chip navigation
   (`{sites:'1', ...serializeCats()}`) so `?cats=` round-trips stay on the picker.
   "Change site" (site view) and the AllSites toggle-off now target `?sites=1` —
   preserving their pre-story destination (the picker), not the new home.
2. **`?allsites=1` kept as-is** — the FMD2-parity union view and its spec are
   untouched; the search home is the recomposed default, not a replacement of that
   deep link. Relevance/ranking deliberately unchanged (v0.4 candidate, story text).
3. **Recents dedupe keys**: sites by module id; manga by (moduleId, url) — a re-open
   moves to front and refreshes the stored title. Home owns the Clear affordances;
   the palette consumes the same store (clear propagates instantly).
4. **Palette site search = full registry** (all modules findable by name/category),
   but only enabled, non-known-broken rows are selectable — identical gating to the
   picker. 20 rows rendered per query (registry order) keeps the 454-module list fast.
5. **Palette actions over existing hooks** (`useSyncAllCatalogs`,
   `useFavoritesCheckBatch('all')`, `useTheme().toggleTheme`) with sonner toasts —
   no new endpoints, no duplicated logic.
6. **'/' typing guard** covers INPUT/TEXTAREA/SELECT/contentEditable; when the
   palette is open, cmdk owns keys. Esc-blur lives on the home input itself.

## Files changed (mine)

**New:** `web/src/state/recents.ts` · `web/src/state/search-focus.ts` ·
`web/src/pages/SearchHomePage.tsx` · `web/src/components/palette/CommandPalette.tsx` ·
`web/e2e/search-home.spec.ts` · `web/test/recents.test.tsx` · 8 visual fixtures
(`search-home`/`palette` × desktop/mobile 1280×800/390×412-class × dark/light).

**Modified:** `web/src/App.tsx` (shortcuts + header affordance + palette mount) ·
`web/src/pages/BrowsePage.tsx` (arbitration + recents recording + Change-site target) ·
`web/src/pages/SitePickerPage.tsx` (keeps `sites=1` on cats navigation) ·
`web/src/pages/AllSitesSearchPage.tsx` (toggle-off → picker) ·
`web/src/pages/MangaPage.tsx` (records recent manga) ·
`web/playwright.config.ts` (**desktop + mobile projects**) ·
`web/e2e/visual.spec.ts` (search-home + palette, both viewports × both themes) ·
picker-address updates in `e2e/{site-picker-smoke,parity-sweep,settings-parity,bootstrap-watch}.spec.ts`
+ unit expectations in `web/test/{pagination,site-picker,all-sites-search,bootstrap-banner}.test.ts(x)` ·
anchored entry-row locators (`/^Title/` — the row's overflow menu is "Actions for
<title>", unanchored regexes strict-violate) in `e2e/{smoke,search,a11y,all-sites-search,perf,site-picker-smoke}.spec.ts`
(coalesced-commit debt, mechanical) · 12 refreshed page fixtures (header gained the
palette button).

## Acceptance criteria → evidence

### 1. `#/browse` default = search home; site-first fully working as secondary mode

- `e2e/search-home.spec.ts` (BOTH projects):
  - "search home is the #/browse default" — input + Browse-sites toggle + category
    quick-chips (registry languages) render; NO picker heading.
  - "typing yields union results with Website badges; a facet chip narrows into the
    site" — `/api/search` union mock; rows + `Website: FixtureSite` badges; URL
    `#/browse?q=que`; facet chip → `?site=<id>&q=que` with the site entries view open.
  - "Browse sites toggle swaps to the site picker" — `#/browse?sites=1`, picker
    heading + search; home input gone; on MOBILE the picker's filters open via the
    visible Filters button (FilterBar Sheet — the app's R3 mobile chrome).
  - `?site=` deep links: exercised throughout (`'/'` test's goBack lands back on
    `?site=`; facet-narrow opens the entries view unchanged).
- `web/test/pagination.test.tsx`: bare browse renders the search home
  (`Search all sites` + Browse-sites button, `/api/modules` only); `?sites=1`
  renders the picker (hex-ID contract intact).
- `e2e/search.spec.ts` / `browse-list-polish` / `manga-parity` / `all-sites-search`
  / `site-picker-smoke` (incl. WS provisioning + live-fallback flows): green at the
  new picker address — site-first flows unchanged.

### 2. '/' global focus; Cmd/Ctrl+K palette; mobile visible affordance

- `'/' focuses…` (desktop project only — `test.skip(isMobile)`, the affordance is
  desktop-only by design): from `#/downloads` → `#/browse` + `#home-search` focused;
  Esc blurs; from a `?site=` deep link '/' leaves site context and Back restores it;
  '/' inside the picker's search box is a literal character.
- Palette (BOTH projects, opened via the visible header button): navigate item
  routes (+ closes); reopen resets the query (ephemeral); jump-to-site by name →
  opens `browse?site=`; actions — Toggle theme flips `html.dark`↔`light` (seeded
  deterministic baseline), Sync all catalogs + favorites check POSTs observed via
  counting route spies (mock).
- a11y: Radix Dialog focus trap + Esc; cmdk combobox/listbox/option roles; header
  button carries `aria-keyshortcuts="Control+K Meta+K"`. `e2e/a11y.spec.ts` (tab
  order incl. the new header button, keyboard-only browse flow) green.

### 3. Recents rows + empty state

- `web/test/recents.test.tsx` (7 unit tests): cap 8, dedupe-by-key (site id;
  module+url), move-to-front, clear, corrupt-storage tolerance, hook re-render sync.
- `e2e/search-home.spec.ts` "recents: …" (BOTH projects): seeded rows render on the
  home; the palette's Recent manga group consumes the same store; a recent-manga
  chip reopens the exact deep link; Clear (home) empties row AND palette group.
- Home recording is live: opening a site view / manga page writes real entries
  (exercised by the recording effects; e2e asserts the seeded-store contract).

### 4. Playwright green in BOTH projects; visual fixtures 2 viewports × 2 themes

- `npx playwright test --project=mobile` → **7 passed, 1 skipped** (desktop-only
  '/' test). Mobile project = Pixel 7 (412×915, isMobile, hasTouch, mobile UA).
- `npx playwright test --project=desktop` (full smoke surface) → all green except:
  `smoke.spec.ts:62` (Downloads WS live-update — the **downloads worker's actively
  in-flight UI** in this shared tree: modified `DownloadsPage/JobRow/job-status` +
  their own failing `web/test/downloads-feed.test.tsx`; not this story's scope) and
  the two load-sensitive `perf.spec.ts` virtualization budgets (pass solo — this box
  runs at load average 5-8 from concurrent board workers; deterministic on a quiet
  gate box). Every spec this story touched or added is green.
- Targeted rerun of all touched specs: **48 passed** (search-home, search, smoke:14/32,
  a11y, parity-sweep, site-picker-smoke, all-sites-search, manga-parity,
  browse-list-polish, favorites-parity, settings-parity).
- Visual (`playwright.visual.config.ts`, zero-tolerance): **20 passed, twice in a
  row** — 8 NEW fixtures (`search-home-desktop/mobile`, `palette-desktop/mobile` ×
  dark/light; seeded deterministic recents) + 12 refreshed (header palette button).
  Regenerated via the reviewed `--update-snapshots` flow.

## Gates (scoped to this story's blast radius in the shared in-flight tree)

- `tsc -b web/tsconfig.json` — no errors in any file this story touched/added.
- `eslint` on all touched/added files — clean.
- `vitest run web/test` — 188/189 (the 1 failure is the downloads worker's in-flight
  filter UI, above).
- `scripts/design-gate.sh` — OK (tokens-only styling; no new stylesheets; no raw
  color literals).
