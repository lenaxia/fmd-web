# UX-PARITY — FMD2 → fmd-web full-surface enumeration & gap matrix

Source of truth for v0.3.0 parity work. Part 1 enumerates EVERY user-facing
FMD2 feature from the Pascal source (evidence: file + control/procedure).
Part 2 inventories fmd-web as shipped at v0.2.0. Part 3 is the disposition
matrix: PARITY (replicate), ADAPT (web-native equivalent), SKIP (obsolete or
desktop-only, justified). The v0.3.0 stories implement the PARITY/ADAPT rows;
this file records the SKIPs and deferrals so nothing is silently dropped.

## Product rulings (owner, permanent — never relitigate)

- **R1 — No in-browser reader. EVER.** fmd-web is the *acquisition layer*; consumption belongs to dedicated servers (Kavita/Komga/...) fed by the library output. This is an architectural line, not a backlog item: any proposal containing a page-turner, double-tap zoom, or reading mode is rejected on principle. (Library file download links are the boundary; an OPDS/feed *export* for consumption tools is the only sanctioned direction if ever requested.)
- **R2 — No multi-user. EVER.** Single-operator, self-hosted. The single-user model is a feature (simplicity of auth, data model, and trust), not a limitation awaiting removal. No per-user queues/favorites/permissions — not "later", not behind a flag.
- **R4 — Scriptable API is a first-class surface.** The REST/WS API is a supported product, not an implementation detail. Consequences: (a) the OpenAPI snapshot is a contract — additive-first changes only (already CI-enforced); (b) a stable TOKEN auth path exists for scripts and cron — no screen-scraped session flows; (c) scripting workflows are documented (docs/API.md cookbook + user-guide link); (d) everything the UI can do is API-reachable, and it stays that way (API-only usage is a supported mode).
- **R3 — Mobile and desktop are EQUAL first-class citizens.** Every feature works on both; layout adapts, capability does not. Consequences: (a) no hover-only affordances — every popover/tooltip must have a tap/focus activation path; (b) touch targets >= 44px; (c) navigation must be thumb-reachable on mobile (bottom tab bar) — desktop top tabs are not the mobile pattern; (d) visual regression and e2e run at BOTH viewports; (e) virtualized lists scroll-tested on mobile; (f) keyboard shortcuts are desktop parity, never the only path to a feature.

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
- Tray icon + menu: Resume all / Stop all / After-download-finish (Nothing/Exit/Shutdown/Hibernate) / Drop Box / Restore / Exit (pmTray lfm:6500) [line fixed by audit].
- Single-instance bring-to-front only (md.lpr:158-172 sends 'BringToFront'; pas:2912 restores). Dark themes System/Dark/Light. [audit fix: prior 'URL forwarding' claim was wrong]

### A. Manga Info tab
- Site combo `cbSelectManga`: enabled sites by name, autocomplete, from the Options→Websites category tree (pas:6168–6200). **Categories are language groupings** (English 63, English-Scanlation 60, H-Sites 51, Spanish 39, Indonesian 36, Raw 28, Webcomics 21, Spanish-Scanlation 19, Russian 18, Portuguese 9 …).
- `btUpdateList` + right-click menu: update list / download list from server / all-at-once (pas:3791–3883).
- Title search `edMangaListSearch` (live-search is an option); mode label All/Filtered (N); filter-remove button.
- Manga list: `Title (chapters)` + `[Website]` in all-sites mode (pas:7118); **rich metadata tooltip** (pas:5161–5226); **row coloring** new-manga (jdn window) + completed (pas:5114–5152); multi-select; double-click → info.
- List context menu (pmMangaList lfm:5787) [line fixed by audit]: View info / Download all / Add to Favorites / Delete local list / Highlight-new toggle.
- **Filter sub-tab** (lfm:1451–723): 38 tri-state genre checkboxes (include/exclude/ignore + Indeterminate-all popup), custom genres with `!`-exclude, Title/Author/Artist/Summary fields, Status combo, one-of/all genres, only-new (window 1–365 days), **all-sites union** (cbSearchFromAllSites → FilterAllSites over every enabled site's DB, pas:3414), regex mode.
- Info pane: URL box + paste-and-go (Ctrl+Shift+V); cover thumbnail + loading anim; metadata rich-text; **chapter list**: per-chapter checkboxes, `0001 - Title` rows, downloaded-highlighted, context menu check/uncheck selected|all, highlight/hide downloaded, substring filter, asc/desc, Space toggles (lfm:1649–1703, pas:1939/1552/3156); actions Download / Split download / add-as-stopped / Read online / Add to favorites / Save-to with per-website override (pas:5613).

### B. Downloads tab
- Filter tree: All→Finished/InProgress/Stopped/Failed/Disabled; History→Today/Yesterday/7d/Month/6m/Older/Custom range (lfm:60–182).
- Toolbar Resume All / Stop All / Delete completed; search; live transfer-rate sparkline.
- Columns: Manga, Status, Progress (embedded colored bar, pas:4516–4592), Transfer rate, Website, Save to, Date added, Last downloaded date; header-sortable; drag/Del/Ctrl-arrow reordering.
- States: STOP/WAIT/PREPARE/DOWNLOAD/FINISH/CONVERT/COMPRESS/PROBLEM/FAILED.
- Context menu (pmDownload lfm:5533) [line fixed by audit]: Stop/Resume/Redownload/Enable/Disable; Delete task-only|+data|+favorite; Merge completed; View info; Open folder/external.

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

## Part 2 — fmd-web as shipped (v0.2.0; v0.3.0 WIP already adds manga-page actions/paused/saveTo — verify against the tree, not this snapshot)

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
| Genre tri-state include/exclude | ADAPT v0.3 (parity-sweep): implement `!`/`-` exclude prefix end-to-end (parser currently STRIPS the prefix and includes the genre — inverted semantics, audit finding (b)2); full tri-state UI v0.4 | [parity-sweep] |
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
| Check-Modules integrity UI | SKIP for v0.3 — it LIVE-EXERCISES each module (info/chapter probes, frmCheckModules.pas:16-21); badges are static flags and sync reports are file-transfer results, neither covers it. Live module smoke on demand = v0.4 candidate (live-smoke harness is the backend) | note [audit fix: prior justification was wrong] |
| Self-updater dialogs | SKIP — container/image updates (runbook) | note |
| Import from Domdomsoft | SKIP — FMD2-list import covers the real cases | note |
| Merge completed tasks | SKIP for v0.3 (one-job-per-chapter model) | note |


---

## Part 4 — Options & misc dispositions (post-audit sweep, M1–M16)

Independent audit verdict: TRUE-WITH-GAPS. Dispositions for every missed row:

| # | Feature (evidence) | Disposition |
|---|---|---|
| M1 | Sort downloads on new tasks (lfm:3028) | SKIP v0.3 — server-ordered queue; revisit with priority editing |
| M2 | Delete completed tasks on close (lfm:3018) | ADAPT [parity-sweep]: expose job-history retention (server prunes 30d) as a setting |
| M3 | Vacuum databases on exit (lfm:3038) | SKIP — server-side maintenance (runbook documents VACUUM cadence) |
| M4 | Long-path support toggle (lfm:3048) | PARITY [parity-sweep]: surface the existing FMD_NORMALIZE_PATHS flag in Settings |
| M5 | Unicode replacement rename option (lfm:3947,4183) | ADAPT [parity-sweep]: part of output-defaults itemization (server-supported subset) |
| M6 | Remove-manga-name / auto manga+chapter folder toggles (lfm:4014,3958,4026) | ADAPT [parity-sweep]: template-field toggles in output defaults |
| M7 | ImageMagick group (lfm:4455-4569) | SKIP — native binary dependency; server re-encodes internally where needed |
| M8 | Image conversion subset (WebP→X, PNG level, JPEG quality, PNG→JPEG; lfm:4332-4438) | ADAPT [parity-sweep]: default WebP→PNG/JPEG + JPEG quality (packers re-encode path); rest SKIP |
| M9 | Updates extras: skip-info-on-sync (lfm:4717), dedupe-on-update (lfm:4727), open-favorites-on-startup (lfm:4706) | SKIP all three — catalogs don't fetch info (N/A); dedupe is automatic server-side; no startup-page semantics on web |
| M10 | Connections knobs (lfm:3394-3866 incl. thread caps 3793/3806/3834) | ADAPT [parity-sweep]: Performance group with timeout / retry / parallel-chapters / threads-per-chapter; lane thread-caps SKIP (tuned defaults, env-overridable) |
| M11 | Advanced per-module grid beyond SaveTo: MaxTask/Thread/Connection limits, UpdateList threads/pages, per-module UA (WebsiteModulesSettings.pas:60-88) | v0.4 — per-module UA + connection limit are real capability; SKIP v0.3 with this note |
| M12 | About tab: version check+abort, blog, changelog tab, donate (lfm:5263,5370,5472) | ADAPT [parity-sweep]: Settings→About (version, CHANGELOG/releases link, repo link); donate SKIP |
| M13 | Log settings + frmLogger (lfm:5034-5111) | ADAPT [parity-sweep]: Settings→Diagnostics (log enable + level, link /metrics + runbook); live viewer v0.4 |
| M14 | URL-box navigation: edURL + paste-and-go + Ctrl+Shift+V (lfm:860, pas:6609) | ADAPT [parity-sweep]: open-by-URL input on Browse picker (resolves module by host via /api/info → manga page); Ctrl+Shift+V honored |
| M15 | Favorites as drag-target (pas:4924) | SKIP — explicit add-to-favorites buttons; page-wide DnD/drop-box parity = v0.4 candidate |
| M16 | Minor interactions: manga-list multi-select, middle-click site reload, combo auto-dropdown, status-bar row, splitters/persisted-window state, LuaModulesUpdater toggles (warning/auto-restart/module-debug) | Consolidated SKIP — web equivalents exist (click-navigate, URL state, sync UI) or are desktop-only; module-debug flag = env var (runbook) |

Genre tri-state / `!`-exclude and Part-2 refresh are handled by [parity-sweep]
(see Part 3 row fix above). Evidence-citation corrections applied in place.
