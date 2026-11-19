# FMD Web — User guide

One canonical walkthrough of every fmd-web workflow, written for the web app
as shipped — not a ported desktop manual. Every view state lives in the URL,
so you can bookmark, share, or reload any screen described here.

> Looking for the operator/infrastructure side (backups, pins, tokens,
> metrics)? That is the [runbook](runbook.md). Scripting the app instead of
> clicking it? That is the [API cookbook](API.md).

## Contents

- [Getting started](#getting-started)
- [Finding manga](#finding-manga)
- [Manga and chapters](#manga-and-chapters)
- [Downloading](#downloading)
- [Library](#library)
- [Favorites lifecycle](#favorites-lifecycle)
- [Accounts](#accounts)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Coming from FMD2 desktop](#coming-from-fmd2-desktop)

## Getting started

### Run the app

The one-liner (Docker):

```sh
docker compose -f docker/compose.yml up --build
```

The stack builds the image and serves the web app on `http://localhost:3000`.
Without Docker, the process twin is the same app:

```sh
npm install
npm run build && npm run build -w @fmd/web
PORT=3000 FMD_STATIC_DIR=web/dist-web FMD_WEB_DATA_DIR=./data \
  node server/dist/src/runtime-entry.js
```

### First-run bootstrap (D20)

On the very first boot (empty data directory) the server syncs the FMD2 Lua
module tree and the FMD2-DB catalogs by itself — you do not click anything.

- While that runs, a **progress banner** sits under the header:
  `First-run bootstrap running (D20) — <stage>`, updating as stages complete.
- **`/readyz`** is the readiness endpoint: it returns `503` until bootstrap
  finishes, then `200`. The banner polls it and disappears when ready.
  (`/healthz` is the separate "process is up" check — it answers from boot.)
- If the module registry is still empty afterwards, **Settings** shows a
  first-run panel with a **Run module sync now** button and live progress —
  same sync, triggered manually.

The first time you *open* a site that has no catalog yet, the app prepares it
automatically ("Preparing <site>…", cancellable) — see
[Finding manga](#finding-manga). This per-site preparation is one-time; an
installed catalog opens instantly afterwards.

### Find your way around

- **Top tabs** (desktop) / **bottom tab bar** (mobile): Browse · Favorites ·
  Downloads · Library · Settings.
- **Browse** is the search-first home. Press `/` anywhere to jump into its
  search box; press `Cmd/Ctrl+K` (or the header Search button) for the
  command palette — pages, sites and recent manga in one list.
- **Dark/light theme** toggle lives in the header.
- The **Downloads tab carries a live badge** with the running+queued count,
  and a dot when something finished while you were elsewhere; visiting the
  page clears the dot. If you leave and come back an hour later, the Browse
  home shows a dismissible **"While you were away"** card summarizing
  finished chapters and favorites news since your last visit.
- You can install the app as a **PWA**: Settings → About shows an
  **Install app** button when your browser offers it (Chrome/Edge desktop and
  Android); on iOS Safari use Share → Add to Home Screen.
- The API is script-friendly: a single app-wide **API token** is
  auto-generated on first run and manageable under Settings → API (see
  [Settings](#settings) and [API.md](API.md)). It is the app's only
  credential — the app itself has no login; for user-facing auth put
  Authelia, Authentik or PocketID in front via your reverse proxy.

## Finding manga

Every state below is shareable — the URL carries the full view (query,
filters, site, mode). Send `#/browse?site=…&q=…&genres=…` to someone and they
see exactly your list.

### Search everything (the default home)

`#/browse` opens the search home: one box, **Search all sites**, plus a
**scope selector** underneath — *All sites* (the default), *Preferred*,
or *Choose sites…* (an explicit multi-select).

- Typing searches **every installed site catalog at once**, as you type
  (debounced); the address bar tracks your query, so a search result page is
  a link. Under *All sites* the search is answered **entirely from the local
  catalog index — no network at all**; mirror copies of a series show
  together, each row carrying its **website badge**.
- **Per-site facet chips** with counts appear above the results — click one
  to narrow into that site carrying your query.
- Chips also warn you: a *failed* catalog (warning chip) and sites **skipped
  because no catalog is installed** (excluded chip). Install/open those sites
  first from the picker.
- **Load more** pages through results; the status line reads
  `Showing N of M entries across K sites`.
- With an empty query the home shows your **Recent sites** and
  **Recent manga** rows (when you have any; clearable), quick category
  chips, and a **Browse sites** button.

#### Scope: preferred sites and explicit picks

- ***Preferred*** narrows the search to your **preferred-sites allowlist**
  — one global, ordered list of the sites you actually use. Build it in the
  site picker: the **star** on any site row is a single decision, made once.
  The list is server-side state (it follows the instance, not the browser),
  and its **order is yours**: the chips and facets render in it, and the
  picker floats your starred sites into a pinned *Preferred* group at the
  top. A dead preferred site **dims** (last-check failed) but is never
  hidden — pick it anyway if you know better.
- ***Choose sites…*** is a one-off explicit pick: filter, tick the sites,
  search. The picks ride the URL (`#/browse?scope=specific&picks=…`) so the
  view is shareable, and an explicit pick is the tightest scope — it wins
  over *Preferred*.
- **Live results**: when your scope contains a site **without an installed
  catalog** (a site fmd-web can only read from the live site itself), the
  search also runs a **live** per-site pass for exactly those sites — paced
  one site at a time (a small concurrent pool, never a synchronized
  fan-out), with results appearing **as each site answers** and cancelling
  the moment you navigate. The default *All sites* search never does this —
  it stays local-index only, and catalog-less sites surface as excluded
  chips instead.

### Paste a URL (the universal front door)

Found a series on a site fmd-web knows? Copy the page URL and paste it
into **Add by URL** on the search home (the command palette's
**Add manga by URL** action lands in the same box — paste into the
palette, or run it to read your clipboard). The site is detected from
the URL — no site picker, no mode switch. A preview shows the title,
cover and alternative titles; then it's **one decision**: **Follow**
(watch for new chapters) or **Follow + auto-download** (new chapters
download by themselves). That single decision is never re-asked — the
scheduler takes it from there, and the manga shows up in Favorites.

Unknown hosts get a straight answer: *no site matches this URL* (with
a link to browse what's supported); a host shared by several sites
lists the candidates so you can open the one you meant.

### Pick a site (site-first browsing)

Click **Browse sites** (or open `#/browse?sites=1`; the **Change site**
button on any open site returns here): the full picker of enabled sites,
grouped by language/category.

- **Search sites** box filters by name or category text.
- **Category chips** with site counts narrow the list (the chips are in the
  URL: `?cats=English,Raw`).
- Each site row shows capability badges (e.g. *browser required*) and a
  catalog chip (installed or not). Known-broken sites are visibly disabled
  with the reason.
- **The star is your preferred list**: star a site to append it to the
  preferred-sites allowlist (one decision, made once — see
  [Search everything](#search-everything-the-default-home)); un-star
  removes it. Your starred sites float into a pinned **Preferred** group
  at the top of the picker, in your order, and searches under the
  *Preferred* scope use exactly that list.
- Picking a site opens its list. If the catalog is missing, the app prepares
  it automatically with a progress toast you can cancel; if there is no
  prebuilt catalog at all, sites that can serve their own list fall through
  to it automatically (the only trace is the muted **from site** badge next
  to the search bar; catalogs show **from catalog**).
- **Paste a manga URL** into the "Paste a manga URL…" box to jump straight to
  a title: the server resolves the site by its URL host. `Ctrl+Shift+V`
  pastes-and-goes from the clipboard in one stroke. Unknown hosts and
  ambiguous hosts are reported inline.
- **Dead-site hints** (last check): sites whose last observed contact failed
  (DNS gone, connection refused, timeout, Cloudflare 5xx) render **dimmed
  with the reason on the row** — a hint, never a gate, because the site may
  be back; picking it still works. The **Hide unavailable** checkbox folds
  those rows away for this visit (plain view state — it is not saved and
  never touches the URL). Never-checked sites render as normal rows.

### Browse one site's list

On a site's list (`#/browse?site=<id>`):

- **Latest / By title** tabs switch the ordering.
- The search box filters **as you type**, with a mode label
  (All / Filtered) and the match count.
- The **All sites** checkbox switches the same query into the union search
  across every installed catalog (`#/browse?allsites=1`) — same Website
  badges and facet chips as the home search.
- **Highlight new** toggles the new-manga accent (a persisted preference;
  the *only-new* day window lives in the filter panel below).

### The filter panel

Click **Filters** (it grows a `•` while filters are active) to open the
panel:

- **Authors / Artists / Summary** — substring fields.
- **Status** — Any status / Ongoing / Completed / …
- **Genres** — the canonical genre grid with a **Match all / Any of**
  switch.
- **Custom genres** — free text, comma-separated; prefix an entry with `!`
  or `-` to **exclude** it (excluded genres render struck-through in the
  applied chips).
- **Only new** — chip that restricts to manga updated within a window
  (default 7 days, editable 1–365).
- **Reset filters** clears everything.

Applied filters show as removable chips above the list, and — again — the
whole state is in the URL.

### Reading a row before opening it

- **Hover** a row (desktop) or **tap** it (touch) for the metadata popover:
  title, alternative titles, authors, artists, genres, status and summary,
  straight from catalog data — nothing is fetched. On touch, the popover's
  **Open** button navigates.
- The row **overflow menu (⋮)** offers **Open**, **Download all chapters**
  (one idempotent batch — re-clicking replays the same jobs, it never
  doubles) and **Add to favorites** (disabled when already favorited).
- Row accents: **completed** titles are tinted; **new** titles get an accent
  plus a badge when *Highlight new* is on and they fall inside the only-new
  window.

## Manga and chapters

Open a title (row click, deep link, recents, or URL paste) to reach the
manga page (`#/manga?module=…&url=…`): live info is fetched from the site.

- The info card shows the cover and the full metadata: alternative titles,
  authors, artists, genres, status, chapter count, summary.
- **Read online** opens the title on the source site (fmd-web is a
  downloader; there is no in-app reader by design).
- **Add to favorites / In favorites** toggles favorite state.
- **← Back to browse** returns to the list you came from.

### Choosing chapters

The chapter list has a full toolbar:

- **Filter chapters…** — case-insensitive substring box.
- **Ascending / Descending** — sort order toggle.
- **Hide downloaded** — hides chapters you already have.
- **Invert** — flips the selection over the visible rows.
- **Select new** — selects the chapters you have not downloaded yet
  (requires the title to be favorited; the button is disabled otherwise).
- **Select all / Clear**.
- A live counter: `N shown · M downloaded`. Downloaded chapters are tinted
  and carry a `downloaded` badge.

### Enqueue options

Next to the enqueue controls:

- **Start paused** — creates the jobs held (paused) instead of running them;
  resume later from [Downloads](#downloading).
- **Save to** — per-manga output-directory override (empty = the default
  `library/<manga>` layout — one folder per series, no site subdirectory).
  The value is remembered per title and recalled next time you open it.

Select chapters and click **Enqueue N chapters**. One job is created
**per chapter** (the queue model). A status line confirms the job id (and
notes when it was queued paused). Below the list, the **enqueue dry-run
preview** shows the exact request bodies that would be POSTed — select
chapters to inspect them; nothing is sent by the preview itself.

## Downloading

The Downloads page (`#/downloads`) is the live queue.

### Monitoring

- An **Event stream** status line (Live / Connecting… / Reconnecting… /
  Backfilling missed events…) reflects the live WebSocket feed; missed
  events are backfilled, so counts and progress do not go stale.
- Each row shows a **status badge** (waiting, preparing, downloading,
  compressing, converting, finishing, finished, stopped, problem, failed), a
  real **progress bar** with `done/total` image counts, and the **transfer
  rate** while downloading.
- While jobs run, the Downloads tab badge shows the running+queued count; a
  completion toast fires when a job finishes with the page open.

### Steering the queue

- Per row, the **primary button** is the state-appropriate action — Pause
  (resume-able) for queued/running, Resume for paused/stopped, Retry for
  failed, Redownload for finished.
- The row **overflow menu (⋮)** exposes the full set: Pause (resume-able),
  Resume, Retry, Redownload, Enable, Disable, **View info** (jumps to the
  manga page), **Delete job**, and **Delete job + downloaded file** (also
  removes the finalized library artifact). Deletes ask for confirmation.
- Toolbar bulk ops: **Resume all**, **Pause all**, and **Delete completed**
  (confirm dialog; removes finished job rows — files stay in the library).

### Finding jobs

- **Search** box (title or chapter substring).
- **State chips** — waiting / in progress / finished / stopped / failed /
  problem — any combination (multi-select).
- **Added** date window — all time / today / last 7 days / last 30 days /
  older / custom range (From/To inputs).
- Filters are URL-synced: a filtered view is a shareable link.

### Where files land

Finished chapters are packed into the server's data directory as
`library/<manga>/<chapter>.<format>` — one folder per series (the
downloading site is *not* a subdirectory, so browsing stays
title-first). Following the same series from a second site (e.g. a
different scanlation group) writes `<manga> [<site>]` — the first site
keeps the plain folder (format from Settings → Output defaults).
Retrieve them from the [Library](#library) page.

## Library

The Library page (`#/library`) lists finalized chapter archives, newest
first: manga, file name, size and date — every row also carries its
**verified state** (`downloaded` = the file was stat-checked at its
recorded path; `missing` = the ledger says downloaded but the file is
gone) and a **Copy path** action for the recorded server path.

- **Download** on each row streams the packed file
  (`/api/library/<id>/file`) to your machine — feed it to your reader or
  media-server of choice. There is deliberately **no in-app reader**:
  consumption belongs to dedicated tools.
- **Load more** pages through the archive list.
- The output **format** (ZIP / CBZ / PDF / EPUB) and naming come from
  Settings → Output defaults (see [Settings](#settings)).
- The **All / Missing / Orphans** filter chips are URL state
  (`#/library?filter=missing` is shareable): *Missing* lists files whose
  recorded path no longer resolves; *Orphans* lists files on disk under
  the downloads root that no library row claims (that list updates when
  you run a rescan).
- **Rescan library** walks the server's downloads root and reconciles
  the ledger against what is actually on disk. Files that MOVED within
  the root are re-linked automatically when the match is confident
  (same file name at a different directory, or exactly the app's own
  `<site>/<title>/<file>` output slot); ambiguous cases are never
  auto-linked — they surface as a missing entry listing its same-name
  candidates plus those files as orphans, and you decide by deleting
  the library row (the **Delete file…** action on the row, or ignoring
  the orphan). The report (re-links with former paths, missing,
  orphans, counts) stays on the page until the next rescan.
- The manga page's **Files** section lists every tracked chapter file
  for that title — chapter label, file name, size, date, state badge,
  copy-path — plus any orphans inside that title's directory, a
  per-title **Rescan**, and an explicit **Refresh** (states re-verify
  automatically when older than ~15 minutes; Refresh forces it).

### Deliberately not built (v1)

- **Renaming** library files/titles from the UI.
- **Downloading or zipping files from the Files/orphan listings** —
  the metadata surface never serves file bytes (the packed-artifact
  download link above is the sanctioned boundary).
- **Watching the filesystem continuously** — verified state refreshes
  lazily on view (with the 15-minute staleness window) and on rescan.
- **Interactive orphan adoption** (picking which missing entry an
  orphan belongs to) — v1 resolves by deleting the row or ignoring
  the orphan.

## Favorites lifecycle

Favorites track titles over time and check them for new chapters on a
schedule.

### Creating favorites

- From the **manga page**: **Add to favorites** (becomes **In favorites**;
  click again to remove).
- From any **browse row menu (⋮)**: **Add to favorites**.
- By **import** — see below.

### The list

Columns: `#`, Title (with a **N new** badge after checks, status and a
`disabled` badge when off), Ch. (current chapter), Website, Save to,
Checked, Updated — the row's second line also carries the date added,
and narrow screens fold the columns into that line.

Per row:

- **auto-download** — when on, scheduled checks queue new chapters by
  themselves (they show up *already queued* in the new-chapters sheet).
- **Check now** — an immediate check for this one title.
- **Remove** (and the menu's Delete) — confirm dialog.
- The **overflow menu (⋮)**: **View manga info**, **Download all new**
  (checks, then immediately enqueues what it found), **Rename** (inline
  editor), **Transfer website**, **Change save-to**, **Enable / Disable**
  (disabled favorites are skipped by the scheduler; manual checks still
  work), **Delete**.

### Scheduled checks

- Toolbar **Check for new chapters** opens the scope menu: **All
  favorites / Enabled only / Disabled only**. While a batch runs, the button
  shows Checking… and a **Stop check** button appears.
- The automatic cadence lives in Settings → **Favorites checks**: a check
  interval in minutes (**0 disables scheduled checks** — Check now keeps
  working) and **Check favorites at startup**.

### The new-chapters sheet

After any check that found something, a bottom sheet lists every title with
new chapters (`<title> <website> has N new chapters`):

- Per row: **Download** (start active jobs), **Add to queue** (enqueue
  paused), **Dismiss** (decide nothing — the chapters stay noted on the
  row's badge).
- Footer: **Download all**, **Add all to queue**, pending-decision count,
  and **Close**.
- Rows whose favorite has *auto-download* on arrive already queued — they
  show an `auto-queued (auto-download)` badge and need no decision.
- On touch, drag the sheet's grabber down to dismiss it.

### Transfer website

**Transfer website** (row menu) opens a dialog: pick the target site, get a
valid/invalid **preview** (the mapping is checked before anything moves —
failures say why: no catalog installed, title not found, or the target link
would not resolve), optionally tick **clear the downloaded-chapter list**
(so the new site's chapters re-ingest as undownloaded), then apply.

### Importing a list

**Import list** (toolbar) accepts a **JSON array** of favorites using either
the FMD2 field names (`moduleid`, `website`, `link`, `title`) or the fmd-web
names (`moduleId`, `url`, `title`). `website` names are matched against your
installed sites when `moduleid` is absent. Every entry reports
imported/failed individually. Imported favorites mark all currently-live
chapters as downloaded — nothing re-downloads en masse.

### Bringing over a desktop install (Import from FMD2)

Settings → **Import from FMD2** reads the desktop app's own files — no
hand-edited formats. Drop `favorites.db` and/or `downloadedchapters.db`
and/or `settings.json` and/or `modules.json`, or a **zip of the whole FMD2
data folder**, and the server parses them read-only into a preview: how many
favorites per site (with your downloaded-chapter history), which settings
map onto the server's, and which sites are **no longer in the catalog**
(dead or renamed ids are listed and skipped — the rest still imports).

Confirm what you want:

- **Favorites** — upserted idempotently; re-importing the same file never
  duplicates. Titles, statuses, current chapters and the
  downloaded-chapter lists carry over (desktop save-to *paths* don't — the
  server manages its own library layout).
- **Settings** — only the fields the server supports (proxy, connections
  subset, output defaults, favorites schedule); everything else is listed
  as *not imported* in the result.
- **Credentials** — per-site logins and the proxy login are **off by
  default**: tick the sites you want (they decrypt with FMD2's built-in
  key and land in Settings → Accounts).

API users: the same flow is scriptable — `POST /api/import/fmd2/analyze`
(multipart, returns the preview + a token) then `POST /api/import/fmd2/apply`
(see [API.md](API.md) and the OpenAPI spec).

## Accounts

Some sites need a login for full access. Per-site accounts live in
Settings → **Accounts** — one account per site, exactly like FMD2's account
manager.

- Each account-capable site gets a card: **username / password** fields and
  **Save**.
- **Check login** runs the site's login routine and the card's badge reports
  the verdict: **Login valid / Login invalid / Checking… / Unknown**.
- **Cookies…** jumps to that site's module editor, where a raw **Cookie
  header string** can be saved (useful for pasting a browser session).
- **Remove** deletes the stored account.

## Settings

`#/settings`, top to bottom:

- **Proxy** — the global proxy (type none/HTTP/SOCKS4/SOCKS5, host, port,
  user, password). A badge shows whether the **browser sidecar** profile is
  active — some sites require it (see [Troubleshooting](#troubleshooting)).
- **API** — the single app-wide API token (the app's only credential;
  user auth = a reverse proxy with Authelia/Authentik/PocketID in front):
  reveal, copy, regenerate
  (regeneration is hidden when the token is pinned via environment for
  headless deployments). See [API.md](API.md).
- **Performance** — request timeout (s), retry count, threads per chapter,
  parallel chapters (applies after a server restart).
- **Job history** — auto-delete finished job rows after N days, or keep
  forever.
- **Filename policy** — Linux-normalized filenames vs FMD2-desktop-parity
  naming (an environment override beats this checkbox when set).
- **Diagnostics** — enable structured logging and its minimum level (applies
  live); links to Prometheus **/metrics** and the operations runbook.
- **About** — server version, **Install app** (when the browser offers
  install), links to Releases / Changelog / Repository.
- **Output defaults** — archive format (ZIP / CBZ / PDF / EPUB), the chapter
  name template (`%MANGA% %CHAPTER%`, empty = chapter name), digit padding,
  remove-manga-name, and unicode replacement (with its replacement
  character).
- **Favorites checks** — the scheduler settings described in
  [Favorites lifecycle](#favorites-lifecycle).
- **Accounts** — see [Accounts](#accounts).
- **Modules (<count>)** — the site-module registry:
  - **Search** by name or category; **Select all / None** global bulk
    toggles; each **category header** carries per-category bulk
    enable/disable.
  - **Last check** — each row carries a small reachability marker (hover
    for when it was checked and the failure reason); the **Last check**
    facet chips (All / Reachable / Unreachable / Unknown, in the URL as
    `?filter=`) filter the registry by it, and the per-row **Check**
    button probes that one site's address through the module's own HTTP
    path and records the verdict. The record also updates itself as a
    byproduct of normal use (browsing, favorites checks, downloads), and
    a later success flips an unreachable site back automatically — no
    background re-checking exists, and there is deliberately no
    check-all button.
  - Each module row: the **enabled** checkbox, category and root URL,
    capability badges, and **Re-sync catalog** (offered when a catalog is
    installed — refreshes it with a progress toast).
  - **Configure** opens the per-module editor: the module's own **options**
    (checkboxes, text fields, number inputs, and dropdowns — a dropdown
    choice is stored **by its position** in the list, matching the Lua
    module's expectations), the **cookies** editor, and a **module proxy
    override** (unchecked = inherit the global proxy).
- Header actions: **Sync modules** and **Sync all catalogs**, with result
  reports (including tolerated upstream-broken module files, itemized).

## Troubleshooting

- **A site shows "This site is unavailable"** — the module is known-broken
  upstream; the reason is displayed. It stays disabled until an upstream
  fix. The picker shows the same state on the row.
- **Browser-dependent sites stay known-broken** — run the compose stack with
  the browser profile (`docker compose --profile browser up`); the Settings
  → Proxy badge flips to *browser sidecar: enabled* when it answers.
- **Bootstrap did not finish / the registry is empty** — Settings shows the
  first-run panel: **Run module sync now**, with per-file failure reports
  for tolerated upstream breakage. The banner's stage and `/readyz` tell
  you where a stuck bootstrap is.
- **"Couldn't open this site" while browsing** — a transient sync error;
  the Retry button re-runs preparation (nothing partial was installed).
  **"No list available for this site"** means the site has neither a
  prebuilt catalog nor the ability to serve its own list.
- **Sync / catalog problems, pins, backups, vacuum cadence** — the
  [operations runbook](runbook.md) owns them (Settings → Diagnostics links
  there too).
- **The queue looks stale** — check the *Event stream* line on Downloads:
  it reconnects and backfills automatically; a page refresh also resyncs.
- **Open-by-URL failures** — "No site matches this URL" (unknown host) and
  "Ambiguous host" (several modules claim it; the candidates are named)
  are reported inline on the Browse picker.
- **Where logs and metrics live** — server-side structured JSON logs
  (enable/level under Settings → Diagnostics) and Prometheus metrics at
  `/metrics`. Job-level failures also surface per-row in Downloads.

## Coming from FMD2 desktop

The domain is the same; the habits transfer with a web accent. (The full
feature-by-feature disposition matrix lives in
[UX-PARITY.md](UX-PARITY.md).)

| FMD2 desktop habit | fmd-web equivalent |
|---|---|
| Hover **tooltips** on the manga list | **Hover cards** on browse rows (tap on touch) — richer metadata, same gesture |
| Modal **dialogs** (new chapters, transfers) | **Bottom sheets** (drag-dismissable) and focused confirm **dialogs** |
| **Tray balloon** notifications | **Toasts** + the Downloads tab badge and completion dot |
| **Filter trees** (Downloads states/history; Websites categories) | **Chips** (state multi-select, date window) and **category bulk rows** in Settings |
| Per-window/dialog state (filters, search) — lost on close | **Shareable URLs** — every view state is the address bar; bookmark and send views |
| Floating **Drop Box** / paste-a-URL | The **"Paste a manga URL…"** box on Browse sites, with `Ctrl+Shift+V` paste-and-go (page-wide drag-and-drop is not shipped) |
| Tray menu *Resume all / Stop all* | Downloads toolbar **Resume all / Pause all** |
| Site **combo box** (cbSelectManga) | Search-first **home** (all-sites search) + the **Browse sites** picker with category chips |
| The **Filter sub-tab** (genres/authors/only-new) | The **Filters** panel on a site's browse page |
| **Options → Import favorites** (another FMD install's folder) | Settings → **Import from FMD2** — upload the desktop data files (favorites.db, settings.json, modules.json or a zip of the folder) and pick what lands |
| Right-click **Update list** | **Re-sync catalog** on the site's Settings row |
| **Accounts manager** | Settings → **Accounts** (per-site cards, status badges, cookies) |
| Website **options grid** | Settings → Modules → **Configure** (per-module options, cookies, proxy override) |
| Keep the app open so the queue runs | The **server** keeps the queue running while you are away; the home page's *While you were away* card reports what happened |
| **Read online** button | **Read online** link — opens the source site (no in-app reader, by design) |

Keyboard notes: `/` focuses search, `Cmd/Ctrl+K` opens the command palette,
`Ctrl+Shift+V` paste-and-goes a manga URL — but nothing is keyboard-only;
every action has its visible button (mobile parity).
