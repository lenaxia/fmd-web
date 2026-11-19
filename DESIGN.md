# FMD-Web — Design & Architecture (v5)

A Dockerized web-based rebuild of FMD2 (Free Manga Downloader 2) that
**reuses FMD2's Lua site-module ecosystem and the FMD2-DB catalogs
unchanged** — one ecosystem, one module set, no fork of site adapters.

- v2 revised v1 after `docs/REVIEW-001-design-review.md`.
- v3 revises v2 after `docs/REVIEW-002-design-review.md`: the §5.2
  event-binding table was re-derived **directly from the 15 Do\* dispatchers**
  in `LuaWebsiteModules.pas`, the shared-module-state concurrency model is
  now specified, the GetInfo post-processing pipeline (`uData.pas`) and the
  favorites engine (`uFavoritesManager`) are contractual, plus
  zstd/list-fill overloads/packing-memory fixes. Round 3
  (`docs/REVIEW-003-design-review.md`) verified the §5.2 table correct
  15/15 and surfaced one Major gap — the `pb` (lua-protobuf) native module
  that MangaPlus hard-requires — fixed here in v4 together with the round-3
  minors (dedup direction, single-flight fallthrough, Storage facade,
  require-name prefixes, unknown-property tolerance, WS backfill cap,
  first-run bootstrap, harness pinning). Round 4
  (`docs/REVIEW-004-design-review.md`) verified all v4 deltas clean,
  declared the architecture converged, and surfaced two final
  contract-surface completions — the JS-side CommonJS `require` inside
  Duktape contexts (77 modules incl. Madara's default image-decryption
  flow) and `ParseHTML` as a 1-arg instance method — fixed in v5 together
  with the round-4 minors (`debug.getinfo`, full `io` namespace jail,
  ExecJS nil-on-error semantics, imagepuzzle API enumeration, `pb.load`
  return shape).
- Companion analysis of the original app: `FMD2/docs/ARCHITECTURE.md`.

---

## 1. Goals & Non-Goals

### Goals

1. **Single ecosystem**: run the *exact* `lua/modules/*.lua` files from
   `dazedcat19/FMD2` unmodified; upstream module updates arrive by syncing
   the repo (pinned by commit SHA).
2. **Direct FMD2-DB integration**: consume per-site catalogs in their
   native form (7z of SQLite `.db`, keyed by 32-hex module ID), read-only.
3. Self-hosted Docker app with a web UI: catalog browsing/search, manga
   info, favorites, chapter downloads to ZIP/CBZ/PDF/EPUB, live progress.
4. Parity with FMD2 semantics where it matters: per-site connection
   limits, retries/delays, module-defined image pipelines, GetInfo
   normalization, chapter dedupe, favorites diff.

### Non-Goals (v1)

- Multi-user tenancy (single-user self-host; optional single password).
- Windows-specific behaviors (registry, self-update exe). Filename
  truncation/path-length **behavior is deliberately Windows-desktop-parity**
  (Decision D5) since `CurrentMaxFileNameLength` semantics are
  Windows-derived (`uDownloadsManager.pas:477, 768–770`; tail-truncation is
  `{$IFDEF WINDOWS}`-only, `:543–550`) — a value of 0 means "no limit".
- Running FMD2's Pascal code — we re-implement the *host*, not the app.
- **Full site coverage in v1**: browser/subprocess-dependent sites are
  knowingly degraded and published as per-module capability flags (§5.9–5.11).
- `DoCheckMissing` (file-system-based missing-chapter detection,
  `uFavoritesManager.pas:397–529`) — out of scope (D15).

### Revision-log

| Topic | v2 | v3 |
|---|---|---|
| §5.2 binding table | 9/15 rows wrong; fabricated `ACCOUNT` | re-derived from dispatchers; `MODULE` everywhere; no `ACCOUNT` |
| §5.1 module surface | missing `TotalDirectory`/`AccountSupport`/`On*`/`Guardian` | complete |
| Shared module state | "per-worker persistent MODULE" (contradictory) | shared-state service, concurrency specified (§5.3, D12) |
| GetInfo post-processing | absent | contractual (§5.8) |
| Favorites engine | misattributed to `uUpdateThread` | `uFavoritesManager` semantics specified (§7.2, D8) |
| HTTP | no zstd, no default headers | zstd policy + `Reset`/`ResetBasic`/`AcceptImage` sets (§5.4, D13) |
| TXQuery | no fill-a-list overloads | `XPathStringAll/HREFAll(expr, list)` contract (§5.6) |
| Packing | in-memory libraries only | streaming/append strategy + budgets (§7.3, D16) |
| Idempotency | `409 on replay` | replay returns original job; 409 = key reuse w/ different payload |
| SQLite | write coalescing only | per-thread connections, claim discipline, checkpoint sizing (§4) |
| Release 0.1.0 (v5) | — | full-gate release: ci.sh gate extended with both e2e phases (compose hardening asserted per run: non-root, digest pins, healthcheck, SIGTERM drain drill ≤30 s + clean exit 0); decision status table (D1–D21) published in `docs/RELEASE-NOTES.md` — 20 implemented, 1 deviated (D15 scope-out); known-broken list (83 modules / 3 flags) published in-app + release notes; COMPAT.md binding statuses carry zero `unknown`; version 0.1.0 stamped across packages, image label/tag, and `CHANGELOG.md` |

---

## 2. Ecosystem Reuse Strategy

```
dazedcat19/FMD2 (GitHub repo, pinned SHA)
  └─ lua/  ├── modules/*.lua    417 site adapters   → executed by our Lua host
           ├── templates/*.lua  site-family templates
           ├── utils/*.lua      jsunpack, protoc, nodejs, …
           ├── extras/          imagehoster, mangafoxtemplate (PNG assets!)
           └── websitebypass/   antibot checks + bypass scripts (host hook)

dazedcat19/FMD2-DB (GitHub repo)
  └─ 7z/<module-id>.7z → contains <module-id>.db (SQLite, rollback journal)
       https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/7z/<id>.7z
       <id> = the module's m.ID (32-hex)
```

- Module IDs are the join key everywhere; catalog schema reused verbatim:
  `link, title, alttitles, authors, artists, genres, status, summary,
  numchapter, jdn` (`DBDataProcess.pas:143–153`).
- Both channels content-addressable by commit SHA; update checks use the
  GitHub commits API (1 call); blob fetches use conditional GET (ETag) and
  a rate budget of 10 req/s with burst 50 (token bucket), resumable.

---

## 3. Stack

| Concern | FMD2 uses | fmd-web |
|---|---|---|
| Lua 5.4 runtime | Lua 5.4 DLL | **wasmoon** (official Lua 5.4 → WASM) |
| XPath 2/3 + XQuery + JSON | InternetTools | **FontoXPath** (XPath 3.1) over **linkedom**, plus dialect shim (§5.7) |
| Embedded JS | Duktape | `node:vm` (`ExecJS` facade + `Duktape.enc/dec` polyfill) |
| HTTP | Synapse + OpenSSL | undici + cookie jar + **socks-proxy-agent** (SOCKS4/5 parity) |
| Response decode | gzip/deflate/brotli/**zstd** | gzip/deflate/brotli native; zstd per D13 (strip from `Accept-Encoding` by default; decoder add-on if smoke tests show need) |
| Crypto | DCPCrypt + libsodium | `node:crypto` + **sodium-native** (X25519/P256/SecretStream-pull) + `aes-js` (CFB/CTR) |
| Regex | PCRE2 | PCRE2 wasm or RE2 (API-faithful `pcre2` lib) |
| Images | GDI+/ImageMagick/webp | **sharp** (decode webp/gif, puzzle/watermark ops) |
| Datastore | SQLite | better-sqlite3 (WAL, app.db) + read-only catalog files (§6) |

Node.js LTS; React + Vite SPA served by the API server; single image,
optional split worker container.

**Reproducibility** (Round-2 minor): every native/JS dependency is pinned
by lockfile + exact version: Node LTS line (exact minor), wasmoon **and its
bundled Lua 5.4 build**, FontoXPath, sharp + libvips prebuilt, 7zz binary,
base image **digest** (not tag). CI builds the image twice and diffs SBOMs
to catch drift.

---

## 4. System Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ fmd-web container (non-root, SIGTERM-drained, healthcheck)         │
│                                                                    │
│  React SPA ◄──REST/WS──► API server (Fastify)                      │
│                            │  idempotent job API · WS backfill     │
│                     Job engine (SQLite-backed queue)               │
│        lanes: info-jobs │ download-jobs │ update-jobs │ sync-jobs  │
│              │                            │                        │
│   ┌──────────▼─────────────┐   ┌──────────▼───────────────────┐   │
│   │ Module engine           │   │ Sync service                  │  │
│   │ worker_threads pool;    │   │ FMD2 lua/ sync (SHA pin,      │  │
│   │ 1 wasmoon engine per    │   │ commit-API update check,      │  │
│   │ worker; chunk re-exec   │   │ review gate)                  │  │
│   │ on module switch;       │   │ FMD2-DB 7z → catalogs/<id>.db │  │
│   │ per-event deadline +    │   │ (read-only, db_sha keyed)     │  │
│   │ wedged-worker watchdog  │   └───────────────────────────────┘   │
│   └──────────┬─────────────┘                                        │
│              │ HTTP via undici + egress policy (§8)                 │
│              │ anti-bot interceptor hook (§5.10)                    │
└──────────────┼──────────────────────────────────────────────────────┘
               ▼                                        ▼
        manga websites                     raw.githubusercontent.com
```

- **Queue**: SQLite-backed (no Redis), 4 lanes with independent
  concurrency. Job progress writes are coalesced (in-memory buffer,
  flushed ≤1/sec/job).
- **SQLite discipline** (Round-2 minor): better-sqlite3 in
  `worker_threads` requires **one connection per thread** (handles are not
  shareable); job claiming is a single-writer transaction
  (`UPDATE ... WHERE state='queued' LIMIT 1 RETURNING` pattern with
  `busy_timeout=5000`); WAL auto-checkpoint sized (default 1000 pages,
  tunable) and checkpoint stalls monitored; write volume bounded by the
  coalescing above.
- **Watchdogs**: every Lua event call runs under a wall-clock deadline
  (default 60 s, per-module override). Deadline = HTTP requests aborted
  (`HTTP.Terminated` set) **and queued-but-not-started requests fail fast**
  (unlike FMD2's connection-queue wait, which ignores termination —
  `httpsendthread.pas:417–435`). A worker that misses its deadline twice
  (non-HTTP hang) is recycled; its job fails `worker_stalled`.
- **Graceful shutdown**: SIGTERM → stop claiming → abort in-flight HTTP →
  flush progress → finish atomic renames → exit (bounded 30 s).

---

## 5. Compatibility Contract

Derived from FMD2 `baseunits/lua/*.pas`. **The §5.2 table is transcribed
directly from the Do\* dispatchers in `LuaWebsiteModules.pas`** (verified
twice; see REVIEW-001/002 for the failure history of second-hand
derivation). `docs/COMPAT.md` tracks per-binding-unit status and per-module
pass rates. Implementation rule: **the binding tables in code must be
generated from a machine-readable form of §5.2, and CI cross-checks them
against a fresh parse of the Pascal dispatchers.**

### 5.1 Module discovery (`Init` phase)

- Per `lua/modules/*.lua` file: **fresh Lua state** whose base globals are
  `print`, `sleep`, `CreateTXQuery`, `Trim`, `MaybeFillHost`,
  `MangaInfoStatusIfPos`, `GetBetween`, `SeparateLeft`, `SeparateRight`
  (`LuaBase.pas:78–97`, `LuaSynaUtil.pas:36–46`). `NewWebsiteModule()` is
  available **only during the `Init()` call** (`LuaWebsiteModules.pas:481–493,
  644`). Discovery scans `*.lua` and `*.luac`; registrations missing `ID`
  or `Name` are dropped (`:523–533`).
- A file may register **multiple** modules.

Module object surface (`LuaWebsiteModules.pas:991–1039`):

```
identity/props: ID · Name · RootURL · Category · TotalDirectory ·
  MaxTaskLimit · MaxThreadPerTaskLimit · MaxConnectionLimit ·
  ActiveTaskCount · ActiveConnectionCount · SortedList ·
  InformationAvailable · FavoriteAvailable · DynamicPageLink ·
  CurrentDirectoryIndex · LastUpdated · Tag · Guardian ·
  Storage (strings-storage facade: KV map + `Text` (get/set), `Remove`,
  `Tag`, `Enable`, `Status` — `LuaStringsStorage.pas:150–159`; shared —
  see §5.3) ·
  AccountSupport (bool) → Account{Enabled, Username, Password, Status,
  Cookies}  [Account object exists only when AccountSupport=true,
  :1035–1036]
event-name string props (binding mechanism):
  OnBeforeUpdateList · OnAfterUpdateList · OnGetDirectoryPageNumber ·
  OnGetNameAndLink · OnGetInfo · OnTaskStart · OnGetPageNumber ·
  OnGetImageURL · OnBeforeDownloadImage · OnDownloadImage · OnSaveImage ·
  OnAfterImageSaved · OnLogin · OnAccountState · OnCheckSite
methods: AddOptionCheckBox/Edit/SpinEdit/ComboBox(name, caption, [items,]
  default) · AddServerCookies · GetServerCookies · RemoveCookies ·
  ClearCookies · GetOption(name)
```

Note: there is **no `Language` property**. Options persist per-module
(combobox = selected **index**; values keyed by `CleanOptionName(Name)` so
language cannot shift stored values).

**Unknown-property tolerance is behavioral contract**: object property
access follows FMD2's `LuaClass` semantics — unknown keys silently no-op
on get and set, and keys are **case-sensitive** (`LuaClass.pas:94–169`).
E.g. the `MANGAINFO.Artist` (singular) typo in `OrckuMangas.lua:91` must
be silently dropped, never an error.

### 5.2 Event-call environment (ground truth: the 15 dispatchers)

`MODULE` is bound for **every** event by the module handler
(`LuaWebsiteModuleHandler.pas:47–49, 59–64`). Status constants
(`no_error=0`, `net_problem=1`, `information_not_found=2`) or account
constants (`asUnknown/asChecking/asValid/asInvalid`) are bound per the
return type. Return protocol: **codes** for the first three rows,
**booleans** for all others; **SaveImage returns a string**.

| Event | Returns | Globals bound (exact) |
|---|---|---|
| GetDirectoryPageNumber | code | `HTTP`, `UPDATELIST`, `PAGENUMBER` (in; **read back** after call), `WORKPTR` |
| GetNameAndLink | code | `HTTP`, `NAMES`, `LINKS`, `UPDATELIST`, `URL` (page number) |
| GetInfo | code | `MANGAINFO`, `HTTP`, `URL` |
| BeforeUpdateList / AfterUpdateList | bool | `UPDATELIST` |
| TaskStart | bool | `TASK` |
| GetPageNumber | bool | `TASK`, `HTTP`, `URL` (chapter) |
| GetImageURL | bool | `TASK`, `HTTP`, `WORKID`, `URL` |
| BeforeDownloadImage | bool | `TASK`, `HTTP`, `WORKID`, `URL` (**push-only** — never read back; modules cannot mutate the download URL via this global) |
| DownloadImage | bool | `TASK`, `HTTP`, `WORKID`, `URL` |
| SaveImage | **string** | `HTTP`, `PATH`, `FILENAME` |
| AfterImageSaved | bool | `FILENAME` |
| Login | bool | account-status constants, `HTTP` |
| AccountState | bool | account-status constants |
| CheckSite | bool | account-status constants |

There is **no `ACCOUNT` global**; the account is reached only as
`MODULE.Account`. `URL` is never read back after any call. `PAGENUMBER` is
the only read-back global (`LuaWebsiteModules.pas:210–212`).

`UPDATELIST` = exactly `CurrentDirectoryPageNumber` (get/set, monotonic
guard) + `UpdateStatusText(msg)` (`LuaUpdateListManager.pas:36–41`,
`uUpdateThread.pas:451–459`).

**`TASK`** (in/out contract of the image pipeline, `LuaDownloadTask.pas:21–32`):
`PageLinks[]` (module writes image URLs at [WORKID]; host uses `'W'`/`'D'`
markers to resume/skip, `uDownloadsManager.pas:350–407`),
`PageContainerLinks[]`, `PageNumber` (module writes; host iterates
0..N-1), `FileNames[]` (optional module-written filenames),
`ChapterLinks[]`/`ChapterNames[]`/`CurrentDownloadChapterPtr`/
`CurrentMaxFileNameLength`/`Link` (read-only).

`MANGAINFO` fields: `Title, AltTitles, Authors, Artists, Genres, Status,
Summary, CoverLink, ChapterLinks, ChapterNames, URL, Link`.
Helpers: `Trim(s[, chars])`, `MaybeFillHost(base, url)`,
`MangaInfoStatusIfPos(...)` (exact output constants — 128 modules;
`uBaseUnit.pas:2793–2852`).

**`sleep(ms)` is a real blocking sleep** (`LuaBase.pas:72–76`);
cancellation is cooperative via `HTTP.Terminated` (`cloudflare.lua:26–33`).

### 5.3 Shared module state & concurrency model (v3, resolves Round-2 C3)

FMD2 semantics: the Lua *handler* is per-thread, but the module's
**underlying state objects are shared per-module and accessed
concurrently** — favorites run concurrent checks
(`uFavoritesManager.pas:717, 737`), downloads run `MaxThreadPerTaskLimit`
threads per task (`uDownloadsManager.pas:870–920`), update-list runs
concurrent GetInfo (`uUpdateThread.pas:832–898`). Only the state objects
are locked, never the Lua events.

fmd-web therefore separates:

1. **Per-module shared state service** (host-side, one instance per
   module, independent of the worker pool): cookie jar, `MODULE.Storage`
   KV store, `Account` (credentials/cookies/status), per-module settings,
   bypass state (cookies+UA), per-host connection limiter. Locking:
   cookie jar = RW lock; Storage = per-key mutex; Account = mutex;
   options = copy-on-read. Mirrors the locked Pascal objects
   (`LuaStringsStorage.pas:17, 75`; `httpcookiemanager.pas:46+`;
   `WebsiteModules.pas:90`).
2. **Per-worker Lua engines**: chunk state (module-level locals,
   `package.loaded` templates) persists per worker exactly as
   `LuaWebsiteModuleHandler.pas:33–54` (fresh state on module switch,
   reuse otherwise). **Consequence (accepted, FMD2-faithful): module-level
   Lua locals are not shared across workers** — only the state service is.
   Modules that keep cross-call state in Lua locals (rare; state in
   `Storage` is the sanctioned path, used by nodejs sessions and bypass)
   behave as on FMD2 with multiple threads.
3. **Concurrency policy**: same-module events MAY run concurrently on
   different workers (D12), bounded by the module's
   `MaxConnectionLimit`/`MaxThreadPerTaskLimit` and the job lane's limits.

### 5.4 `HTTP` object shim (undici-backed; semantics of `httpsendthread.pas`)

Properties (`LuaHTTPSend.pas:171–198`): `Timeout`, `ResultCode`,
`ResultString`, `LastURL`, `Headers` (case-insensitive `Values['name']`),
`Cookies` (jar, `Values['name']`), `Document` (**stream facade**:
`ToString` (= `ReadString`), `WriteString`, `LoadFromFile`, `SaveToFile`,
`Clear`, `Size` (writable) — POST bodies are written into it; a request
"succeeded" iff `Document.Size > 0`, `httpsendthread.pas:717`),
`MimeType`, `UserAgent`, `RetryCount` (default 0), `EnabledCookies`,
`FollowRedirection`, `MaxRedirect`, `AllowServerErrorResponse`, `Compress`,
`Terminated`.

Methods: `Request(method, url)`, `GET/POST/HEAD`, `XHR` (= GET +
`X-Requested-With`, `:749–755`), `Reset`, `ResetBasic`,
`ClearCookies`, `ClearCookiesStorage`, `GetCookies`,
`ParseServerCookies`, `AddServerCookies`, `MergeCookies`, `RemoveCookie`,
`SetProxy(ProxyType, Host, Port, User, Pass)` with
`'HTTP'|'SOCKS4'|'SOCKS5'` (declared `LuaHTTPSend.pas:91–96`, impl
`httpsendthread.pas:838–874`).

**Default header sets** (Round-2 M3):
- `Reset`: `DNT=1`, `Upgrade-Insecure-Requests=1`, `Accept`,
  `Accept-Language`, `Accept-Charset` (`httpsendthread.pas:924–932`);
- `ResetBasic`: minimal set; `Compress` on ⇒
  `Accept-Encoding: gzip, deflate, br` (+ `zstd` only if the decoder is
  enabled, D13 — v3 default **omits zstd**: documented header divergence);
- image download phase swaps `Accept: image/webp,*/*` (`AcceptImage`,
  `:919–922`, invoked by the download pipeline `uDownloadsManager.pas:369–370`).

Behavioral parity: redirects follow 301/302/303/307 **as GET**, max 5
(default), add `Referer` of the pre-redirect URL (`:642–674`); retry on
`>500`, no delay, bounded by `RetryCount` (`:623–629`); POST moves
Content-Type from `Headers` into `MimeType` and rewrites `text/html` →
`application/x-www-form-urlencoded; charset=UTF-8` (`:730–747`); URL
massaging (strip leading `:/`, prepend scheme, `MaybeEncodeURL`,
`:612–616, 394–400`); decompression gzip/deflate/brotli(+zstd per D13);
per-host concurrency limits and delays are host-level (mirrors
`THTTPQueue`), invisible to modules.

### 5.5 Strings & info facades

`TStrings` facade (`LuaStrings.pas:222–263`): `Add, AddText, Get/Set[i]`
(0-based, bracket-indexed), `Count, Clear, Delete, IndexOf, IndexOfName,
Reverse, Sort, GetText/SetText, CommaText, DelimitedText, Delimiter,
NameValueSeparator, Values[], LoadFrom*/SaveTo*` (job temp dir only).

### 5.6 `CreateTXQuery` — query engine shim

- Constructors: from `HTTP.Document`, from string.
- **Methods**: `XPath(expr[, node])` → **IXQValue object**; `XPathString`,
  `XPathStringAll`, `XPathCount`, `XPathHREFAll`, `XPathHREFTitleAll`;
  **`ParseHTML(htmlOrStream)`** — an **instance method** taking exactly
  **one** argument (string or stream, `LuaXQuery.pas:45–56, 193`), used by
  MangaDemon.lua:42, dm5.lua:79, InManga, TonarinoYoungJump, MangaEsp
  template, etc. (v4 wrongly listed it as a constructor with a `url`
  parameter).
- **List-fill overloads (v3, Round-2 M4)**: `XPathStringAll(expr, list)`,
  `XPathStringAll(expr, node, list)`, and the `XPathHREFAll`/
  `XPathHREFTitleAll` equivalents **mutate the TStrings facade**
  (`LuaXQuery.pas:124–145`) — this is the primary way modules populate
  `TASK.PageLinks` (LxHentai, Tapas, WeebCentral, MangaDemon,
  Hentai2Read — with `json(...)` inside — ReadComicsOnlineRU…). The
  string-join form (`XPathStringAll(expr)` → `", "`-joined trimmed string)
  coexists with the fill form; dispatch is by argument type.
- **IXQValue facade** (`LuaIXQValue.pas:135–148`): `Get()` (Lua iterator),
  `Get(i)`, `GetAttribute(name)`, `GetProperty(name)`, `InnerHTML()`,
  `OuterHTML()`, `InnerText()`, `ToString()`, `Count`.
- **String coercion**: `ToString()` of an element = inner text (linkedom's
  `String(node)` is outerHTML — implement innerText semantics);
  `XPathStringAll` string form joins with `", "` after per-item `Trim`.
- **Error swallowing**: FMD2's `Eval` swallows all errors → empty
  (`XQueryEngineHTML.pas:358–399`). Match it; log at WARN with module ID +
  expression, **rate-limited/deduplicated** (max 1 per (module, expression
  template) per run).
- **JSON dialect**: InternetTools models JSON as a **node tree**
  (`json(*).meta.total`, `json(*).data()` = node steps/fn:data); some
  modules use the map form (`json(.)?data?*`). `json($s)` is a custom
  XPath function producing a JSON node-tree adapter (ordered,
  array→sequence), covering both access forms; `css("sel")` registered as
  a function.
- **Parser layer**: InternetTools' repairing (non-HTML5) parser vs
  linkedom differences are decided by the ground-truth corpus (§13), with
  a preprocessing pass where needed.

### 5.7 `require`-able libraries

| Lua require | FMD2 unit | fmd-web implementation |
|---|---|---|
| `fmd.env` | `LuaFMD` | `Directory`, `ExeName` ('fmd-web'), `Version`, `Revision`, `LuaDirectory`, `SelectedLanguage` ('en', D10 — captions only) |
| `fmd.crypto` | `LuaCrypto` | full surface (`:429–494`) incl. `RC4` (pure-JS), `AES*GCM(+AAD)`, `X25519_*`, `P256_*`, `SecretStream_InitPull/Pull` (**pull-side only**), `PBKDF2SHA256`, Base64/Base64URL, CRC16/32, MD4, LongHash, UU, URL enc/dec, synacode block |
| `fmd.duktape` | `LuaDuktape` | **one method: `ExecJS(js)`**; `node:vm` (timeout 5 s) with `Duktape.enc/dec` polyfill. **JS-side CommonJS `require()` loader** (Round-4 M1): FMD2 initializes Duktape's module system (`duk_module_duktape_init` + `Duktape.modSearch`, `Duktape.pas:88–89`, files resolved from `lua/` via `loadModuleFile`, bare names + `.js`) and **77 modules depend on it from inside JS** — `templates/Madara.lua:178–179` (default-flow image decryption) and `MangaGo.lua:206`; the shim must provide `module`/`exports` with per-context caching, **jailed to the synced `lua/` tree**. Error semantics: JS error ⇒ `ExecJS` returns **nil** (not a Lua exception, `LuaDuktape.pas:18–24`); JS-context `print` routes to host log (`Duktape.pas:90`) |
| `fmd.gzip` | `LuaGZip` | **single method: `Inflate`** (`LuaGZip.pas:47–50`) |
| `fmd.fileutil` | `LuaFileUtil` | **3 pure helpers**: `ExtractFileName`, `ExtractFileNameOnly`, `SerializeAndMaintainNames` (`LuaFileUtil.pas:33–39`) — not an fs API |
| `fmd.imagepuzzle` | `LuaImagePuzzle` | sharp port (7 modules); API enumerated in contract.json: `New/Create(w,h)`, read-only `HorBlock`/`VerBlock`, read-write `Matrix[]`/`Flips[]`/`Multiply`, `DeScramble(src,dst)` incl. in-place same-Document calls (`LuaImagePuzzle.pas:73–99`; MangaGo.lua:264, 18Comic.lua:99, TonarinoYoungJump.lua:96) |
| `fmd.logger` | `LuaLogger` | structured logging |
| `fmd.mangafoxwatermark` | `LuaMangaFox` | sharp port; Windows backslash paths normalized to synced `lua/`; PNG assets shipped |
| `fmd.pcre2` | `LuaPCRE2` | PCRE2 wasm/RE2, API-faithful |
| `fmd.strings` | `LuaStrings` | facade factory (§5.5) |
| `pb` | **native Lua C module** (`pb.dll`, lua-protobuf, loaded via `package.cpath` — FMD2 ships it in `dist/<target>/`) | **`package.preload['pb']` shim backed by protobufjs**: `decode`, `encode`, `load` (**returns `(ret, pos)`** — `protoc.lua:1176,1183` bind both returns); covers MangaPlus (`MangaPlus.lua:54` hard `require 'pb'`, `pb.decode` at `:123/:143/:191`) **and** `utils/protoc.lua`'s `has_pb` branch (encode/load, `protoc.lua:993+`) (D17) — corpus-verified: no `pb.option/setdefault/loadfile` usage exists |
| `subprocess` | `LuaSubprocess` | denied stub (`RunCommand*` → nil) unless browser profile (§5.11) |
| `utils.*`, `templates.*` | `lua/utils/`, `lua/templates/` (41 template files; 76 modules require `templates.Madara` alone) | plain Lua chunks via the file-package loader, from the synced tree; `utils.nodejs` special (§5.11) |

**Not require-able**: there is **no `fmd.websitebypass`** — bypass chunks
load via the file-package loader as `websitebypass.cloudflare` /
`websitebypass.ddos-guard` (`websitebypass.lua:8,10`) and are
**host-invoked** through the interceptor (§5.9), never by modules.

`io.open/os.time/os.date/os.remove` allowed but **jailed** to the module
temp dir; `os.execute`/`io.popen` denied. The real jailed fs surfaces are
`Document.LoadFromFile/SaveToFile`, TStrings `LoadFrom*/SaveTo*`, and
`io.open` (§8). **Sandbox hardening must not over-strip** (Round-4 minors):
`(read-only) debug.getinfo` must remain exposed (`MangaPlus.lua:106` uses
it), and the **whole `io` namespace** is jailed — `io.lines/io.output/
io.write` included (`MangaDex.lua:159–183`), whose relative
`userdata/…`-style paths resolve to a **persistent per-module state dir**
(survives restarts; that mapping is what keeps MangaDex's mapping-cache
append working).

### 5.8 GetInfo post-processing pipeline (v3, Round-2 M1 — chapter-link identity)

After `OnGetInfo` returns `no_error`, the host **must** apply FMD2's
normalization (`uData.pas:85–207`) before the result is cached, diffed, or
keyed:

1. title/author/genre/summary cleanup (as `uData.pas`);
2. `Link` fallback from `MANGAINFO.URL` (`:112–113`);
3. pad `ChapterNames` with `''` / prune to match `ChapterLinks` (`:143–152`);
4. Trim each link+name; **case-insensitive duplicate chapter removal**
   (`SameText`, `uData.pas:154–173`) — on duplicates the host **deletes the
   earlier index `j`, so the LAST occurrence's link+name survives**
   (v3 had this inverted);
5. chapter-name cleanup: `Trim(CleanString(RemoveStringBreaks(
   CommonStringFilter(name))))` (`uData.pas:181–183`); optional
   manga-name prefix strip (`OptionRemoveMangaNameFromChapter`,
   `:186–202`) — names feed output filenames (§7.1);
6. **`RemoveHostFromURLsPair`** — strip hosts from chapter links pair
   (`:175–179`); the same normalization applies to update-list scraped
   links (`uUpdateThread.pas:236–239`);
7. `NumChapter := ChapterLinks.Count` (`:205`).

Favorites diffs and `DownloadedChapters` keys operate on these
**post-processed** links. Corpus fixtures must include the normalization
input/output, not just raw module output.

### 5.9 Anti-bot / websitebypass (host-level interceptor)

Per-request hook (FMD2 wires `OnHTTPRequest` for all modules,
`WebsiteModules.pas:359`):

1. On response, antibot heuristics run (403/429/503 + Content-Type/Server
   sniff, `checkantibot.lua:5–12`) with `AllowServerErrorResponse=True`
   forced during the check (`LuaWebsiteBypass.pas:156`); single global
   antibot check at a time.
2. On hit: **cookies are cleared from module settings first** (`:177`),
   then per-module single-flight `____WebsiteBypass(METHOD, URL)`.
   **Single-flight fallthrough semantics** (Round-3 minor 2): the
   single-flight is a `TryEnterCriticalSection` — a concurrent **loser
   proceeds with the plain request** rather than waiting
   (`LuaWebsiteBypass.pas:161, 196–200`); download workers must NOT
   serialize behind an in-progress bypass. Bypass-internal HTTP safely
   re-enters the interceptor because the global antibot lock is released
   before bypass execution (`:94–115` vs `:159`).
3. Resulting cookies + UA persist into module settings; if
   `Storage['reload'] = 'true'` the **original request is re-issued**
   (`:184–188`).
4. Bypassed cookies/UA are shared across the module's HTTP objects via the
   shared state service (§5.3).

### 5.10 What is intentionally NOT in v1

Published per-module capability flags (`/api/modules`) and enforced by the
allowlist: `fmd.subprocess` consumers (TheBlank, RaijinScans, Comix) and
`templates/Madara.lua:169 run_html_load` (no-JS fallback of up to 76
Madara-family sites) — unless the browser sidecar profile (§5.11) is
enabled; Python/webdriver bypass sites likewise. Note (Round-4): Madara's
capability flag must reflect **only `run_html_load`** — its Duktape
image-decryption path (`:176–179`) is default-flow and works without a
browser.

### 5.11 Browser-dependent execution (D2 — sidecar profile)

`utils.nodejs` shells out (`fmd.subprocess.RunCommandHide("cmd.exe",…)`,
npm-installs puppeteer, FlareSolverr, `utils/nodejs.lua:41, 95–180`).
Opt-in compose profile `--profile browser`: FlareSolverr sidecar +
headless Chromium; the `subprocess` stub routes to the sidecar adapter
(bounded concurrency 2, 60 s timeout). Without it: known-broken flags.
`nodejs.run_js` → `node:vm` implementation regardless of profile.

### 5.12 Lua runtime topology

- One **wasmoon engine per worker thread**; chunk re-executed on module
  switch (`LuaWebsiteModuleHandler.pas:33–54`); `lua_gc` stepping every N
  calls (`LuaHandler.pas:136–141`); chunks compiled once, cached by file
  SHA (`LuaWebsiteModules.pas:713–733`).
- Shared module state lives in the state service (§5.3), not in the engine.
- Pool default `min(cpu_count, 8)`, **RSS budget 2 GB** for the pool
  (engines recycled at 25 % over budget).
- WASM OOM (`LUA_ERRMEM`): engine quarantine + rebuild, job retried once,
  then `engine_oom` (D6).

---

## 6. Catalog Pipeline (FMD2-DB)

1. **Update check**: GitHub commits API (1 call) → changed set; per-file
   conditional GET (ETag); rate budget 10 req/s burst 50; resumable.
2. **Fetch**: `<db_url>/7z/<ID>.7z`.
3. **Extract**: `7zz` → temp dir → **atomic rename** to
   `data/catalogs/<ID>.db`.
4. **Read policy**: files are rollback-journal SQLite; attach **read-only**
   (`file:...?mode=ro`). No writes ever touch catalog files. Concurrent
   readers fine.
5. **Search**: FTS5 sidecar (`data/fts/<ID>.db`) keyed by `db_sha`,
   double-buffered replacement; searches during replacement read the
   previous sidecar.
6. **Browse endpoints** (Round-2 minor — "popular" had no defensible
   ordering): `GET /api/catalog/:id/latest` (ordered by `jdn` DESC) and
   `GET /api/catalog/:id/title` (ordered by `title`). No popularity
   ordering exists in the schema (`DBDataProcess.pas:143–153`).
7. **Freshness**: `jdn` = Julian day number (Pascal epoch 1899-12-30);
   shared JDN helper.
8. Fallback for sites without catalogs: live scrape through the module API
   with §5.8 link normalization applied to scraped links.

---

## 7. Downloads & Favorites

### 7.1 Download pipeline

```
Job = chapter (module, manga, chapter link/name)
 1. TaskStart? → GetPageNumber: module sets TASK.PageNumber + PageLinks[]
 2. host iterates WorkId 0..N-1 honoring 'W'/'D' markers; per image:
    GetImageURL → BeforeDownloadImage → download (AcceptImage headers) →
    (SaveImage → returns filename) → AfterImageSaved(FILENAME)
 3. assemble ordered files (module FileNames[] honored)
 4. pack (§7.3)
 5. finalize: atomic move into library/<manga>/<chapter>.<ext> (flat
    series folders — the module is NOT a path segment; a duplicate
    title followed from a second site writes `<manga> [<module>]`
    instead, first writer keeps the clean name)
```

Per-job watchdog per §4; cancellation sets `HTTP.Terminated` and fails
queued requests fast; state machine `queued → running → retry → done |
failed(worker_stalled|engine_oom|net|pack) | cancelled`, persisted,
resumable across restarts.

**Dedupe parity**: FMD2's `downloadedchapters` row = one per
`LowerCase(ModuleID+Link)` holding a case-insensitively **merged** chapter
list (`DownloadedChaptersDB.pas:55, 70–79, 125–128`). Adopted verbatim;
keys are computed on **post-normalization** links (§5.8).

**Filenames**: module `FileNames[]`, filename templates, tail-truncation
when over `CurrentMaxFileNameLength` (0 = no limit) — Windows-desktop
behavior by choice on Linux (D5).

### 7.2 Favorites engine (v3, Round-2 M2 — correct unit: `uFavoritesManager`)

Parity with `TFavoriteThread.DoCheck` (`uFavoritesManager.pas:329–395`):

1. On schedule per favorite: live `GetInfoFromURL` (module GetInfo +
   §5.8 normalization).
2. On success, **immediately** update the favorite's `CurrentChapter`
   (`= ChapterLinks.Count`) and `Status`.
3. **New-chapter diff** = set-difference of live `ChapterLinks` against
   the stored `DownloadedChapterList`, membership tested via
   case-insensitive sorted `IndexOf` (`:364–370`).
4. On auto-download completion, the downloaded chapter list is merged into
   **both** the favorite's stored list and the global
   `downloaded_chapters` (dual-write, `:1131–1133`).
5. Scheduling/multi-threading: favorites checked with bounded concurrency
   (`OptionMaxFavoriteThreads` analog).
6. `DoCheckMissing` (file-based detection, `:397–529`) — **out of scope**
   (D15); the tag-100 "transfer favorite" bulk-ingest case (`:356–361`)
   ships as the favorites-import command (D4).

### 7.3 Packing (v3, Round-2 M5 — memory/streaming)

- ZIP/CBZ: **streaming** (archiver: append-per-image to the output stream;
  disk-backed temp, never whole-chapter in RSS).
- PDF: **streaming writer commitment** (D16): pages appended incrementally
  via a disk-backed incremental writer; pdf-lib only for small/optional
  post-processing; hard per-job memory budget **512 MB**; exceeding it
  fails the job as `pack` (retryable with per-image JPEG re-encode option).
- EPUB: zip-based streaming builder (same discipline as ZIP).
- Pack stage runs under its own watchdog (default 120 s) and reports
  progress per item.

---

## 8. Security Model

**The enforcement boundary is the shim surface, not WASM.**

1. **Egress control**: module HTTP egress filtered — default deny for
   private/link-local ranges (SSRF); optional allow/deny-list per
   deployment.
2. **Filesystem jail**: `Document.LoadFromFile/SaveToFile`, TStrings
   `LoadFrom*/SaveTo*`, `io.open`, and watermark template loading are
   path-jailed (resolved-realpath) to per-job/per-module temp dirs and the
   synced `lua/` tree.
3. **Denied primitives**: `os.execute`, `io.popen`, `require
   'fmd.subprocess'` (unless browser profile), `require` outside the
   synced tree.
4. **JS contexts**: `node:vm` with mandatory timeout, no `process`,
   `require`, `fetch` unless the sidecar adapter provides them.
5. **Supply chain**: production runs pinned SHAs of FMD2 `lua/` and
   FMD2-DB; pin bumps are deployment acts with an auto-generated module
   diff report; CI smoke runs against candidate pins (D9).
6. **Secrets**: accounts encrypted with a deployment-provided key
   (`FMD_WEB_SECRET`, AES-256-GCM). FMD2-compatible decryption (hardcoded
   key, `uBaseUnit.pas:1557–1572`) exists **only** behind the one-shot
   import command (D4).

---

## 9. Data Model (`app.db`, SQLite/WAL)

```
settings(key PK, value JSON)
module_state(id PK, enabled, options JSON, name, root_url, category,
  file, last_seen, cookies TEXT, ua TEXT, capabilities JSON)
catalog_meta(id PK, db_sha, fetched_at, bytes)
favorite(manga_key PK, module_id, url, title, status,
  current_chapter INT, last_check,
  downloaded_chapter_list TEXT)     -- case-insensitive merged list (M2)
job(id PK, type, module_id, payload JSON, state, priority, progress JSON,
  error, idempotency_key UNIQUE, created_at, updated_at)
downloaded_chapters(id PK,          -- = LowerCase(ModuleID+Link)
  chapters TEXT,                    -- case-insensitive merged list
  updated_at)
account(id PK, module_id, username, password_enc, cookies, status)
sync_state(repo PK, sha, fetched_at, report)
-- catalogs: data/catalogs/<id>.db (read-only, native)
-- fts:      data/fts/<id>.db      (sidecar, keyed by db_sha)
```

Retention: `job` history pruned (30 days); backup = documented
`sqlite3 .backup` + file copy; restore validated at startup.

---

## 10. API

```
GET   /api/modules                       capability + known-broken flags
PUT   /api/modules/:id                   enable/disable, options, cookies
POST  /api/sync/modules | /api/sync/catalog/:id | /api/sync/catalog/all
GET   /api/catalog/:id/latest?page=      ordered by jdn DESC (§6.6)
GET   /api/catalog/:id/title?page=       ordered by title
GET   /api/catalog/:id/search?q=&status=&genre=&cursor=   (FTS5, cursor pagination)
POST  /api/info    {moduleId, url}       → live info (normalized §5.8), cached
POST  /api/jobs/download {…, idempotencyKey}
      → identical-key replay: original job, 200
      → key reuse with different payload: 409
GET   /api/jobs?state=&cursor=
WS    /ws          reconnect: client sends lastEventId → server backfills
                   missed events (ring buffer: last 1000 events per job,
                   max age 15 min — older replays get a "resync" hint),
                   then streams live; a hello without a cursor gets the
                   full buffered tail; slow consumers get drop-oldest +
                   a contiguous "gap" marker (D21) instead of silent loss
GET   /healthz /readyz

First-run bootstrap: on startup with an empty data dir, module sync and
catalog sync for the default-selected websites are **auto-triggered**
(with progress surfaced in the UI); the API/UI otherwise guide empty
states explicitly.
```

Auth (owner decision 2026-11): the optional single-password mode is
REMOVED — the app performs no user authentication. The R4 single
app-wide API token (`Authorization: Bearer` on every `/api` route and
`/ws`) is the app's only credential: accepted wherever presented,
never demanded. User-facing auth is a reverse-proxy concern
(Authelia/Authentik/PocketID — docs/API.md).

---

## 11. Repository Layout

```
fmd-web/
├── docker/            Dockerfile (digest-pinned, non-root, 7zz) · compose
│                      (+ `browser` profile: flaresolverr + chromium)
├── server/
│   ├── api/           Fastify routes, WS hub+backfill, auth, rate limits
│   ├── engine/
│   │   ├── lua/       worker pool (engine-per-worker), chunk cache,
│   │   │              deadline/watchdog, module registry, Init pass
│   │   ├── shims/     http (header sets, zstd policy) · txquery (json
│   │   │              node-tree, css, fill overloads) · ixqvalue ·
│   │   │              strings · mangainfo · postprocess (§5.8) · crypto ·
│   │   │              duktape · gzip · fileutil · imagepuzzle · pcre2 ·
│   │   │              antibot interceptor · sidecar adapter
│   │   ├── state/     per-module shared state service (§5.3)
│   │   └── events/    **generated** binding tables from contract.json;
│   │                  CI cross-checks against parsed Pascal dispatchers
│   ├── jobs/          queue lanes, download pipeline, packer, favorites
│   │                  engine (§7.2)
│   ├── sync/          FMD2 lua/ syncer (pin+report) · FMD2-DB syncer
│   └── db/            app.db migrations, catalog ro-attach, FTS sidecar
├── web/               React SPA (Browse · Manga · Favorites · Downloads ·
│                      Settings: module options, cookies, broken flags)
├── contract/          machine-readable §5 contract (binding tables) —
│                      source of generated code and CI checks
├── corpus/            ground-truth triples incl. fill-list forms,
│                      account modules, GetInfo normalization fixtures
└── docs/              DESIGN.md · COMPAT.md · REVIEW-00*.md · runbook
```

---

## 12. Roadmap (measurable exit criteria)

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0 — Contract & ground truth** | contract.json (§5 as data); FPC capture harness (pins internettools + FLRE externally — record the internettools commit in corpus metadata, dialect behavior varies by version; replicate pure string helpers rather than linking `uBaseUnit.pas`, which pulls LCL units); fixtures for ≥50 seed modules incl. JSON-API, **MangaPlus (protobuf/`pb`)**, Madara template, Duktape, imagepuzzle, bypass, **account modules (EHentai et al.)**, and **fill-list page collectors** | corpus replays offline in CI; §5.2 table CI-verified against dispatchers |
| **1 — Engine + shims** | wasmoon host, all §5 shims incl. `pb`, shared-state service | corpus result-equality ≥99 % on seed set; live `GetInfo` (incl. normalization) correct on 10 heterogeneous sites |
| **2 — Ecosystem sweep** | all 417 modules load; catalog sync; browse/search API + minimal UI | ≥95 % modules register; corpus pass ≥95 % of expressions with captured truth; known-broken list published |
| **3 — Downloads** | queue, image pipeline ('W'/'D' resume), streaming packing, WS progress, library | parallel download w/ cancel+resume; dedupe parity tests green; 1000-page chapter packs under memory budget |
| **4 — Favorites** | scheduler + DoCheck-parity diff + dual-write | favorites parity fixtures (incl. normalization + merged-list semantics) green |
| **5 — Hardening** | accounts+import (D4), options UI, proxies (incl. SOCKS), sidecar profile, observability, docs | release 0.1 |

---

## 13. Testing Strategy

1. **Ground-truth corpus** (Phase 0, CI, offline): triples captured from
   FMD2 via the FPC harness (D1). Coverage must include: plain XPath,
   `json(...)` node-tree forms (both `.prop` and `?prop` styles),
   **list-fill overloads**, `css()`, error-swallowing cases, and
   **GetInfo normalization pipelines** (raw module output → post-processed
   result). Results must **equal** FMD2's — pass-without-error is
   necessary-not-sufficient.
2. **Live smoke suite** (nightly, opt-in): rotating module sample;
   per-module pass-rate dashboard with known-broken allowlist.
3. **Shim unit tests**: HTTP (header sets, redirects-as-GET, retry, proxy
   types incl. SOCKS, POST/MimeType rewrite, success=Size>0), TXQuery
   (HTML + JSON + fill overloads + error swallowing), crypto vectors
   (incl. libsodium pull-stream), strings facade, packer outputs
   (streaming zip/pdf/epub validation), dedupe + favorites-diff parity,
   filename truncation.
4. **Chaos**: worker-stall watchdog drills, WASM OOM drill, restart
   mid-download resume, catalog replace-under-read, sync rate-limit
   backoff, WAL checkpoint stall drill.
5. **Contract drift check** (CI): re-parse the Pascal dispatchers each
   sync; diff against `contract/contract.json`; a mismatch fails the build
   — the §5.2 class of error becomes mechanically impossible to
   reintroduce. The extractor is **conservative**: the dispatcher call
   vocabulary is small and stable (`LoadObject`, `LuaPushNetStatus`,
   `LuaPushAccountStatus`, `luaPushIntegerGlobal`, `luaPushStringGlobal`,
   `lua_getglobal` read-back, `lua_tointeger`/`lua_toboolean`/
   `luaToString` returns) — any unrecognized call pattern inside a `Do*`
   body fails the build loudly, so upstream refactors cannot silently
   neuter the check. **v5: the check extends to the facade method tables**
   (`LuaXQuery.pas:192–201`, `LuaImagePuzzle.pas:73–91`, `LuaDuktape.pas`,
   `LuaStringsStorage.pas:143–159`, `LuaCrypto.pas:429–494`) so
   method-surface omissions of the Round-4 class (`ParseHTML`, JS
   `require`) are caught mechanically rather than by review.

---

## 14. Decision Log

| # | Question | Decision/Proposal |
|---|---|---|
| D1 | Corpus ground truth | FPC console harness linked against internettools; desktop capture as cross-check |
| D2 | Anti-bot: sidecar vs stub | stub default + known-broken flags; opt-in `browser` profile; global antibot serialization preserved |
| D3 | v1-broken sites acceptable | yes, published via capability flags; ≥95 % register + corpus-pass target |
| D4 | Desktop data compatibility | one-shot import commands (modules.json, downloadedchapters.db, EncryptString format for migration only); native storage uses deployment secret |
| D5 | Filename/path semantics on Linux | **deliberate Windows-desktop parity** (tail-truncation, `CurrentMaxFileNameLength`; 0 = no limit); `--normalize-paths` opt-out — **implemented**: `FMD_NORMALIZE_PATHS=1` / CLI `--normalize-paths` switches to sanitized Linux-normalized paths (same sanitization, control units C0+DEL deleted, NO tail truncation) via the single `applyFileNamePolicy` choke point in `@fmd/contract` both filename resolvers share; flag unset = byte-identical goldens |
| D6 | Wasmoon OOM policy | engine quarantine + rebuild; job retried once; then `engine_oom` |
| D7 | Catalog write policy | read-only ATTACH; FTS sidecar keyed by `db_sha`, double-buffered |
| D8 | Favorites trigger semantics | **`uFavoritesManager.TFavoriteThread.DoCheck` parity** (not `uUpdateThread`): live GetInfo + immediate `CurrentChapter`/`Status` update + case-insensitive IndexOf set-difference + dual-write merge (§7.2) |
| D9 | Upstream trust / pin review | pins bump via PR w/ module-diff report; CI smoke on candidate pin; auto-bump disabled |
| D10 | `SelectedLanguage` | fixed 'en' (captions only; values keyed by option name — language cannot shift stored values; verified MangaPlus/Tapas/WeebCentral) |
| D11 | Dropped-units cost accounting | none dropped silently; deferrals recorded in COMPAT.md with module counts |
| D12 | Same-module concurrency (Round-2 C3) | **concurrent, FMD2-faithful**: shared per-module state service (cookies/Storage/Account/settings/bypass/limiter) with defined locking; Lua engine locals stay per-worker (§5.3) |
| D13 | zstd (Round-2 M3) | **omit from `Accept-Encoding` by default** (advertise only what we decode: gzip/deflate/br); documented divergence; decoder add-on if smoke tests show sites breaking |
| D14 | "Popular" endpoint (Round-2 minor) | replaced by `/latest` (jdn DESC) and `/title`; no popularity data exists in schema |
| D15 | `DoCheckMissing` scope | **out of v1**; favorites-import command covers the transfer-favorite case |
| D16 | PDF packing memory (Round-2 M5) | **streaming/append writer commitment**, disk-backed, 512 MB per-job budget, `pack` failure is retryable |
| D17 | `pb` (lua-protobuf) — Round-3 M1 | **protobufjs-backed `package.preload['pb']` shim** (`decode`/`encode`/`load`) — covers MangaPlus and `utils/protoc.lua`'s `has_pb` branch; on the §8 require allowlist; MangaPlus in Phase-0 seed |
| D18 | zstd add-on trigger | concrete: nightly live-smoke auto-detects undecoded bodies (content-type/body mismatch); **≥2 affected modules in one week** flips the decoder on and `Accept-Encoding` gains zstd |
| D19 | WS backfill bound | ring buffer: last 1000 events per job, 15 min max age; older → "resync" hint (§10) |
| D20 | First-run bootstrap | auto-trigger module+catalog sync on empty data dir (default; disable via env — **implemented**: `FMD_BOOTSTRAP_DISABLE=1` short-circuits the first-run sync entirely — zero sync jobs enqueued, zero upstream traffic, `/readyz` stays green with the lua-tree readiness check dropped); explicit empty-state UI |
| D21 | WS slow consumers | per-subscriber bounded outbound queue; overflow → **drop-oldest + one contiguous `gap` marker** (client refetches and resets its cursor — same obligation as `resync`); the hello/replay step enqueues unbounded (ring-capped), so a backfill is never truncated by the connection's own queue; pump gate = `socket.bufferedAmount` soft cap, overridable per deployment (`canSend`) since kernels absorb writes for paused readers; dropped `resync` hints are re-emitted at the tail |

---

## 15. Standing ecosystem metric

Per-module capability matrix + pass rates published via `/api/modules` and
rendered in Settings → Modules. Upstream regressions surface within one
nightly smoke run — before users hit them.
