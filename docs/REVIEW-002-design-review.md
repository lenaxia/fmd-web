# REVIEW-002 — Adversarial Design Review, Round 2 (of DESIGN.md v2)

Reviewer: independent skeptical-architect agent. Round-1 findings were
already incorporated into v2; this round verified the v2 fixes against
FMD2 source and hunted for new gaps. Status: **accepted** — all findings
incorporated into DESIGN.md v3.

---

## Verdict summary

v2 genuinely fixed most of Round 1's findings — the HTTP surface, IXQValue
facade, TStrings facade, engine topology, websitebypass redesign, catalog
read policy, dedupe key, 'W'/'D' markers, watchdogs, and the corpus
ground-truth strategy all check out against source. But the centerpiece of
the v2 fix — the §5.2 event/global binding table — **was re-derived
incorrectly and is again wrong in 9 of 15 rows**, including a fabricated
`ACCOUNT` global that does not exist anywhere in the host; the contract
must be corrected a third time before implementation. Beyond that, Round 2
found real gaps Round 1 missed: the host-side GetInfo post-processing
pipeline (`uData.pas`) that defines chapter-link identity for
favorites/dedupe parity is absent from the contract; the favorites diff
engine is misattributed to `uUpdateThread` and under-specified; the HTTP
shim misses zstd (FMD2 both advertises and decodes it); the
`XPathStringAll(expr, TStrings)` fill-a-list overload — the primary way
modules fill `TASK.PageLinks` — is missing from §5.5; and PDF/EPUB packing
memory is unaddressed. The design is close; the remaining work is contract
precision, not architecture.

## Critical findings

### C1. §5.2 event/global binding table wrong in 9 of 15 rows; fabricated `ACCOUNT` global

`MODULE` is bound for *every* event via `GetLuaWebsiteModuleHandler` →
`LuaPushMe` (`LuaWebsiteModuleHandler.pas:47–49, 59–64`). Actual bindings
from the Do* dispatchers (`LuaWebsiteModules.pas`):

| Event | Actually bound | Source rows |
|---|---|---|
| Before/AfterUpdateList | `UPDATELIST` (+MODULE) — **no HTTP** | 154–188 |
| GetDirectoryPageNumber | HTTP, UPDATELIST, `PAGENUMBER` (**read back**), `WORKPTR` | 201–222 |
| GetNameAndLink | HTTP, NAMES, LINKS, UPDATELIST, URL | 229–247 |
| GetInfo | MANGAINFO, HTTP, URL | 253–269 |
| TaskStart | `TASK` only — **no HTTP** | 267–283 |
| GetPageNumber | TASK, HTTP, URL — **no WORKID** | 285–304 |
| GetImageURL | TASK, HTTP, WORKID, URL | 306–323 |
| BeforeDownloadImage | TASK, HTTP, WORKID, URL (**push-only** — never read back, unlike PAGENUMBER) | 325–347 |
| DownloadImage | TASK, HTTP, WORKID, URL | 349–366 |
| SaveImage | `HTTP, PATH, FILENAME` — **TASK invented, HTTP omitted in v2**; returns string | 368–391 |
| AfterImageSaved | `FILENAME` only — **no TASK, no WORKID** | 393–410 |
| Login | account-status constants, HTTP — **no `ACCOUNT` global exists** | 412–429 |
| AccountState | account-status constants only | 431–447 |
| CheckSite | account-status constants only — **no HTTP** | 449–465 |

Fix: regenerate mechanically from the 15 dispatchers; delete `ACCOUNT`;
document `MODULE.Account` (created only when `AccountSupport=true`,
`WebsiteModules.pas:258–270`; meta-table property only if the object
exists, `LuaWebsiteModules.pas:1035–1036`).

### C2. §5.1 module property list omits `TotalDirectory` and `AccountSupport`

Meta-table exposes `TotalDirectory` (get/set, `:1028`) and `AccountSupport`
(get/set, `:1029`). `TotalDirectory` set by directory-page family (Tapas,
NiAdd, NovelCool, JapScan…); `AccountSupport = true` by every login
module/template (EHentai, SanaScans, ReadManga, DataLife/VTheme/EZManga/
GroupLe templates…). Without `AccountSupport` the `Account` object is never
created → all account modules break. Also missing: the `On*` event-name
string properties and `Guardian`.

### C3. `MODULE` ownership mis-modeled; same-module concurrency unspecified

FMD2's Lua *wrapper* is per-thread, but the underlying state — `Storage`
(locked, `LuaStringsStorage.pas:17, 75`), `CookieManager` (locked),
`Account` (own Guardian), `Settings`, `ConnectionsQueue` — is **one shared
per-module object set accessed concurrently**: favorites run concurrent
checks (`uFavoritesManager.pas:717, 737`), downloads run
`MaxThreadPerTaskLimit` threads per task (`uDownloadsManager.pas:870–920`),
update-list runs concurrent GetInfo (`uUpdateThread.pas:832–833, 898`).
Nothing serializes the Lua events themselves. v2 §5.2's "per-worker
persistent" MODULE contradicts §5.8 (shared bypass cookies) and Round-1 C5
(`utils.nodejs` sessions in `MODULE.Storage`). Fix: per-module **shared
state service** with defined locking, independent of the worker pool;
same-module events may run concurrently (FMD2 semantics).

## Major findings

### M1. GetInfo post-processing pipeline absent — defines chapter-link identity
After `OnGetInfo`, the host normalizes (`uData.pas:85–207`): title/author/
genre cleanup, `Link` fallback (`:112–113`), pad/prune `ChapterNames` to
match `ChapterLinks` (`:143–152`), **case-insensitive duplicate chapter
removal** (`SameText`, `:154–173`), **`RemoveHostFromURLsPair`** stripping
hosts from chapter links (`:175–179`), `NumChapter := ChapterLinks.Count`
(`:205`). Same normalization for update-list scraped links
(`uUpdateThread.pas:236–239`). Favorites diff and DownloadedChapters keys
operate on post-processed links. Fix: contract + corpus fixtures.

### M2. Favorites engine misattributed and under-specified
The new-chapter engine is `TFavoriteThread.DoCheck`
(`uFavoritesManager.pas:329–395`): live `GetInfoFromURL`, clone TMangaInfo,
immediately update `CurrentChapter`/`Status`, then diff = set-difference of
`ChapterLinks` vs stored `DownloadedChapterList` via case-insensitive
sorted `IndexOf`; on download, merged into **both** favorite list and
`DLManager.DownloadedChapters` (`:1131–1133`); plus tag-100 transfer case
(`:356–361`) and `DoCheckMissing` file-based variant (`:397–529`).
`uUpdateThread` is the catalog updater, not favorites. Fix: re-scope D8,
spec the diff algorithm + dual-write, state DoCheckMissing scope.

### M3. zstd + default header sets missing from HTTP shim
`ResetBasic` advertises `Accept-Encoding: gzip, deflate, br, zstd`
(`httpsendthread.pas:945`) and decodes zstd (`:684–698`); Node/undici LTS
cannot decode zstd. Also: `Reset` sets DNT/Upgrade-Insecure-Requests/
Accept/Accept-Language/Accept-Charset (`:924–932`); image phase swaps
`Accept: image/webp,*/*` via `AcceptImage` (`:919–922`, called at
`uDownloadsManager.pas:369–370`). Fix: decide zstd policy; spec default
header sets.

### M4. `XPathStringAll(expr, TStrings)` fill-a-list overload missing
Binding supports output-to-TStrings (`LuaXQuery.pas:124–128, 142–145`);
modules use it on the hot page-collection path (LxHentai.lua:84,
Tapas.lua:86, WeebCentral.lua:106, MangaDemon.lua:81, Hentai2Read.lua:86 —
with `json(...)` inside, ReadComicsOnlineRU.lua:78). §5.5 documented only
the string-join form. Fix: add 2-arg and node-context fill forms for
`XPathStringAll`/`XPathHREFAll`/`XPathHREFTitleAll`.

### M5. Packing has no memory/streaming story
§7 names pdf-lib/epub builders without streaming or memory budgets;
pdf-lib materializes whole documents; 500MB+ chapters → container OOM.
Fix: streaming/append strategies, disk-temp discipline, pack watchdog.

## Minor findings

- `fmd.fileutil` is 3 pure helpers (`ExtractFileName`,
  `ExtractFileNameOnly`, `SerializeAndMaintainNames`,
  `LuaFileUtil.pas:33–39`) — not an fs API.
- `fmd.gzip` is a single `Inflate` (`LuaGZip.pas:47–50`);
  `SecretStream_*` is pull-side only (`LuaCrypto.pas:471–472`).
- `HTTP.Document` facade misses `ReadString` (alias of `ToString`); `Size`
  is writable (`LuaMemoryStream.pas:68–80`).
- better-sqlite3 + worker_threads: legal, but needs per-thread
  connections, single-writer job claiming, `busy_timeout`/WAL checkpoint
  sizing.
- `409 on replay` idempotency is backwards: identical-key replay should
  return the original job; 409 reserved for key reuse with different
  payload.
- `GET /api/catalog/:id/popular` unfalsifiable — schema has no popularity
  (`DBDataProcess.pas:143–153`); ordering can only be title/jdn.
- Reproducibility: pin wasmoon's Lua build, FontoXPath, sharp/libvips,
  Node LTS line, base image digest.
- D5 caveat: tail-truncation is `{$IFDEF WINDOWS}`-only
  (`uDownloadsManager.pas:543–550`); `CurrentMaxFileNameLength` is 0 until
  computed on Windows (`:477, 768–770`) — treat 0 as no-limit; doc should
  own the choice of Windows-desktop behavior on Linux.
- FMD2's connection-queue wait ignores termination
  (`httpsendthread.pas:417–435`) — fmd-web should fail queued requests
  fast on abort.
- websitebypass nuances: cookies **cleared** from settings before bypass
  attempt (`LuaWebsiteBypass.pas:177`); successful bypass re-issues the
  original request if `Storage['reload']` = 'true' (`:184–188`); antibot
  check forces `AllowServerErrorResponse=True` (`:156`).
- Citation drift: drop missing-ID/Name is `:523–533`; URL massaging
  `:612–616` + `MaybeEncodeURL :394–400`.
- Log volume: WARN-per-failed-expression needs rate-limit/dedup;
  "memory-capped", "token-bucket", "(ETag'd)" need concrete numbers.
- Verified good: D10 (fixed 'en' is captions-only; option values keyed by
  `CleanOptionName(Name)`, combobox = index — language cannot shift stored
  values; MangaPlus.lua:16, Tapas.lua:107, WeebCentral.lua:137).

## v2-fix verification

3-codes/11-booleans, SaveImage-string, return constants, TASK surface,
'W'/'D' markers, tail truncation, dedupe key+merge, HTTP surface+behavior,
TStrings facade, error swallowing/JSON node-tree/css, Init-phase rules,
base globals, fmd.env, fmd.duktape, crypto list (except SecretStream
direction), websitebypass redesign, nodejs consumers, engine topology
(state ownership wrong → C3), sleep semantics, UPDATELIST, GetNameAndLink
URL=page, catalog schema+read policy, D10: **correct**.
§5.2 table (9/15 rows), §5.1 property list, `ACCOUNT`: **wrong**.
IXQValue/TXQuery methods: **partial** (fill overload missing → M4).

## Open questions

1. Same-module concurrency: concurrent (FMD2-faithful, needs shared-state
   service) or serialized per module? Pick and spec the locking.
2. zstd: strip from Accept-Encoding (documented divergence) or bundle a
   decoder?
3. Is `DoCheckMissing` in scope for Phase 4? Do parity fixtures include
   `uData.pas` normalization?
4. PDF packing: restrict v1 quality/size or commit to streaming writer?
5. Corpus: does the capture harness exercise the fill-list form and
   account/`MODULE.Account` modules?
6. What does the "popular" endpoint order by?
