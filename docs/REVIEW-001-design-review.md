# REVIEW-001 — Adversarial Design Review of DESIGN.md v1

Reviewer: independent skeptical-architect agent, tasked with verifying
design claims against the FMD2 source at `/workspace/FMD2` and hunting
robustness/scalability/maintainability gaps.

Status: **accepted** — all Critical (C1–C6) and Major (M1–M8) findings are
incorporated into DESIGN.md v2. See the corrections table and open questions
at the end.

---

## Verdict summary

The core stack bet (TypeScript + wasmoon + FontoXPath) is defensible, and the
catalog strategy (native FMD2-DB files, SHA-pinned sync) is sound. But the
document's centerpiece — §5, the "fully specified compatibility contract" —
is demonstrably **incomplete and partially wrong**: it omits three
heavily-used object surfaces (`MODULE` — 199 module files, `TASK` — 190
files, the IXQValue result object — ~350 files of usage), misstates the
event return protocol (booleans vs codes), and invents HTTP properties that
don't exist (`Retry`, `AllowAbort`, `Trailers`) while missing the real ones.
The conformance-corpus mitigation for the XPath dialect gap has **no
ground-truth strategy** — a corpus run without InternetTools can only detect
crashes, not wrong results, and the JSON dialect (`json(*).meta.total` vs
`?prop`) is a tree-node model, not XPath 3.1 maps, so the planned shim
translation is a heuristic that will silently diverge. The websitebypass
pipeline (anti-bot interceptor + Python/WebDriver/FlareSolverr) and
`utils.nodejs` (cmd.exe + puppeteer) are described as something they are
not; both need redesign, not "porting." In its current state the design
would not survive contact with the first integration sprint — the contract
must be re-derived from source.

## Critical findings

### C1. §5 omits the `MODULE` and `TASK` globals — used by half the ecosystem
- **Evidence**: `LuaWebsiteModuleHandler.pas:49` (`M.LuaPushMe` → global
  `MODULE`); `LuaWebsiteModules.pas:991–1039` (full meta-table);
  `LuaDownloadTask.pas:21–32` (`TASK` surface: `PageLinks, ChapterLinks,
  ChapterNames, PageContainerLinks, FileNames, CurrentDownloadChapterPtr,
  PageNumber, CurrentMaxFileNameLength, Link`). Usage: `MODULE.` in 199
  module files + 39 templates (`MODULE.GetOption` 28 files, module cookie
  methods 31 files, `MODULE.Storage` 23 files, `MODULE.RootURL` essentially
  everywhere); `TASK.` in 190 module files; `TASK.PageNumber` is
  **module-written** (`uDownloadsManager.pas:117–160` — the Pascal worker
  iterates `WorkId 0..PageNumber-1`), `TASK.FileNames` module-written,
  `CurrentMaxFileNameLength` consumed by 97 modules.
- **Why it matters**: missing any of these = runtime nil-index errors across
  ~50% of modules and silently broken page pipelines.
- **Fix**: add `MODULE` and `TASK` to §5.2 with full surfaces; spec
  `TASK.PageNumber`/`PageLinks[WORKID]` as the in/out contract of the image
  pipeline; replicate the `'W'`/`'D'` work markers in `PageLinks`
  (`uDownloadsManager.pas:350–407`).

### C2. The IXQValue result object is entirely absent from §5.3
- **Evidence**: `LuaIXQValue.pas:135–148`: `Get()` (Lua iterator for
  generic-for, or `Get(i)`), `GetAttribute(name)`, `GetProperty(name)`,
  `InnerHTML()`, `OuterHTML()`, `InnerText()`, `ToString()`, property
  `Count`. Usage: `ToString()` 577, `GetProperty` 319, `.Get()` 305,
  `GetAttribute` 110, `.Count` 110. Also missing methods `XPathHREFAll`
  (60 files), `XPathHREFTitleAll` (28), `ParseHTML` (60)
  (`XQueryEngineHTML.pas:74–75, 150–176, 556–562`).
- **Fix**: add the IXQValue facade and missing methods with exact
  string-coercion rules (see C3).

### C3. The dialect-gap plan has no ground truth and mis-models the JSON dialect
- InternetTools JSON is a **node tree**, not XPath 3.1 maps:
  `json(*).meta.total`, `json(*).data()` are node-steps/fn:data; the
  `?prop` map form also appears in some modules.
- **Error swallowing**: `TXQueryEngineHTML.Eval` wraps everything in
  `try…except end` → malformed/unsupported expressions yield `''`, not
  exceptions (`XQueryEngineHTML.pas:358–399`).
- **String coercion**: `IXQValue.toString` of element = inner text;
  `XPathStringAll` joins with `", "` after `Trim`; GET "success" requires
  `Document.Size > 0` (`httpsendthread.pas:559`). linkedom's `String(node)`
  is outerHTML — naive facades diverge.
- **Parser layer**: internettools' repairing parser (not HTML5) vs linkedom:
  whitespace text nodes (`string-join(//text())` in modules), implicit-tag
  repair, attribute casing. `css("div#info > h1")` used in 3 modules.
- **Corpus flaw**: without InternetTools there is no result-level oracle;
  "expression passes" ≠ "result correct".
- **Fix**: harvest ground truth by driving FMD2 desktop (or an FPC harness
  against internettools) over captured fixtures → (doc, expression,
  expected-result) triples; add `css()` and empty-result semantics to the
  shim contract.

### C4. websitebypass is a host-level HTTP interceptor with external process dependencies
- **Evidence**: `WebsiteModules.pas:359` wires `OnHTTPRequest` for **every**
  module request; `LuaWebsiteBypass.pas:142–209`: request →
  `CheckAntiBotActive` (global Lua state + critical section running
  `checkantibot.lua`) → single-flight per module via
  `websitebypass.lua ____WebsiteBypass(METHOD, URL)` → persists cookies+UA
  into module settings. `lua/websitebypass/` contains **`cloudflare.py`,
  `close_webdrive.py`** (Python + webdriver); `cloudflare.lua` evaluates
  challenge JS requiring a **`Duktape` global polyfill** (`Duktape.enc/dec`)
  and `HTTP.Terminated`-aware sleep loops.
- **Fix**: spec the anti-bot hook in the HTTP shim contract (403/429/503 +
  sniffing), single-flight + global serialization model, cookie
  persistence, `Duktape` polyfill in `node:vm`, explicit container decision
  on Python/Chromium/FlareSolverr.

### C5. `utils.nodejs` shells out to Windows cmd + puppeteer — cannot be routed to node:vm
- **Evidence**: `utils/nodejs.lua:41` runs
  `fmd.subprocess.RunCommandHide("cmd.exe","/c",…)`, npm-installs
  **puppeteer**, writes temp scripts via `io.open`, integrates
  **FlareSolverr**, persists sessions in `MODULE.Storage`. Consumers:
  TheBlank, RaijinScans, Comix, and `templates/Madara.lua:169` (`run_html_load`)
  — the no-JS fallback of up to 76 Madara-based sites.
- **Fix**: explicit shim contract for `nodejs.run_js / run_html_load /
  run_html_load_with_js`; enumerate knowingly-unsupported v1 sites; spec
  allowed `io.open/os.time/os.date/os.remove` surface (29 files use them).

### C6. Boolean vs numeric event-return protocol is misstated
- **Evidence**: GetDirectoryPageNumber / GetNameAndLink / GetInfo return
  **byte codes** (`lua_tointeger`, `LuaWebsiteModules.pas:209, 238, 260`);
  the other **11 events return booleans** (`lua_toboolean`, `:165, 183,
  278, 299, 321, 343, 365, 405, 424, 442, 459`). Constant is
  `information_not_found` (0 module references); modules return only
  `no_error` / `net_problem`. Account-status globals
  `asUnknown/asChecking/asValid/asInvalid` (`:832–838`), `WORKID`,
  `PATH`/`FILENAME` unlisted.

## Major findings

### M1. HTTP shim surface wrong in both directions
Invented: `Retry`, `AllowAbort`, `Trailers` (don't exist,
`LuaHTTPSend.pas:152–178`). Missing: `MimeType, UserAgent, RetryCount,
EnabledCookies, FollowRedirection, MaxRedirect, AllowServerErrorResponse,
Compress` (`:190–197`). `SetProxy(ProxyType, Host, Port, User, Pass)` with
`'HTTP'|'SOCKS4'|'SOCKS5'` (`:91–96`) — needs SOCKS agent in undici.
`Document` is a raw TMemoryStream facade (`LuaMemoryStream.pas:67–80`; POST
bodies written into it, `httpsendthread.pas:744–748`; success =
`Document.Size > 0`). Behavioral parity: redirects add `Referer` of prior
URL and follow 301/302/303/307 **as GET**, max 5; retry >500 no delay;
default `RetryCount=0`; `XHR` = GET + `X-Requested-With`; POST moves
Content-Type to MimeType and rewrites `text/html` →
`application/x-www-form-urlencoded; charset=UTF-8`; URL massaging
(`httpsendthread.pas:466–560, 786–792`).

### M2. Per-module-per-worker Lua engines will not scale
FMD2 keeps **one Lua state per worker thread** and re-executes the module
chunk on module switch, GC every 16 calls (`LuaWebsiteModuleHandler.pas:33–64`,
`LuaHandler.pas:136–141`). The design proposed 418 engines × N workers —
RSS blow-up; also contradicts its own Risk #5 mitigation. Fix: adopt FMD2's
shape; bytecode cache matches `TLuaWebsiteModulesContainer.ByteCode`
(`LuaWebsiteModules.pas:713–733`).

### M3. Catalog ATTACH/FTS plan conflicts with "bit-identical" + journal modes
FMD2-DB files are **rollback-journal** SQLite (no WAL in
`DBDataProcess.pas`/`SQLiteData.pas`). "FTS5 index built locally per
catalog" implies writes to attached files. Fix: ATTACH
`file:…?mode=ro` (URI), FTS sidecar keyed by `db_sha`, atomic replace dance
documented, sidecar invalidated by `db_sha`.

### M4. Cookie/session persistence model missing
Module cookie manager is shared + **persisted to modules.json**
(`WebsiteModules.pas:353–360, 616–682`); bypass cookies+UA persisted into
module settings (`LuaWebsiteBypass.pas:181–183`); account credentials use a
**hardcoded AES key** `'B74945FB50E84FD58BF9FEAB8E4BEA6B'`
(`uBaseUnit.pas:1557–1572`). Fix: persistent per-module cookie jar +
settings.cookies/UA in the data model; explicit EncryptString-format
decision.

### M5. No timeout/watchdog for Lua events
WASM Lua cannot be preempted from JS; a hung module pins the worker
forever. Fix: per-event wall-clock deadline (HTTP-shim enforced + deadline
checks), wedged-worker detection → job failure + engine recycling; keep
`sleep` truly blocking (`LuaBase.pas:72–76`) since bypass timing depends on
it, with `HTTP.Terminated` cooperative checks.

### M6. Security claim wrong — the boundary is the shim surface, not WASM
Shims are privileged Node; `node:vm` is not a security mechanism; modules
are synced from upstream master — a compromised upstream module becomes
RCE-by-config. Fix: HTTP egress deny/allow-list (no RFC1918/link-local),
fs shim path-jailed, `os.execute/io.popen/subprocess` denied, package
loader restricted to synced tree, `node:vm` timeouts, production trust
root = pinned SHA with review gate on drift.

### M7. Download/dedupe/favorites parity gaps
Dedupe in FMD2 = one row per `LowerCase(ModuleID+Link)` with
case-insensitively **merged** chapter string (`DownloadedChaptersDB.pas:62–78,
126`); design's PK differs. Filename truncation keeps the **tail**
(`uDownloadsManager.pas:545–547`); filename templates unmentioned; `jdn`
freshness needs Pascal `DateToJDN` parity (epoch 1899-12-30).

### M8. Exit criterion "95% corpus pass" not measurable; licensing shallow
Expression-pass ≠ correct-result ≠ module-pass. Fix: FMD2-captured fixture
equality + nightly live smoke dashboard with known-broken allowlist.
License audit must cover vendored utils (rxi/json MIT, crypto-js, …) and
DB content provenance, not just "GPLv2-compatible".

## Minor findings

- Discovery scans `*.lua;*.luac`; `NewWebsiteModule` available only during
  `Init()` call; base state also carries `print/sleep`, `CreateTXQuery`,
  `Trim/MaybeFillHost/MangaInfoStatusIfPos`, `GetBetween/SeparateLeft/
  SeparateRight` (`LuaBase.pas:78–97`, `LuaSynaUtil.pas:36–46`,
  `LuaWebsiteModules.pas:481–493, 644`).
- `fmd.env` misses `ExeName` (`LuaFMD.pas:21`).
- `fmd.crypto` misses ~20 functions: `RC4` (needs OpenSSL legacy provider
  parity plan), `AES*GCM`(+AAD), `X25519_*`, `P256_*`, `SecretStream_*`
  (libsodium-only → sodium-native), `PBKDF2SHA256`, Base64URL, CRC16/32,
  MD4, LongHash variants, UU/UUE, URL encode/decode, synacode block
  (`LuaCrypto.pas:429–494`).
- `fmd.duktape` = single method `ExecJS(js)` (`LuaDuktape.pas:27–30`); JS
  contexts must polyfill `Duktape.enc/dec`.
- TStrings facade misses `AddText, IndexOfName, CommaText, DelimitedText,
  Delimiter, NameValueSeparator, Values[]`, 0-based default indexing
  (`LuaStrings.pas:222–263`).
- `MangaInfoStatusIfPos` exact semantics/output constants (128 modules;
  `uBaseUnit.pas:2793–2852`); `Trim(s, chars)` custom-charset variant
  (`LuaBaseUnit.pas:17–24`).
- No module uses `OnSaveImage`/`WORKPTR`; `OnAfterImageSaved` used once
  (FanFox.lua:147 → `RemoveWatermark(FILENAME,…)`; loads
  `'extras\\mangafoxtemplate'` with **Windows backslash path** + PNG assets
  — needs path translation + asset shipping).
- BullMQ-on-SQLite with better-sqlite3 is synchronous — image-level
  progress writes serialize; need write coalescing + WAL checkpoint sizing.
- GitHub raw fetches: up to 418 fetches/sync with no conditional GET /
  ETag / rate-limit budget; use commits API for update checks.
- Docker: non-root USER, SIGTERM graceful drain (temp-dir + atomic rename),
  healthcheck, memory limits for worker pool unspecified.
- API: no idempotency key on job creation, no pagination/cursor scheme, WS
  reconnection/backfill unspecified, no auth rate limit, no backup/restore,
  no retention policy, no observability (per-module latency/error, queue
  depth, engine GC stats).
- `downloaded_chapter` vs `downloaded_chapters` naming drift.
- i18n: decide constant value of `fmd.env.SelectedLanguage` in-container.

## Corrections to §5 compatibility contract

| # | Design v1 says | Source says | Evidence |
|---|---|---|---|
| 1 | Globals `no_error / net_problem / info_not_found` | Constant is `information_not_found`; modules use only `no_error`/`net_problem` | `LuaWebsiteModules.pas:825–830`; `WebsiteModules.pas:18–21` |
| 2 | Every event returns a code | 11 of 14 events return **booleans**; only 3 return codes | `LuaWebsiteModules.pas:209,238,260` vs `:165,183,278,299,321,343,365,405,424,442,459` |
| 3 | Global table without `MODULE`, `TASK`, `WORKID`, `PATH`/`FILENAME` | `MODULE`, `TASK`, `WORKID`, `PATH`/`FILENAME`, `asUnknown…asInvalid`; `UPDATELIST` also in GetNameAndLink | `LuaWebsiteModuleHandler.pas:49`; `LuaWebsiteModules.pas:202–206, 227–236, 294–297, 315–318, 337–340, 359–362, 380–383, 402, 420–421, 832–838` |
| 4 | Module props incl. `Language` | No `Language`; real: `MaxTaskLimit, MaxThreadPerTaskLimit, MaxConnectionLimit, ActiveTaskCount, ActiveConnectionCount, SortedList, InformationAvailable, FavoriteAvailable, DynamicPageLink, CurrentDirectoryIndex, LastUpdated, Tag, Storage, Account{…}` + cookie methods + `GetOption` | `LuaWebsiteModules.pas:991–1039` |
| 5 | HTTP props incl. `Retry, AllowAbort, Trailers` | Don't exist; real extras: `MimeType, UserAgent, RetryCount, EnabledCookies, FollowRedirection, MaxRedirect, AllowServerErrorResponse, Compress` | `LuaHTTPSend.pas:171–198` |
| 6 | `SetProxy(url)` | `SetProxy(ProxyType, Host, Port, User, Pass)`, `'HTTP'|'SOCKS4'|'SOCKS5'` | `LuaHTTPSend.pas:91–96`; `httpsendthread.pas:848–897` |
| 7 | `Document` = lazy-parsed body | Raw TMemoryStream facade; POST bodies ride in it; success = `Document.Size>0` | `LuaMemoryStream.pas:67–80`; `httpsendthread.pas:744–748, 559` |
| 8 | TXQuery methods only XPath/XPathString/XPathStringAll/XPathCount | + `XPathHREFAll`, `XPathHREFTitleAll`, `ParseHTML`; `XPath()` returns IXQValue with `Get()/Get(i), GetAttribute, GetProperty, InnerHTML, OuterHTML, InnerText, ToString, Count` | `LuaXQuery.pas:192–201`; `LuaIXQValue.pas:135–148` |
| 9 | JSON → XPath 3.1 maps; `.prop`→`?prop` | InternetTools JSON = node tree; `?prop` also used; `css("…")` used; errors swallowed → empty; `XPathStringAll` joins `", "` trimmed | `XQueryEngineHTML.pas:10, 346–399`; `AsuraScans.lua:24–28`; `CapibaraTraductor.lua` |
| 10 | Helpers: Trim, MaybeFillHost, MangaInfoStatusIfPos | Also `GetBetween, SeparateLeft, SeparateRight` | `LuaSynaUtil.pas:36–46`; `LuaBase.pas:89–97` |
| 11 | `fmd.duktape` "(eval, context objects)" | Single `ExecJS(js)`; JS needs `Duktape.enc/dec` polyfill | `LuaDuktape.pas:27–30`; `cloudflare.lua:55–56` |
| 12 | `fmd.crypto` partial list | Missing ~20 functions incl. libsodium-only ones | `LuaCrypto.pas:429–494` |
| 13 | `utils.nodejs` → node:vm via duktape shim | Shells `cmd.exe` + puppeteer + FlareSolverr via `fmd.subprocess` | `utils/nodejs.lua:41, 95–105, 162–180` |
| 14 | strings facade partial | + `AddText, IndexOfName, CommaText, DelimitedText, Delimiter, NameValueSeparator, Values[]`, 0-based indexing | `LuaStrings.pas:222–263` |
| 15 | UPDATELIST unspecified | `CurrentDirectoryPageNumber` (get/set, monotonic guard) + `UpdateStatusText(msg)` | `LuaUpdateListManager.pas:36–41`; `uUpdateThread.pas:451–459` |
| 16 | Engine per module per worker | FMD2: one state per thread; chunk re-exec on module switch; GC every 16 calls | `LuaWebsiteModuleHandler.pas:33–64`; `LuaHandler.pas:136–141` |
| 17 | `sleep` host-aware cancellation | Hard blocking Sleep; cooperative via `HTTP.Terminated` in bypass loops | `LuaBase.pas:72–76`; `cloudflare.lua:26–33` |

## Open questions the team must answer

1. Ground-truth strategy for the corpus: FMD2-desktop capture runs vs FPC
   harness linked against internettools; coverage target.
2. Anti-bot product decision: Chromium/FlareSolverr sidecar vs stub +
   known-broken list vs external solver proxy; concurrency policy replacing
   the global antibot critical section.
3. Which sites are v1-broken by design (nodejs/puppeteer/Python-bypass
   consumers; Madara no-JS fallback) and is that acceptable?
4. Desktop-FMD2 data compatibility (modules.json import,
   downloadedchapters.db import, `EncryptString` format + hardcoded key)?
5. `CurrentMaxFileNameLength`/Windows path semantics on Linux: byte-parity
   vs normalized?
6. Wasmoon failure modes on WASM OOM (`LUA_ERRMEM`): quarantine policy,
   worker loss = job retry acceptance.
7. Catalog write policy: read-only attach confirmed; FTS sidecar location +
   invalidation on replace-under-reader.
8. Favorites trigger semantics: which `uUpdateThread` behaviors are
   in-scope parity for Phase 4 (mid-download chapters, case-variant links,
   ordering).
9. Upstream trust: who reviews module diffs between pins before users'
   containers get them?
10. Single-maintainer realism: which binding units can be dropped from v1
    with documented module-count cost (imagepuzzle 7 modules,
    mangafoxwatermark 1, subprocess 3 via nodejs)?
