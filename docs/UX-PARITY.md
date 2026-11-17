# UX-PARITY — FMD2 → fmd-web full-surface enumeration & gap matrix

Source of truth for v0.3.0 parity work. Part 1 enumerates EVERY user-facing
FMD2 feature from the Pascal source (evidence: file + control/procedure).
Part 2 inventories fmd-web as shipped at v0.2.0. Part 3 is the disposition
matrix: PARITY (replicate), ADAPT (web-native equivalent), SKIP (obsolete or
desktop-only, justified). The v0.3.0 stories implement the PARITY/ADAPT rows;
this file records the SKIPs and deferrals so nothing is silently dropped.

Adaptation principle (owner ruling): features follow **web design patterns,
never blind desktop replication** — hover popovers not native tooltips,
bottom sheets not modal dialogs, toasts not balloon hints, URL-synced
shareable state not dialog state, chips/facets not tree controls, virtualized
lists, keyboard + a11y via Radix primitives.

---

## Part 1 — FMD2 UX inventory (evidence-backed)

### Shell
- 5 tabs: Downloads / Manga Info / Favorites / Options / About (`pcMain` frmMain.lfm:16–1505); draggable persisted splitters.
- Status bar: "Selected: N" (pas:5073), background-loader status (uSilentThread.pas:250), right-click Abort.
- Tray icon + menu: Resume all / Stop all / After-download-finish (Nothing/Exit/Shutdown/Hibernate) / Drop Box / Restore / Exit (pmTray lfm:2495).
- Single-instance forwarding of opened URLs (pas:2912). Dark themes System/Dark/Light.

### A. Manga Info tab
- Site combo `cbSelectManga`: enabled sites by name, autocomplete, from the Options→Websites category tree (pas:6168–6200). **Categories are language groupings** (English 63, English-Scanlation 60, H-Sites 51, Spanish 39, Indonesian 36, Raw 28, Webcomics 21, Spanish-Scanlation 19, Russian 18, Portuguese 9 …).
- `btUpdateList` + right-click menu: update list / download list from server / all-at-once (pas:3791–3883).
- Title search `edMangaListSearch` (live-search is an option); mode label All/Filtered (N); filter-remove button.
- Manga list: `Title (chapters)` + `[Website]` in all-sites mode (pas:7118); **rich metadata tooltip** (pas:5161–5226); **row coloring** new-manga (jdn window) + completed (pas:5114–5152); multi-select; double-click → info.
- List context menu (pmMangaList lfm:1812): View info / Download all / Add to Favorites / Delete local list / Highlight-new toggle.
- **Filter sub-tab** (lfm:1451–723): 38 tri-state genre checkboxes (include/exclude/ignore + Indeterminate-all popup), custom genres with `!`-exclude, Title/Author/Artist/Summary fields, Status combo, one-of/all genres, only-new (window 1–365 days), **all-sites union** (cbSearchFromAllSites → FilterAllSites over every enabled site's DB, pas:3414), regex mode.
- Info pane: URL box + paste-and-go (Ctrl+Shift+V); cover thumbnail + loading anim; metadata rich-text; **chapter list**: per-chapter checkboxes, `0001 - Title` rows, downloaded-highlighted, context menu check/uncheck selected|all, highlight/hide downloaded, substring filter, asc/desc, Space toggles (lfm:1649–1703, pas:1939/1552/3156); actions Download / Split download / add-as-stopped / Read online / Add to favorites / Save-to with per-website override (pas:5613).

### B. Downloads tab
- Filter tree: All→Finished/InProgress/Stopped/Failed/Disabled; History→Today/Yesterday/7d/Month/6m/Older/Custom range (lfm:60–182).
- Toolbar Resume All / Stop All / Delete completed; search; live transfer-rate sparkline.
- Columns: Manga, Status, Progress (embedded colored bar, pas:4516–4592), Transfer rate, Website, Save to, Date added, Last downloaded date; header-sortable; drag/Del/Ctrl-arrow reordering.
- States: STOP/WAIT/PREPARE/DOWNLOAD/FINISH/CONVERT/COMPRESS/PROBLEM/FAILED.
- Context menu (pmDownload lfm:1564): Stop/Resume/Redownload/Enable/Disable; Delete task-only|+data|+favorite; Merge completed; View info; Open folder/external.

### C. Favorites tab
- Columns: #, Title, Current chapter, Website, Status, Save to, Date added, Last checked, Last updated.
- Toolbar: Import list; Check for new chapter (morphs to Checking…+cancel, scope All/Enabled/Disabled); search.
- Context menu: check/missing/stop, enable/disable, view info, download all, rename, **transfer website**, delete, change save-to (batch), open folder, persisted default action.
- frmNewChapter modal after checks: per-favorite "N new chapters" → Download/Add to queue/Cancel; auto-download variant; completed-removal and missing-chapter variants.
- Automation: startup check, interval 1–1440 min, auto-download, auto-remove completed.

### D. Dialogs
frmNewChapter, frmUpdateDialog, frmDropTarget (floating drop box, mode download/favorite, opacity), frmShutdownCounter, frmImportFavorites (FMD/Domdomsoft), frmTransferFavorites (target site + valid/invalid + clear-reload), frmSelectDirectory, frmAccountManager/Set (per-site accounts + refresh state), frmWebsiteSelection, frmWebsiteSettings (searchable site list + per-module option grid + override SaveTo), frmLogger, frmCheckModules (integrity checker), frmLuaModulesUpdater, frmCustomColor, frmWebsiteOptionCustom.

### E. Options
General (UI language 12 locales; after-download action; theme; new-manga window; tray/one-instance/live-search toggles; external program) · View (toolbars, Drop Box, covers, tab auto-switch) · Connections (timeout, proxy HTTP/SOCKS4/5 + auth, UA, retries, threads per task 1–32, parallel tasks 1–8, thread caps) · Save-to (format None/ZIP/CBZ/PDF/EPUB + PDF quality; rename templates %WEBSITE% %MANGA% %CHAPTER% %NUMBERING% %FILENAME% etc.; digits; image conversion WebP/PNG/JPEG) · Updates (favorites startup/interval/auto-download/auto-remove) · Dialogs confirmations · Websites (category checkbox tree + counts + select-all, Accounts, per-module Options grid, Modules updater, Check Modules) · Misc (colors, log) · About.

### F. Other
Keyboard (Ctrl+Shift+V/C, Space, Del, Ctrl-arrows, combo autocomplete); drag-drop (Drop Box, downloads reorder); .po localization; window/column/splitter/filter state persisted.

---

## Part 2 — fmd-web as shipped (v0.2.0)

- Shell: hash-routed SPA (browse/manga/downloads/favorites/library/settings), dark/light toggle, bootstrap banner, toasts.
- Browse: site picker (enabled modules, category headers + counts, search incl. category text, capability badges, catalog chips; **no category facet filter**); auto-provision w/ WS progress; "Browse live instead" offer + live badge (**internal-mode terminology — being removed**); latest/by-title tabs; as-you-type search + mode label; filter panel (authors, status, genres any/all binary, custom genres, only-new w/ editable days); all-sites union (q only, Website badges, per-site chips).
- Manga: info card (no cover), chapter checkboxes + select-all/clear only, enqueue + dry-run preview. **No read-online, favorite, save-to, paused, chapter toolbar.**
- Downloads: job list, state dropdown, per-job cancel, raw-JSON progress. **No task actions, bulk ops, filters, search, progress rendering.**
- Favorites: auto-download checkbox, check-now, remove, new-chapter badge. **No create-from-UI (hooks exist unused), columns, batch check, sheet, transfer, import UI.**
- Library: packed files, download links.
- Settings: sync buttons + tolerated-failure report; global proxy + sidecar badge; module registry (enable, options editor incl. combobox index, cookies, per-module proxy). **No accounts UI (API exists), no module search, no bulk category, no output defaults.**
- API ahead of UI: accounts CRUD+login, favorites import, per-module options — all server-ready.

---

## Part 3 — Disposition matrix (v0.3.0 scope)

PARITY/ADAPT rows map to stories (keys in brackets); SKIP rows are final
decisions recorded here.

| Area | Disposition | Story / note |
|---|---|---|
| Language/category site filtering | ADAPT chips+counts, URL-synced | [language-filter-browsing] |
| Live-vs-scrape terminology | ADAPT unified browsing, muted source badge | [language-filter-browsing] |
| Metadata tooltip | ADAPT HoverCard popover (catalog data, no fetch) | [browse-list-polish] |
| New/completed row coloring | ADAPT badges/accents + highlight-new toggle | [browse-list-polish] |
| Row context (download-all/favorite/delete) | PARITY row menu; delete-local-list **deferred** (destructive; revisit with a confirm+undo pattern) | [browse-list-polish] |
| Cover / read-online / add-to-favorites / save-to / add-as-stopped | PARITY | [manga-page-parity] |
| Chapter toolbar (invert/select-new/hide-downloaded/asc-desc/filter) | PARITY (select-all/clear exist) | [manga-page-parity] |
| Filter artist + summary fields | PARITY (LIKE params) | [settings-parity] |
| Genre tri-state include/exclude | ADAPT deferred to v0.4 (exclude via `!` custom genres works today) | note |
| Regex title filter | SKIP (FTS supersedes; power path) | note |
| Downloads task actions / bulk / filters / search / progress bar | PARITY (ADAPT: chips not tree; one job = one chapter) | [downloads-parity] |
| Downloads drag-reorder | SKIP for v0.3 — server-ordered queue; revisit if priority editing lands | [downloads-parity] note |
| Transfer-rate sparkline | ADAPT deferred (WS rate field shipped; chart v0.4) | [downloads-parity] note |
| Favorites columns / batch check + scopes / new-chapter batch decision / transfer / import / rename / enable / save-to / download-all | PARITY (ADAPT: sheet not modal) | [favorites-parity] |
| Accounts UI | PARITY (API exists) | [settings-parity] |
| Module search + bulk category enable + select-all | PARITY | [settings-parity] |
| Per-site re-sync catalog | PARITY button | [settings-parity] |
| Output defaults (format/PDF quality/templates) | PARITY for server-supported subset; rest documented deferred | [settings-parity] |
| UI language (12 locales) | SKIP for v0.3 — web i18n is its own epic (framework + extraction); not a parity bolt-on | note |
| Tray icon / Drop Box / shutdown-counter / hibernate | SKIP — desktop concepts; web equivalents: toasts, drag-onto-page (v0.4 candidate), server keeps running | note |
| External program opening / open-folder | ADAPT — Library download links (exists); folder semantics differ server-side | note |
| Split download | SKIP — superseded by chapter selection + paused enqueue | note |
| Custom colors | SKIP — design tokens own theming (light/dark) | note |
| Check-Modules integrity UI | SKIP — known-broken capability badges + sync failure reports cover it | note |
| Self-updater dialogs | SKIP — container/image updates (runbook) | note |
| Import from Domdomsoft | SKIP — FMD2-list import covers the real cases | note |
| Merge completed tasks | SKIP for v0.3 (one-job-per-chapter model) | note |
