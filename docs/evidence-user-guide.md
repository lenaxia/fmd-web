# Evidence — User guide: every workflow documented web-natively

**Task**: tsk-fierce-beacon-speeds — docs/USER-GUIDE.md + in-app empty-state links + link-integrity CI gate.
**Date**: 2026-11-17
**Epic**: v0.3.0 — Full-UX parity (runs last; documents shipped reality)

## Deliverables

| Artifact | What it is |
|---|---|
| `docs/USER-GUIDE.md` | The canonical walkthrough: nine workflow areas (getting-started → troubleshooting), organized by WORKFLOW not by page, plus the "Coming from FMD2 desktop" habit→web-equivalent table |
| `web/src/pages/SearchHomePage.tsx` (browse picker surface), `FavoritesPage.tsx`, `DownloadsPage.tsx`, `LibraryPage.tsx` | Docs-only app-code change: one guide link per empty state (`docs/USER-GUIDE.md#finding-manga` / `#favorites-lifecycle` / `#downloading` / `#library`), each styled with `max-md:min-h-touch-target` (see R3 note below) |
| `web/test/docs-links.test.ts` | Standing CI gate (runs in `npm test` / `scripts/ci.sh`): (1) every in-app `docs/USER-GUIDE.md#anchor` href resolves to a guide heading; (2) every guide-internal `](#anchor)` link resolves; (3) every relative file link in the guide resolves to a real docs file; (4) the four empty-state surfaces keep their guide links; (5) the nine charter workflow anchors exist |
| `docs/evidence-user-guide.md` | This file — per-workflow verification method + the UX-PARITY cross-check |

## Verification method (per workflow)

Primary method for every workflow: a purpose-built **Playwright walkthrough**
(`user-guide-parity-sweep.spec.ts`, desktop project) against the **real Vite
dev server** with the repo's fixture-driven mock API (`e2e/fixtures.ts` +
stateful overlays, same interception discipline as the standing parity
specs — loopback only). Each test asserted the guide's concrete claims
(control labels, menu items, dialog wording, URL round-trips) at runtime.
The walkthrough is a verification artifact, not a committed deliverable
(the story scopes CI additions to the link-integrity gate); the full
assertion inventory per workflow is recorded below so the pass is
auditable, and the run output was captured (13/13 passed, 14.4s).

Secondary methods: source audit of every cited surface (file:line in the
table below), the standing unit suite, and the existing e2e corpus
(mobile/touch + parity specs) for the mobile-shell claims.

| # | Workflow (guide anchor) | Walkthrough assertions (all passed) | Source audit (shipped UI) |
|---|---|---|---|
| 1 | Getting started (`#getting-started`) | Banner shows `First-run bootstrap running (D20) — <stage>` while `/readyz` is 503 and disappears at 200; 5 nav tabs (header + bottom bar); Toggle theme; Open command palette buttons | `App.tsx:125` BootstrapBanner (polls /readyz), `hooks.ts:920` useBootstrapStatus; README quickstart (compose one-liner + process twin); `SettingsPage.tsx:357` first-run panel w/ Run module sync now |
| 2 | Finding manga (`#finding-manga`) | Home: idle EmptyState + category quick-chips + guide link; typed query → union rows w/ Website badge + facet chips + `across 1 site`; `q=` rode the URL. Picker: search box, paste-URL box (`Ctrl+Shift+V` hint in placeholder), clean row enabled / known-broken row disabled, typed `no_site_match` error inline. Site list: Latest/By title tabs, as-you-type → URL replace, Filters panel (Authors/Artists/Summary/Status/Match all/Any of/Custom genres `!` hint/Only-new chip + days/Reset), All sites checkbox, Highlight new, `from catalog` badge, Load more, row menu Open/Download all chapters/Add to favorites | `SearchHomePage.tsx`, `SitePickerPage.tsx` (+`OpenByUrlInput.tsx` M14), `BrowsePage.tsx` (unified browsing + auto-provision + fall-through), `CatalogFilterPanel.tsx`, `CatalogEntryRow.tsx` + `EntryMetadataPopover.tsx` (hover/tap dual activation) + `EntryRowMenu.tsx`, `SourceBadge.tsx` |
| 3 | Manga and chapters (`#manga-and-chapters`) | Metadata card labels (Alternative titles…Summary), Read online href = source URL, Add to favorites; toolbar: Filter chapters / Ascending / Hide downloaded / Invert / Select new (disabled — not favorited) / Select all / Clear / `2 shown`; Start paused + Save to (`library/<site>/<manga> (default)` placeholder); Enqueue 1 chapter → `queued (paused — resume it from Downloads)`; dry-run preview contains the exact body | `MangaPage.tsx`, `ChapterToolbar.tsx`, `EnqueueOptions.tsx` (per-manga save-to recall), `api/dry-run.ts` |
| 4 | Downloading (`#downloading`) | Event-stream line; Resume all / Pause all / Delete completed; search box; state chips (waiting/in progress/finished/stopped/failed/problem); Added window incl. custom range; downloading badge + `12/40` + `200 KiB/s` + row error; per-state primary buttons (Pause/Resume/Retry/Redownload); row menu Enable/View info/Delete job/Delete job + downloaded file; delete-confirm wording (row removed, file stays); empty state links the guide | `DownloadsPage.tsx`, `JobsToolbar.tsx`, `JobFilters.tsx`, `JobRow.tsx` (legal-action matrix `legalJobActions`), `job-status.ts` (10 status kinds), delete dialogs |
| 5 | Library (`#library`) | Row shows fileName; Download link = `/api/library/<id>/file`; empty state links the guide | `LibraryPage.tsx` (newest-first, Load more); DESIGN §7.1 layout `library/<module>/<manga>/<chapter>.<ext>` |
| 6 | Favorites lifecycle (`#favorites-lifecycle`) | Toolbar Check for new chapters → scope menu All/Enabled/Disabled; Import list; row: auto-download (checked), Check now, Remove, ⋮ menu (View manga info/Download all new/Rename/Transfer website/Change save-to/Disable/Delete); secondary line `2 chapters · FixtureSite · added … · checked … · updated —`; transfer dialog (own site excluded from targets) + valid preview testid; batch check → sheet: `New chapters found (1 title)`, `has 2 new chapters`, `auto-queued (auto-download)` badge, Download all / Add all to queue | `FavoritesPage.tsx`, `FavoritesColumns.tsx`, `NewChaptersSheet.tsx` (drag-dismiss), `TransferDialog.tsx` (preview reasons), `ImportFavoritesDialog.tsx` (JSON, FMD2 + wire field names), `SaveToDialog.tsx`, `DeleteFavoriteDialog.tsx`, `FavoritesSettingsForm.tsx` (interval 0=off, check at startup) |
| 7 | Accounts (`#accounts`) | Section heading count; card: Login valid badge (asValid), Check login / Cookies… / Remove buttons, username prefilled, password placeholder | `AccountsSection.tsx` (§5.2 status badges asValid/asInvalid/asChecking/asUnknown; one account per site) |
| 8 | Settings (`#settings`) | All 11 sections present in documented order (Proxy region, API, Performance, Job history, Filename policy, Diagnostics, About, Output defaults, Favorites checks, Accounts, Modules (2)); browser sidecar badge `off`; proxy types none/HTTP/SOCKS4/SOCKS5; format options ZIP/CBZ/PDF/EPUB; template placeholder; Favorites checks labels; Sync modules / Sync all catalogs; Diagnostics → /metrics + runbook links; About version from /healthz; module search placeholder, Select all/None, per-row enabled + Re-sync catalog + Configure → options editor (Auto-skip pages checkbox, Quality combobox, cookies hint, module proxy override) | `SettingsPage.tsx`, `ProxySettings.tsx` (sidecar badge), `ApiTokenSection.tsx`, `ParitySweepSections.tsx` (M2/M4/M10/M12/M13 groups), `OutputDefaultsForm.tsx`, `ModuleListControls.tsx`, `OptionsEditor.tsx` (combobox stores INDEX), `AccountsSection.tsx` |
| 9 | Troubleshooting (`#troubleshooting`) | Known-broken site browse → `This site is unavailable` + reason; picker row disabled with `known broken` badge; open-by-URL typed error (workflow 2); empty registry → Settings `No modules registered yet` + Run module sync now | `SiteRow.tsx` (D3 flags → disabled + reason), `BrowsePage.tsx:298`, `SettingsPage.tsx:353`, `runbook.md` (health/logs/troubleshooting), Diagnostics links |

**Walkthrough run**: `npx playwright test user-guide-parity-sweep --project=desktop`
→ `13 passed (14.4s)` (2026-11-17, log captured; includes both empty-state
variants for downloads/favorites/library/browse home and the four guide
links).

**Mobile claims** (bottom tab bar, tap-activated metadata popovers,
drag-dismissable sheet, touch-target floor): verified by the standing
mobile suites — `touch-audit` (22/22 after the fix below), `mobile-parity`,
`search-home` mobile project (31 passed in the same session).

### R3 note (the audits work)

The first version of the empty-state links rendered as 16px-tall inline
anchors — the mobile **touch-target audit failed** (`R3b 44px floor`,
`/#/browse`). Fixed with the codebase pattern
(`max-md:inline-flex max-md:min-h-touch-target max-md:items-center`); the
audit re-ran green. No hover-only or tap-only affordance was introduced.

## Cross-check — UX-PARITY matrix vs guide coverage

Every shipped surface in `docs/UX-PARITY.md` Part 2 (v0.3.0-complete
snapshot), the PARITY/ADAPT rows of Part 3, the IMPLEMENTED rows of
Part 4 (M-list), and Part 5 (arrival) maps to a guide workflow. No guide
claim lacks a shipped surface (source column above; every row was also
seen at runtime by the walkthrough or is an environment/URL fact asserted
by the standing suites).

| UX-PARITY surface | Guide section |
|---|---|
| Hash-routed shell, dark/light toggle, bootstrap banner, toasts | Getting started |
| Site picker (category chips `?cats=`, search, capability badges, catalog chips) | Finding manga → Pick a site |
| Open-by-URL paste-and-go incl. Ctrl+Shift+V (M14) | Finding manga → Pick a site |
| Unified browsing w/ muted source badge; latest/by-title; as-you-type + mode label | Finding manga → Browse one site's list |
| Filter panel (authors/artists/summary/status, genres any/all, custom genres `!`/`-` exclude, only-new window) | Finding manga → The filter panel |
| All-sites union (Website badges, per-site chips, warning/excluded chips) | Finding manga (home + All sites checkbox) |
| Metadata popover (hover/tap, catalog data only); row menu (Open/Download all/Add to favorites); row accents + highlight-new toggle | Finding manga → Reading a row |
| Manga info card, cover, Read online, Add to favorites (manga-page-parity) | Manga and chapters |
| Chapter toolbar (filter/asc-desc/hide-downloaded/invert/select-new/select-all/clear) | Manga and chapters → Choosing chapters |
| Enqueue options (start paused, save-to + per-manga recall) + dry-run preview | Manga and chapters → Enqueue options |
| Downloads: progress bar, statuses, rate, cancel/resume/retry/redownload, enable/disable, delete +data, bulk ops, filters (chips + date window + custom range), search, WS status/backfill | Downloading |
| Downloads nav badge + completion dot + toasts (arrival) | Getting started + Downloading |
| Library: packed archives, download links, Load more | Library |
| Favorites: create (page + row menu), columns, batch check scopes + cancel, import (JSON, FMD2/wire names), transfer website (preview + clear-list), rename, enable/disable, save-to, delete confirm, auto-download, new-chapter sheet (Download/Add to queue/Dismiss + all-variants + auto-queued badge, drag-dismiss) | Favorites lifecycle |
| Favorites scheduler settings (interval 0=off, startup check) | Favorites lifecycle → Scheduled checks (+ Settings) |
| Accounts (cards, status badges, cookies link-out, remove) | Accounts |
| Settings: proxy + browser sidecar badge; API token (reveal/copy/regenerate, env-pinned); module registry (search, global + per-category bulk, enable, per-module options incl. combobox-by-position, cookies, per-module proxy, re-sync catalog); output defaults (format/template/padding/remove-name/unicode); Performance; Job history retention; Filename policy; Diagnostics (log level, /metrics, runbook); About (version, install, links) | Settings |
| First-run bootstrap (D20), /readyz, manual re-sync panel | Getting started (+ Troubleshooting) |
| Known-broken badges (picker + browse), sync failure reports, open-by-URL typed errors, WS reconnect/backfill, logs/metrics pointers | Troubleshooting |
| While-you-were-away summary; PWA installability (About + iOS path) | Getting started |
| R4 API-first (single token, docs/API.md cookbook) | Getting started + Settings (+ guide header links API.md) |
| R3 mobile equality (bottom nav, tap popovers, sheets, 44px floor) | Getting started, Finding manga, Favorites lifecycle (+ Coming-from-FMD2 keyboard note) |

SKIP rows (Part 3/Part 4) are correctly NOT documented as features: no
in-app reader (R1 — stated as a deliberate boundary in Library and
Manga), no drag-reorder, no Drop Box/drag-onto-page (the Coming-from-FMD2
row says "page-wide drag-and-drop is not shipped"), no multi-user, no
i18n, no tray/sparkline/merge-completed. The FMD2-desktop table documents
only web equivalents that exist.

## Gates run (final state)

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean (strict TS untouched — app-code diff is 4 empty-state links) |
| `npm test` (full unit + integration suite, incl. `web/test/docs-links.test.ts`) | 197 files, 2030 passed / 3 pre-existing skips |
| Playwright walkthrough (9 workflows, 13 tests) | 13 passed |
| Mobile `touch-audit` (R3a/R3b) | 22 passed (after the touch-target fix) |

Runtime-resolution note: the empty-state hrefs are repo-relative
(`docs/USER-GUIDE.md#anchor`) per the story contract; the CI gate asserts
their integrity against the repository tree (the container image serves
the SPA only, so the href resolves where the docs tree is served
alongside — dev checkout / repo hosting).
