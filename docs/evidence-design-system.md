# Design system foundation — evidence (tsk-fuzzy-titanium-folds)

**Scope**: adopt Tailwind CSS + shadcn/ui (CLI-vendored) + lucide-react + sonner +
@tanstack/react-virtual; CSS-variable token layer (dark default); one app shell;
pattern library; retrofit of all six pages; visual-regression lock with a
zero-threshold CI gate. **Behavior-neutral**: every existing Playwright e2e spec
passes unmodified; every unit test passes unmodified.

## Before / after

Same fixture data, same routes, same 1280×800 viewport — captured through
`scripts/capture-design-evidence.mjs` (committed; the mock API mirrors
`web/e2e/fixtures.ts`).

| Page | Before (hand-rolled `styles.css`) | After (tokens + shadcn + patterns) |
| --- | --- | --- |
| Browse | `docs/evidence-design-system-assets/before/browse.png` | `docs/evidence-design-system-assets/after/browse-dark.png` / `browse-light.png` |
| Manga | `before/manga.png` | `after/manga-dark.png` / `manga-light.png` |
| Downloads | `before/downloads.png` | `after/downloads-dark.png` / `downloads-light.png` |
| Favorites | `before/favorites.png` | `after/favorites-dark.png` / `after/favorites-light.png` |
| Library | `before/library.png` | `after/library-dark.png` / `library-light.png` |
| Settings | `before/settings.png` | `after/settings-dark.png` / `settings-light.png` |

The *before* set was captured from the pre-retrofit UI (2026-11-16, the
`styles.css` era) before any code changed; the *after* set from the retrofit.
Both sets are committed. Theme sanity (average frame luminance, browser-decoded):
dark 11–18, light 248–249 across all six pages — both palettes genuinely render.

## What landed

- **Token layer** — `web/src/styles/tokens.css`: CSS variables for
  color/surface/border/radius/spacing/typography; dark palette on `:root,.dark`
  (default), light on `.light`; mapped into Tailwind v4 via `@theme inline`
  (`--color-background`, `--color-state-running`, `--radius-lg`,
  `--container-page`, `--spacing-row`, …). No other stylesheet exists under
  `web/src` (gate-enforced).
- **Theming** — class strategy, dark default for the manga app. Resolution:
  persisted `localStorage['fmd-web-theme']` → `prefers-color-scheme` → dark.
  A pre-hydration script in `web/index.html` applies the class before first
  paint (no flash); `web/src/state/theme.tsx` owns the toggle (header button,
  Sun/Moon), persistence, and OS-change following while no choice is stored.
- **shadcn/ui vendored via CLI** — `components.json` (new-york, zinc, css
  variables) + `npx shadcn@latest add …`; 18 components committed under
  `web/src/components/ui/*` (button, input, select, command/combobox, tabs,
  dialog, badge, card, table, skeleton, tooltip, scroll-area, progress,
  dropdown-menu, checkbox, separator, sheet, sonner). Two documented
  token-only patches: `sonner.tsx` (next-themes → our ThemeProvider) and
  `badge.tsx` (`success`/`warning` variants on the semantic state tokens).
- **App shell** (`web/src/App.tsx`) — sticky header (brand + 5 primary nav
  tabs matching the router: Browse / Favorites / Downloads / Library /
  Settings; manga stays a detail route), theme toggle, one `max-w-page`
  container, sonner `<Toaster>` mounted once.
- **Patterns** (`web/src/components/patterns/`) — PageHeader, ListPanel
  (virtualized via @tanstack/react-virtual above a 100-row threshold; the
  same `role="list"` + `<li>` shape and e2e class hooks in both branches),
  EntryRow, FilterBar (collapses into the Sheet side panel below `md`),
  StatPill, EmptyState, ErrorBanner (both replace the hand-rolled
  `components/{EmptyState,ErrorBanner}.tsx`, deleted), ProgressToast
  (sonner-based; used by the Settings sync actions), NativeSelect
  (token-styled native select for the controls whose native semantics are
  pinned by e2e `selectOptions` / jest-dom `toBeChecked`).
- **Pages retrofitted** — all six pages rebuilt on the shell + patterns.
  Every pinned surface kept verbatim: texts, labels, aria attributes,
  `data-testid`s, `.job-list`/`.job-row`/`.badge`/`.job-progress`/
  `.library-row`/`.catalog-list` hooks, native selects/checkboxes where the
  specs drive them, `role="status"` regions, the enqueue dry-run preview.
- **Hand-rolled CSS deleted** — `web/src/styles.css` and the two replaced
  components are gone in this same change (anti-papering).

## Enforcement (consistency is enforced, not aspirational)

- `scripts/design-gate.sh` (CI step via `scripts/ci.sh`): tokens.css is the
  only stylesheet under `web/src`; no CSS imports outside `main.tsx`; no raw
  color literals (hex/rgb/hsl/oklch) in pages/patterns/components; the 18
  ui + 8 pattern files exist; all 12 visual fixtures are committed.
- `eslint.config.js`: `no-restricted-syntax` rule bans raw color literals in
  `web/src/pages/**`, `web/src/components/patterns/**`,
  `web/src/components/*.tsx`; the vendored `ui/` dir is exempt from
  hand-annotation rules (CLI output policy, like the generated OpenAPI types).
- **Visual regression** — `web/playwright.visual.config.ts` +
  `web/e2e/visual.spec.ts`: 6 pages × dark/light screenshots at
  **`maxDiffPixels: 0`** against committed fixtures in
  `web/e2e/visual/fixtures/linux/`. Reviewed-update flow for intentional
  changes:
  `npm run e2e:visual:update -w @fmd/web` → review the fixture diff in the
  PR → commit fixtures together with the source change.

## Verification (all run against this change)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc -b web/tsconfig.json` | clean |
| Lint (web) | `npx eslint web/src web/e2e web/test` | clean |
| Unit tests | `npx vitest run --root . web/test` | **57/57 pass, unmodified** |
| e2e smoke (unmodified specs) | `npx playwright test` (smoke.spec.ts) | **4/4 pass** |
| Keyboard-nav smoke (new) | `a11y.spec.ts` | 3/3 pass — Tab cycles brand → 5 nav tabs → theme toggle; full Browse search→submit→open-entry flow with zero mouse; toggle persists |
| Virtualization perf (new) | `perf.spec.ts` | 2/2 pass — 1200 catalog rows / 1000 site modules: DOM bounded < 100 rows (`data-index` tail reached), median frame gap < 34 ms, worst < 300 ms while scrolling |
| Visual regression | `npm run e2e:visual -w @fmd/web` | 12/12 pass at zero threshold |
| Build | `npx vite build` (web) | ok (58.9 kB CSS / 428 kB JS) |
| Design gate | `bash scripts/design-gate.sh` | OK |

Concurrent-work note: an unrelated in-flight server/ change (module-sync
tarball work) shares the checkout at commit time; it is excluded from this
story's commit, and repo-wide `tsc -b`/full-`npm test` coverage of server
code belongs to that story.

## Deliberate design decisions

- **Radix Tabs** for the Browse mode switcher (role=tab + roving-tabindex
  arrow-key navigation, as the a11y smoke exercises); **native** select /
  checkbox semantics retained wherever Playwright `selectOptions`/jest-dom
  `toBeChecked` or the combobox INDEX round-trip pin them — styled via
  `NativeSelect`/token utilities so visuals stay consistent.
- **Virtualization threshold (100 rows)**: fixture-sized lists (and jsdom unit
  tests) keep the plain DOM path; production-sized lists (454 sites, 50k+
  catalog rows, 1000+ in the perf spec) take the virtualizer. Both branches
  render identical a11y structure.
- **ProgressToast is additive**: pinned inline `role="status"` texts remain
  the source of truth the e2e suite asserts; toasts carry distinct copy
  (no strict-mode text collisions).
- **Job-state colors are semantic tokens** (`--state-queued` …
  `--state-cancelled`) consumed as utilities — badges restyle with the theme
  like everything else.
