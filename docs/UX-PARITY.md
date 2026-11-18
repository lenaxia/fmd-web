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
- **R4 — Scriptable API is a first-class surface.** The REST/WS API is a supported product, not an implementation detail. Consequences: (a) the OpenAPI snapshot is a contract — additive-first changes only (already CI-enforced); (b) auth is a SINGLE app-wide API token, Sonarr/Radarr-style: settings-managed, shown in Settings (copy + regenerate), auto-generated on first run, optionally pinned via FMD_WEB_API_TOKEN env for headless deployments — and NEVER multiple tokens, token lists, per-user or per-scope tokens (consistent with R2); no screen-scraped session flows; (c) scripting workflows are documented (docs/API.md cookbook + user-guide link); (d) everything the UI can do is API-reachable, and it stays that way (API-only usage is a supported mode).
- **R3 — Mobile and desktop are EQUAL first-class citizens.** Every feature works on both; layout adapts, capability does not. Consequences: (a) no hover-only affordances — every popover/tooltip must have a tap/focus activation path; (b) touch targets >= 44px; (c) navigation must be thumb-reachable on mobile (bottom tab bar) — desktop top tabs are not the mobile pattern; (d) visual regression and e2e run at BOTH viewports; (e) virtualized lists scroll-tested on mobile; (f) keyboard shortcuts are desktop parity, never the only path to a feature.

- **R5 — Web-native is the design AUTHORITY (owner license).** FMD2 parity is a reference, not a constraint: when a web-native pattern improves a workflow, it REPLACES the FMD2 pattern — no parity justification required. Domain semantics users rely on (browse/search/download/favorites meaning) keep parity by default; information architecture, interaction models, chrome, and workflow sequencing are ours to redesign. Any workflow may be updated or improved as necessary.

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

## Part 2 — fmd-web as shipped (v0.3.0-complete snapshot, refreshed by [parity-sweep])

- Shell: hash-routed SPA (browse/manga/downloads/favorites/library/settings), dark/light toggle, bootstrap banner, toasts.
- Browse: site picker (enabled modules, category facet chips ?cats= URL-synced, search incl. category text, capability badges, catalog chips, open-by-URL paste-and-go incl. Ctrl+Shift+V [parity-sweep M14]); auto-provision w/ WS progress; unified browsing w/ muted source badge; latest/by-title tabs; as-you-type search + mode label; filter panel (authors, artists, summary, status, genres any/all binary, custom genres with the `!`/`-` EXCLUDE grammar — excluded chips render struck-through [parity-sweep, audit (b)2 fixed], only-new w/ editable days); all-sites union (filters + Website badges, per-site chips).
- Manga: info card (no cover), chapter checkboxes + select-all/clear only, enqueue + dry-run preview. **No read-online, favorite, save-to, paused, chapter toolbar.**
- Downloads: job list, state dropdown, per-job cancel, raw-JSON progress. **No task actions, bulk ops, filters, search, progress rendering.**
- Favorites: auto-download checkbox, check-now, remove, new-chapter badge. **No create-from-UI (hooks exist unused), columns, batch check, sheet, transfer, import UI.**
- Library: packed files, download links.
- Settings: sync buttons + tolerated-failure report; global proxy collapsed into a one-line summary + drawer (sidecar badge stays at a glance — [websites-rebuild]); Websites = FACETED registry view (LANGUAGE chips from FMD2 categories with the -Scanlation suffix collapsed, H-STATUS, NEEDS SETUP from AccountSupport, all with live counts + text search; URL-synced ?q/&lang/&h/&setup, chips push / typing replaces, back-nav restores; client-side (category,name) sort = ONE header per category with true counts — the v0.3.0 registration-order grouping split languages into "English (1)" shards); global Enable/Disable-all scoped to the current filtered selection (ids[] write) with confirm on disable + per-category bulk headers; module rows (enable, options editor incl. combobox index, cookies, per-module proxy); per-site re-sync catalog row action; accounts cards for enabled AccountSupport sites (save/remove/check-login, §5.2 status badge); output defaults (format + rename template + the itemized rename subset: unicode replacement + char, digit padding, remove-manga-name); Performance (timeout/retry/parallel-chapters/threads-per-chapter); Job-history retention (days + keep-forever); Filename policy (Linux-normalized checkbox, env-overridable); Diagnostics (log enable + level, /metrics + runbook links); About (server version via /healthz, releases/changelog/repo links) — all [parity-sweep] unless noted.
- API ahead of UI: none of the M-list remains unwired; favorites import/transfer UI = [favorites-parity] scope.

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
| Row context (download-all/favorite/delete) | PARITY row menu; delete-local-list **deferred from v1** (shipped 3-item menu: Open / Download all chapters / Add to favorites — destructive server-side data needs a confirm+undo pattern first; revisit with the favorites-parity delete work) | [browse-list-polish] |
| Cover / read-online / add-to-favorites / save-to / add-as-stopped | PARITY | [manga-page-parity] |
| Chapter toolbar (invert/select-new/hide-downloaded/asc-desc/filter) | PARITY (select-all/clear exist) | [manga-page-parity] |
| Filter artist + summary fields | PARITY (LIKE params) | [settings-parity] |
| Genre tri-state include/exclude | LANDED [parity-sweep]: `!`/`-` exclude prefix works end-to-end (parser → state → genresExclude[] NOT LIKE SQL composing with any/all — the audit (b)2 inverted-include defect is fixed with a regression test); excluded chips render struck-through; URL round-trips both lists. The v0.4 note is now ONLY about the per-genre tri-state checkbox UI (3-state toggle per fixed genre) | [parity-sweep] |
| Regex title filter | SKIP (FTS supersedes; power path) | note |
| Downloads task actions / bulk / filters / search / progress bar | PARITY (ADAPT: chips not tree; one job = one chapter) | [downloads-parity] |
| Downloads drag-reorder (DragDrop/Del/Ctrl-arrows, pas) | INTENTIONALLY-DIFFERENT — SKIP for v0.3: queue priority is SERVER-ordered (claim = `priority DESC, id ASC`), a client-side drag would lie about execution order; the jobs list stays stable-ordered (no jumping) via the existing keyset cursor pagination. Revisit if priority editing lands as an API | [downloads-parity] note |
| Transfer-rate sparkline | ADAPT deferred (WS rate field shipped; chart v0.4) | [downloads-parity] note |
| Favorites columns / batch check + scopes / new-chapter batch decision / transfer / import / rename / enable / save-to / download-all | PARITY (ADAPT: sheet not modal) | [favorites-parity] |
| Accounts UI | PARITY (API exists) | [settings-parity] |
| Module search + bulk category enable + select-all | PARITY | [settings-parity] |
| Per-site re-sync catalog | PARITY button | [settings-parity] |
| Output defaults (format/PDF quality/templates) | PARITY for server-supported subset; rest documented deferred — **[settings-parity] wired: format zip/cbz/pdf/epub + %CR% chapter rename template + PDF-quality/'None'-format DEFERRED (D16 packer is DCT passthrough — no re-encode; the §7.1 library model is one packed artifact); digitPadding/removeMangaName/unicodeReplacement toggles wired via [parity-sweep] M5/M6/M8 merge** | [settings-parity] |
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
| M2 | Delete completed tasks on close (lfm:3018) | IMPLEMENTED [parity-sweep]: Settings→Job history — 'Auto-delete finished job history after N days' + keep-forever (0); PUT /api/settings/retention drives an hourly prune sweep (previously NOTHING scheduled pruneRetention — the sweep is new); fake-clock tested |
| M3 | Vacuum databases on exit (lfm:3038) | SKIP — server-side maintenance (runbook documents VACUUM cadence) |
| M4 | Long-path support toggle (lfm:3048) | IMPLEMENTED [parity-sweep]: Settings→Filename policy checkbox (Linux-normalized vs FMD2-desktop-parity); precedence env > setting > parity documented + composed in assembly; both modes behavior-tested |
| M5 | Unicode replacement rename option (lfm:3947,4183) | IMPLEMENTED [parity-sweep]: output-defaults unicodeReplacement toggle + replacement char; applied at chapter-filename resolution (non-ASCII runs collapse to the char); honored-in-finalize tested |
| M6 | Remove-manga-name / auto manga+chapter folder toggles (lfm:4014,3958,4026) | SPLIT [parity-sweep]: removeMangaName IMPLEMENTED (strips a leading manga-title prefix from the chapter filename); auto manga/chapter FOLDER toggles SKIP — the §7.1 library layout is fixed-depth `library/<module>/<manga>/<chapter>.<ext>` by design (edSaveTo custom directories already cover custom paths) |
| M7 | ImageMagick group (lfm:4455-4569) | SKIP — native binary dependency; server re-encodes internally where needed |
| M8 | Image conversion subset (WebP→X, PNG level, JPEG quality, PNG→JPEG; lfm:4332-4438) | SPLIT [parity-sweep]: digitPadding IMPLEMENTED (lfm:4026 numbering digits — minimum page-name width in archives); WebP target + JPEG quality SKIP — the packers store pages as downloaded (the re-encode recovery exists only as a typed error HINT; no offline WebP decoder ships server-side and the chromium bridge is antibot-scoped, too heavy per page) |
| M9 | Updates extras: skip-info-on-sync (lfm:4717), dedupe-on-update (lfm:4727), open-favorites-on-startup (lfm:4706) | SKIP all three — catalogs don't fetch info (N/A); dedupe is automatic server-side; no startup-page semantics on web |
| M10 | Connections knobs (lfm:3394-3866 incl. thread caps 3793/3806/3834) | IMPLEMENTED [parity-sweep]: Settings→Performance — request timeout (seeds the HTTP pipeline default, real-pipeline tested), retry count (per-image budget), threads-per-chapter (image-worker width), parallel chapters (lane slots — documented restart-to-apply, lane-options tested); lane thread-caps remain SKIP (tuned defaults, env-overridable); UA string + proxy already shipped earlier |
| M11 | Advanced per-module grid beyond SaveTo: MaxTask/Thread/Connection limits, UpdateList threads/pages, per-module UA (WebsiteModulesSettings.pas:60-88) | v0.4 — per-module UA + connection limit are real capability; SKIP v0.3 with this note |
| M12 | About tab: version check+abort, blog, changelog tab, donate (lfm:5263,5370,5472) | IMPLEMENTED [parity-sweep]: Settings→About — server version (live /healthz payload), links to CHANGELOG.md, GitHub releases, repo; donate + blog SKIP (no donation channel/blog for this deployment); version-check-and-abort SKIP (container/image updates — runbook) |
| M13 | Log settings + frmLogger (lfm:5034-5111) | IMPLEMENTED [parity-sweep]: Settings→Diagnostics — structured-log enable + minimum level applied LIVE to the running logger (behavior-tested); links to /metrics + the operations runbook; live log viewer deferred v0.4 (noted in the UI) |
| M14 | URL-box navigation: edURL + paste-and-go + Ctrl+Shift+V (lfm:860, pas:6609) | IMPLEMENTED [parity-sweep]: 'Paste a manga URL…' input on the Browse picker — POST /api/info url-only resolves the module by RootURL host (case/port-insensitive; unknown host → typed 400 no_site_match 'no site matches this URL', ambiguous → 400 ambiguous_site naming candidates), navigates to the manga page carrying the RESOLVED moduleId; Ctrl+Shift+V paste-and-go honored; Playwright-covered |
| M15 | Favorites as drag-target (pas:4924) | SKIP — explicit add-to-favorites buttons; page-wide DnD/drop-box parity = v0.4 candidate |
| M16 | Minor interactions: manga-list multi-select, middle-click site reload, combo auto-dropdown, status-bar row, splitters/persisted-window state, LuaModulesUpdater toggles (warning/auto-restart/module-debug) | Consolidated SKIP — web equivalents exist (click-navigate, URL state, sync UI) or are desktop-only; module-debug flag = env var (runbook) |

[parity-sweep] post-landing: the `!`-exclude defect is FIXED (Part 3 row),
Part 2 reflects the v0.3.0-complete tree, and every M1–M16 row above carries
its landed status (IMPLEMENTED / SPLIT / SKIP-with-reason) — zero
'undocumented' rows remain. Self-check against the audit's M-list: M1 SKIP,
M2 ✓, M3 SKIP, M4 ✓, M5 ✓, M6 split (✓ + SKIP), M7 SKIP, M8 split (✓ + SKIP),
M9 SKIP, M10 ✓ (+SKIP caps), M11 v0.4 note, M12 ✓ (+SKIPs), M13 ✓, M14 ✓,
M15 SKIP, M16 consolidated SKIP. Evidence: docs/evidence-parity-sweep.md.

## Part 5 — R5 web-native arrival (tsk-insular-verdict-ambles)

The R5 ruling makes web-native an design authority: the arrival workflow is
REDESIGNED, not ported. FMD2 is a desktop app that is always-in-front (its
queue works only while it runs); fmd-web's queue works while you are GONE —
so the app's job on your return is to TELL you what happened.

| Surface | Disposition |
|---|---|
| 'While you were away' summary | IMPLEMENTED [arrival]: landing view renders a dismissible card when the previous visit (localStorage stamp, rewritten each visit) is >= 1 h stale AND there is news — chapters FINISHED since (GET /api/jobs?state=done&since=… grouped per manga, deep-linked to the manga page) + favorites with checks-since-and-new-chapters (additive `newsSince` on GET /api/favorites?since=…, deep-linked to Favorites). 'Nothing new' renders nothing. Dismissal persists per NEWS BATCH (id = newest item timestamp) — the same batch never nags twice. |
| Downloads nav activity badge | IMPLEMENTED [arrival]: running+queued count on the Downloads destination — desktop top tabs AND the mobile bottom bar (R3). WS-driven (the ONE app-level /ws feed; a resync/reconnect invalidates the count query — backfill-safe, never polled). Completion while the app is open = sonner toast + a dot that clears when Downloads is visited. |
| PWA installability | IMPLEMENTED [arrival]: web app manifest (name/short_name, standalone display, theme/background from the design tokens' dark palette #09090b, icons 192/512 any + maskable from the brand book-open-text glyph) linked from the SPA shell; iOS meta (apple-touch-icon, apple-mobile-web-app-*) for the share-sheet path; `beforeinstallprompt` captured so 'Install app' surfaces in Settings -> About AND the command palette — only when the browser actually offers it. |
| Offline service worker | Documented SKIP — fmd-web is a server-dependent app (search/downloads/library ALL talk to the container); an offline shell would be a lie. The manifest is for INSTALLABILITY (home-screen icon, standalone window), not offline. v0.4 candidate only if a real offline story (library cache for read-later) is ruled in. |
| Web Push / notification permissions | SKIP — v0.4 candidate pending a push-service decision; the away summary covers the return-visit story without permissions friction. |

Install platform quirks (the reason the surfaces are availability-gated):

- Chrome/Edge desktop + Android: `beforeinstallprompt` fires when the UA's
  installability criteria pass (manifest + HTTPS + engagement) — our Install
  actions appear. After a prompt (accept OR dismiss) the browser enters its
  own re-offer cooldown; the captured event is single-use, so the actions
  hide again until the next event.
- iOS Safari (all versions to date): NEVER fires `beforeinstallprompt` —
  install is Share -> Add to Home Screen. That path is served by the
  apple-touch-icon + apple-mobile-web-app meta; our Install actions stay
  hidden (rendering a dead button there would be worse than none).
- Firefox / Safari desktop: no install prompt event — surfaces hidden.

Icons are generated deterministically from the design tokens
(`node scripts/gen-pwa-icons.mjs` — Playwright rasterizes the lucide
book-open-text paths; maskable variants keep the glyph inside the 80 % safe
zone). Evidence: docs/evidence-arrival-experience.md.
