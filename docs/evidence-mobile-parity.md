# Evidence — Mobile first-class enforcement (R3): tsk-verdant-manger-hovers

Owner ruling R3 (docs/UX-PARITY.md): mobile and desktop are EQUAL first-class
citizens — every feature works on both, layout adapts, capability does not.
This story made the ruling ENFORCEABLE in CI. All verification below ran
offline (vite dev server + fixture-driven mock API interception), serialized
(`workers: 1` — frame-budget specs need a quiet runner).

> Coalesced-tree note: the workspace hosts parallel in-flight stories
> (downloads/arrival badge work). Verification ran against an isolated
> hardlinked snapshot of the coalesced tree so the numbers below are
> attributable to THIS story's changes. One pre-existing desktop failure
> is attributed below (not this story's surface).

## 1. Responsive shell (AC1)

- `BottomTabNav` is a design-system pattern
  (`web/src/components/patterns/BottomTabNav.tsx`), mounted by the App shell
  below md (768px): fixed bottom, `--spacing-bottom-nav` band +
  `env(safe-area-inset-bottom)` (token `--spacing-safe-bottom`), exactly 5
  destinations (Browse / Favorites / Downloads / Library / Settings), icon +
  label, every target on the 44px touch token, `aria-current="page"` on the
  active route.
- Desktop (>=768px) keeps the top tab nav (`hidden md:block`); the header
  collapses to compact form below md (icon-only brand). Identical routes on
  both surfaces (unit test asserts the hash set is byte-identical; e2e taps
  each bottom destination and lands on the same routes the top tabs target).
- No layout shift on switch: `html { scroll-padding-bottom: <nav band> }`
  below md keeps every scrollIntoView clear of the fixed bar (also a real
  UX fix for anchor/focus scrolling); the e2e shell test resizes
  390 <-> 900 across the boundary and asserts the route is unchanged and
  `scrollWidth <= innerWidth` at both widths (no horizontal overflow).
- Desktop specs pass untouched — see §6.

## 2. Touch-affordance audit — R3a triggers (AC2)

`web/e2e/touch-audit.spec.ts` (mobile project, 390x844 touch) enumerates
every popover / tooltip / dialog / menu / sheet trigger across routes and
opens it by REAL TAP (tooltip by FOCUS — the hover-shaped surface's
keyboard/touch path). Results (all green, `80 passed` run):

| # | Route | Surface | Activation | Result |
|---|-------|---------|------------|--------|
| 1 | `/#/browse` | command palette (header button) | tap | OK |
| 2 | `/#/browse?sites=1` | site picker filters (FilterBar sheet) | tap | OK |
| 3 | `/#/browse?site=<id>` | entry metadata popover (row TAP — R3a core) | tap | OK |
| 4 | `/#/browse?site=<id>` | entry row overflow menu (kebab) | tap | OK |
| 5 | `/#/browse?site=<id>` | favorited-row tooltip (menu item) | focus | OK |
| 6 | `/#/manga?...` | manga page (no overlays — target-audited) | tap | OK |
| 7 | `/#/downloads` | job row overflow menu (kebab) | tap | OK |
| 8 | `/#/downloads` | delete-completed confirm dialog | tap | OK |
| 9 | `/#/favorites` | check-all scope menu | tap | OK |
| 10 | `/#/favorites` | row menu -> Transfer website dialog | tap | OK |
| 11 | `/#/favorites` | row menu -> Change save-to dialog | tap | OK |
| 12 | `/#/favorites` | import list dialog | tap | OK |

Zero hover-only affordances: the metadata popover is DUAL-ACTIVATION by
pointer class (`EntryMetadataPopover`): hover-capable pointers keep the
Radix HoverCard (desktop unchanged); `(hover: none)` surfaces open the SAME
catalog data via Radix Popover semantics on row tap, with the popover's own
Open button carrying navigation (`entry-metadata-open`). The favorited-row
tooltip's focus path is real (the disabled-item wrapper is `tabIndex={0}`).

## 3. Touch-target audit — R3b 44px floor (AC2)

The same spec walks every route state (incl. open overlays after their enter
animations settle) and asserts every visible interactive element
(button / link / input / select / menuitem / option / tab / label-wrapped
control) meets the 44px token in BOTH dimensions (0.5px tolerance).
**Zero violations.** Fixes that got there (all `max-md:`-scoped via the
`--spacing-touch-target` design token — desktop untouched):

- `ui/button.tsx` cva base floors every Button below md (min-h + min-w);
  `ui/input.tsx`, `ui/select.tsx` (trigger + items),
  `ui/dropdown-menu.tsx` (items), `ui/command.tsx` (palette items),
  `ui/dialog.tsx` + `ui/sheet.tsx` (close buttons), `NativeSelect`.
- Raw controls: filter chips (`SiteFilterChips`, `UnionSearchChips`,
  `AppliedFilterChips` remove, `JobFilters` state chips), favorites
  auto-download label, enqueue option labels, manga "Read online" link,
  brand link, TransferDialog checkbox label.
- Checkbox/radio inputs inside labels are audited through their LABEL (the
  real hit area, HIG-style); bare controls would still be caught.

## 4. Mobile e2e key flows (AC3)

`web/e2e/mobile-parity.spec.ts` — Playwright 'mobile' project:
**390x844, isMobile, hasTouch, deviceScaleFactor 3** (iPhone-13 pattern on
the Chromium engine — single-engine gate). All green:

- **picker -> entries -> popover -> manga -> enqueue (start-paused)**:
  Filters sheet (search), category chips, site open, row TAP opens the
  metadata popover (URL unchanged — the tap must NOT navigate), popover
  Open -> manga page, chapter select, `Start paused` -> Enqueue: POST body
  asserted `paused: true` and the "(paused — resume it from Downloads)"
  status renders.
- **downloads actions**: pause (running -> stopped), resume (fresh queued
  row), hold via kebab-menu Disable (resume-able hold), lift via primary
  Resume, retry (failed -> fresh queued row) — every state transition
  asserted against the stateful action matrix; mobile row anatomy asserted
  (title + secondary line, id chip hidden).
- **favorites sheet**: batch check -> NewChaptersSheet; `Add to queue`
  enqueues PAUSED jobs (both POST bodies asserted); **drag-dismiss** — the
  pointer drag past the 72px threshold closes the sheet (grabber handle,
  pointer-capture based; Close/scrim/Escape remain).
- **settings** [websites-rebuild]: facet chips tappable at 390px —
  LANGUAGE narrows the list AND lands in the URL (`?lang=`), NEEDS
  SETUP "No setup needed" hides credential sites, module search
  AND-composes; per-category bulk Disable fires exactly
  `{ enabled: false, category }` on POST /api/modules/bulk; the
  collapsed global proxy box expands IN PLACE via its header tap
  (SetProxy editor usable inside; a second tap collapses it).

## 5. Visual matrix + mobile perf (AC4)

- `web/e2e/visual.spec.ts` gains the mobile viewport column: 6 pages x 2
  themes x 2 viewports = **24 committed fixtures**
  (`web/e2e/visual/fixtures/linux/{page}-mobile-{theme}.png`), every mobile
  shot asserting the bottom-nav shell is visible before capture. Suite:
  **32/32 green** (24-matrix + search-home/palette desktop+mobile).
  `scripts/design-gate.sh` now REQUIRES the mobile column and the
  BottomTabNav pattern.
- `web/e2e/perf-mobile.spec.ts` (shared harness in `perf-helpers.ts`):
  virtualization assertions at 390x844 — bounded DOM (<100 rendered rows
  for 1200 entries / 1000 modules), jank budgets, reachable tail.
  Documented adaptations: `deviceScaleFactor 1` (the budget measures the
  data path, not the offline sandbox's 3x software raster), a 2-frame
  median bound for the emulated wheel path (under `(hover: none)`
  emulation Chromium routes WHEEL scrolls through the main thread — real
  touch scrolling composites), and a pre-recording settle drain. The
  worst-frame gate (<300ms) holds.

## 6. Desktop regression (AC7)

- Desktop project: **green** except ONE pre-existing failure with clear
  attribution: `smoke.spec.ts:62` (Downloads WS live progress) expects the
  OLD badge text `'running'` and raw JSON `{"pages":"3/40"}` in the DOM —
  both were deliberately replaced by the parallel downloads-parity story
  (their own `downloads-parity.spec.ts` asserts `data-status="downloading"`
  and NO raw JSON; `web/src/state/job-status.ts` — their in-flight edit —
  carries the label map). Updating that spec is the downloads story's
  coalescing debt, not this story's surface. This story's JobRow edits are
  className-only (mobile order utilities).
- Committed desktop fixtures: byte-stable under this story's changes. The
  refreshed desktop fixtures in this change carry ONLY the parallel
  story's nav-badge pixels (bbox analysis: all diffs localized to the
  Downloads tab area, x 553-749 / y 47-82 — none of this story's edits
  render differently at >=768px; every change is `max-md:`-scoped or
  structure-identical).
- Full-suite record (isolated snapshot, serialized): **80 passed, 1
  skipped (documented desktop-only '/' shortcut), 1 failed (the
  attributed smoke drift above)**.
- Unit tests: `web/test` green including new
  `mobile-parity.test.tsx` (dual-activation popover, BottomTabNav routes,
  drag-grabber) and the updated bootstrap-banner shell assertion (both nav
  surfaces). `web/` typecheck + eslint clean for this story's files.

## 7. Responsive data tables (AC5)

- Favorites: the tiered grid already collapses below md — verified at
  mobile viewport in the e2e flow (`.favorite-columns-meta` visible,
  `.favorite-col-website` hidden).
- Downloads: `JobRow` restructured — >=md keeps the exact pre-mobile flat
  wrapped line; <md collapses via order utilities to title (+actions) on
  line 1 and badge + progress + error as the secondary line, with the hex
  id chip hidden. Verified functionally (mobile e2e) and visually (mobile
  fixtures).

## Reproduction

```bash
npm run e2e -w @fmd/web                    # both projects (desktop + mobile 390x844 touch)
npm run e2e:visual -w @fmd/web             # 24-fixture matrix incl. bottom-nav shell
npx vitest run web/test/mobile-parity.test.tsx
bash scripts/design-gate.sh                # tokens + patterns + BOTH fixture columns
```
