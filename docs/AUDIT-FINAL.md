# AUDIT-FINAL — independent adversarial audit of fmd-web 0.1.0 (37/38 stories)

Auditor: independent audit role (`tsk-solvent-reservoir-speeds`), execution-verified against
`/workspace/fmd-web` @ `b33021a` and FMD2 ground truth at `/workspace/FMD2`.
Method: every claim below was verified by **reading the implementing code and cross-checking
the FMD2 Pascal sources**, and — where marked EXECUTED — by **running probes against the
product code** (product tree untouched; all probe artifacts live under `/tmp/opencode`).
Docs, commit messages and prior stories' self-certification were treated as claims to
disprove, not evidence. Audit date: 2026-11-15.

Verdict up front: **no BLOCKER found**; 2 MAJOR, 2 MINOR, 6 NOTE. The contract layer, the
wiring, and the hard-semantics core verify clean.

---

## 0. Fresh gate numbers (EXECUTED during this audit)

`bash scripts/ci.sh` re-run end-to-end (log: `/tmp/opencode/ci-run.log`):

| Gate step | Result |
|---|---|
| contract:check (Pascal extractors vs contract.json vs generated bindings) | PASS (0 drift) |
| lint | PASS |
| typecheck (`tsc -b`) | PASS |
| test (unit + integration, one offline suite) | **149 files, 1597 tests, 0 failed** (147.5 s) |
| corpus (full seed replay vs FPC oracle) | **912/912 = 100.00 %**, 65 modules (gate ≥99 %) |
| corpus artifact staleness (`git diff --exit-code` on COMPAT.md/corpus-report.json) | clean |
| e2e phase-2 (bootstrap-watch + main scenario) | PASS |
| e2e phase-3 (enqueue → WS progress → pack → library → cancel/resume → retry) | PASS |
| CI gate overall | **PASSED** |

Coverage re-run (`npm run test:coverage`, log `/tmp/opencode/coverage-run.log`):
149 files / 1597 tests passed in 215.7 s; **all files 88.28 % stmts / 81.67 % branch /
88.37 % funcs / 88.28 % lines**. Per-package numbers in §4.

---

## 1. Contract fidelity re-verification (DESIGN.md v5 §5)

### 1.1 §5.2 event-binding table — 15/15 rows (100 %)

Ground truth: the 15 `Do*` dispatchers in `/workspace/FMD2/baseunits/lua/LuaWebsiteModules.pas`
(lines 154–466, verified by direct read). Contract: `contract/contract.json` events[].
Implementation: `server/src/engine/events/bindings.generated.ts` (generated, SHA-pinned),
`bindings.ts`, `dispatcher.ts`.

| # | Event | FMD2 ground truth | contract.json | generated bindings | dispatcher behavior | Verdict |
|---|---|---|---|---|---|---|
| 1 | GetDirectoryPageNumber | :190–218 net-status + HTTP + UPDATELIST + PAGENUMBER(**read-back** :208–211) + WORKPTR, code return | row 1 (15–20) | :51–57 identical | dispatcher.ts:206–264 binds exactly the row's globals; readBack loop :429–450 reads only listed globals; code return via `lua_tointegerx` (nil→0, FMD2 parity :209) | MATCH |
| 2 | GetNameAndLink | :219–243 net-status + HTTP + NAMES + LINKS + UPDATELIST + URL, code | row 2 (22–27) | :59–64 identical | NAMES/LINKS = TStrings facades (:228–237); URL push-only (:247–249) | MATCH |
| 3 | GetInfo | :245–266 net-status + MANGAINFO + HTTP + URL, code | row 3 (28–34) | :67–72 identical | MANGAINFO facade :221–227 | MATCH |
| 4 | BeforeUpdateList | :154–171 UPDATELIST, boolean | row 4 | :75–80 identical | UPDATELIST spec = CurrentDirectoryPageNumber + UpdateStatusText (:328–344, LuaUpdateListManager parity) | MATCH |
| 5 | AfterUpdateList | :172–189 same | row 5 | :83–88 identical | same path | MATCH |
| 6 | TaskStart | :267–284 TASK, boolean | row 6 | :90–96 identical | TASK spec :346–405 | MATCH |
| 7 | GetPageNumber | :285–305 TASK + HTTP + URL, boolean | row 7 | :99–104 identical | URL push-only | MATCH |
| 8 | GetImageURL | :306–327 TASK + HTTP + WORKID + URL, boolean | row 8 | :107–112 identical | WORKID integer global | MATCH |
| 9 | BeforeDownloadImage | :328–349 same globals (Pascal `var AURL` but URL never read back ⇒ push-only effective) | row 9, pushOnly:true | :115–120 identical; sanity check :201–205 forbids readBack on pushOnly rows | URL bound as plain global, never read back (:429–450 only iterates binding.readBack) | MATCH |
| 10 | DownloadImage | :350–371 same, boolean | row 10 | :123–128 identical | same path | MATCH |
| 11 | SaveImage | :372–392 HTTP + PATH + FILENAME, **string** return (`luaToString` :385) | row 11, returns "string" | :131–136 identical | readResult 'string' :420–421 | MATCH |
| 12 | AfterImageSaved | :393–410 FILENAME only, boolean | row 12 | :139–144 identical | FILENAME global :254–255 | MATCH |
| 13 | Login | :412–429 account-status + HTTP, boolean | row 13 | :147–152 identical | account-status constants bound per row (:267–278) | MATCH |
| 14 | AccountState | :431–448 account-status only, boolean | row 14 | :155–160 identical | same | MATCH |
| 15 | CheckSite | :449–466 account-status only, boolean | row 15 | :163–168 identical | same | MATCH |

Invariants re-verified: MODULE bound first for every event (generated sanity check
bindings.generated.ts:184–188; FMD2 LuaWebsiteModuleHandler.pas:47–49); no ACCOUNT global —
account reached only as MODULE.Account (module-facade.ts:260–302, Account object created
only when AccountSupport=true, FMD2 :1035–1036); PAGENUMBER the only read-back global
(bindings.generated.ts:195–199 enforces); URL never read back. Status constant tables
(dispatcher.ts:75–85) = FMD2 WebsiteModules.pas:19–21/:78. Machine drift defense:
`contract:check` re-parses the Pascal dispatchers + facade registration tables each CI run —
0 drift on the fresh gate.

### 1.2 Facade tables — 100 % of rows

| Facade | FMD2 ground truth | contract rows | Implementing code (file:line) | Verdict |
|---|---|---|---|---|
| TXQuery | LuaXQuery.pas:22–43 (ctor), :91–148 (fill overloads), :192–201 (methods) | 7 methods + ctor (159–168) | txquery-shim.ts:486–549 (engine), txquery-facade.ts:420–491 (Lua facade: ParseHTML 1-arg :423–427, XPathStringAll 4-shape dispatch :432–448, XPathHREFAll/TitleAll :449–460, XPathCount :461–465) | MATCH — fill-form mutates TStrings via `fillList` :361–369; string form `joinSeparatorString` ', '-join of trimmed non-empty (txquery-shim.ts:552–562 = XQueryEngineHTML.pas:130–137) |
| IXQValue | LuaIXQValue.pas:135–149 | 7 methods + Count (179–189) | txquery-facade.ts:48–51 (Lua Get iterator + GetProperty), :156 (GetProperty), :192 (Count), :266–293 (GetAttribute/InnerText/InnerHTML/OuterHTML) | MATCH — element `ToString` = inner text (txquery-shim.ts:338–364, FOTY0014 for JSON containers :350–351) |
| TStrings | LuaStrings.pas:216–263 | 18 methods + 6 props + arrays (201–232) | tstrings.ts:70–276 (full PascalTStrings semantics doc :1–68, pinned statement-by-statement against FPC `stringl.inc` with probe IDs), Lua surface in stubs.ts `makeTStrings` | MATCH — incl. out-of-bounds raise parity (:94–109), IndexOfName ASCII-case-insensitive (:128–137 = stringl.inc:1291), CommaText/DelimitedText parser :234–275 |
| MangaInfo | LuaMangaInfo.pas:23–34 (read directly) | 10 strings + 2 list objects (241–255) | mangainfo.ts:19–30 field list — **same names, same order** as the Pascal `luaClassAdd*` rows; unknown-key silent no-op :66, :75 (LuaClass.pas:94–169 parity, e.g. the OrckuMangas `Artist` typo) | MATCH |
| Storage | LuaStringsStorage.pas:143–159 (read directly) | Remove/Free/Destroy + KV + Text/Tag/Enable/Status (262–274) | storage.ts:241–292 (`makeStorageSpec`: KV default-array :266/:287, Text :249/:274, Tag/Enable/Status :251–256/:277–285, Remove :257–261, Free/Destroy host-owned no-ops :262–264 — documented deviation, destroying shared state would corrupt other workers) | MATCH — defaults :47–48 incl. the Pascal ctor's `'my status of TStringsStorage'` |
| HTTP | LuaHTTPSend.pas:91–198 + httpsendthread.pas | 15 methods + 16 props + 3 header sets (281–337) | http-shim.ts:283–333 (methods), :452–541 (props/sub-facades), http-pipeline.ts:101–448 (behavior), http-headers.ts:78–121 (Reset/ResetBasic/AcceptImage/POST rewrite), http-url.ts (massage/maybeEncode/SplitURL/redirect-merge) | MATCH — success ⇔ Document.Size>0 (pipeline :274–275 = :717); redirects 301/302/303/307 as GET, Referer of pre-redirect URL, MaxRedirect 5 (:250–272 = :642–674); retry >500 bounded RetryCount no delay (:284–303 = :623–629); POST Content-Type→MimeType + text/html rewrite (:181–188 + headers.ts:110–120 = :730–747); XHR (:190–197); SetProxy HTTP\|SOCKS4\|SOCKS5 (shim :328–332); D13: Accept-Encoding omits zstd (headers.ts:17), decoder still handles zstd if a server forces it (pipeline :396–448) |
| Crypto | LuaCrypto.pas:429–494 | 59 methods (345–403) | crypto-shim.ts:33–54 `CRYPTO_METHOD_NAMES` — **exact name set match** (verified list-by-list); base64 Lua bridge for wasmoon byte-string lossiness :21–28; FMD2 EncryptString key injected, never embedded (:79–84) | MATCH — vectors in server/test/engine/shims/crypto-*.test.ts (corpus 100 %) |
| ImagePuzzle | LuaImagePuzzle.pas:73–99 | New/Create, DeScramble, Hor/VerBlock ro, Matrix/Flips/Multiply (413–428) | imagepuzzle-shim.ts (raw-pixel port; non-square 18Comic, Multiply TonarinoYoungJump, in-place same-Document MangaGo goldens) | MATCH |
| Duktape | LuaDuktape.pas:14–24, 84–90 | ExecJS, error⇒nil (436–440) | duktape-shim.ts:1–35 (node:vm, 5 s timeout :29, one heap per ExecJS, JS require jailed to lua/ tree, print→host log, error⇒nil) | MATCH — JS-side `require` verified by the Madara e2e flow (§1.3) |
| pb | lua-protobuf (pb.c Lpb_load two-return) | decode/encode/load (502) | pb-shim.ts:532–536 (install), Lua glue :423–529 (`lib.load` forward-propagates BOTH returns :465–473; `__fmd_pb_b64enc/dec` byte-exact bridge), pbBridgeCall :399–421 | MATCH — two-return contract EXECUTED (§3 probe 6) |
| antibot interceptor | LuaWebsiteBypass.pas:85–209 + checkantibot.lua:5–12 | §5.9 semantics | antibot.ts:89–98 (heuristic = 403/429/503 + text/html + cloudflare/ddos-guard), :140–152 (global check lock, released before bypass), :159–219 (AllowServerErrorResponse forced :171, cookies cleared first :188, single-flight tryEnter loser-fallthrough :179–184, persist cookies/UA :203–208, Storage['reload'] re-issue :209–213) | MATCH — verified line-by-line against the Pascal `WebsiteBypassRequest` (:142–209), incl. loser skips re-issue when terminated (:180–183 = :197–200) |
| GetInfo §5.8 | uData.pas:85–207 (read directly) | 7 steps (443–490) | udata.ts:130–251 — step order and each statement match the Pascal read (dedup :186–204 = :154–173 `Delete(j)` earlier-index; host-strip :206–210; name cleanup :212–216; prefix strip :219–229; NumChapter :234) | MATCH (probe-executed, §3 probe 3) |

Also re-verified: §5.1 Init globals (base-globals), NewWebsiteModule only during Init
(init-pass.ts; per-file isolation proven by registry/isolation.test.ts), options API with
combobox-INDEX semantics (module-facade.ts:111–120), case-sensitive unknown-key tolerance.

### 1.3 End-to-end module flow traces (6 required flows + 2 bonus)

Each trace = real FMD2 module files through the real wasmoon host + real shims, offline
fixtures. All pass in the fresh gate.

| Flow | Test (file) | Chain exercised | Key evidence |
|---|---|---|---|
| JSON-API site (ComicK) | server/test/engine/e2e/comick-getinfo.e2e.test.ts | real ComicK.lua Init→GetInfo; json() node-tree dialect; §5.8 normalization | descriptor golden; MANGAINFO harvest → udata pipeline |
| Madara template incl. JS `require` (BrainRotComics) | server/test/engine/e2e/madara-template-getpagenumber.e2e.test.ts | Template.GetPageNumber → templates/Madara.lua chapter-protector path → `fmd.duktape'.ExecJS` with JS-side `require("utils/crypto-js.min.js")` → AES decrypt → TASK.PageLinks fill; TASK.PageNumber/WORKID binding | committed AES ciphertext fixture; golden links incl. i%d.wp.com strip |
| MangaPlus protobuf incl. protoc.lua `has_pb` branch | server/test/engine/shims/pb-protoc.integration.test.ts + audit probe (§3 #6) | `pcall(require,"pb")` (protoc.lua:993) → Parser.reload → `pb.load(descriptor)` two-return (protoc.lua:1176–1178) → `protoc:load(MangaPlus.proto)` → `pb.decode('Response', golden source.bin)` via MangaPlus.lua:123 access chain | EXECUTED probe: `protoc:load` ret=true pos=size+1; golden payload decodes |
| imagepuzzle site (MangaGo in-place / 18Comic non-square / TonarinoYoungJump Multiply) | server/test/engine/shims/imagepuzzle-shim.test.ts:282+ | real module patterns incl. MangaGo.lua:250–264 same-Document DeScramble | pixel-identical goldens (corpus/fixtures/imagepuzzle/*) |
| account/Login site (EHentai/ExHentai) | server/test/engine/e2e/ehentai-getinfo-login.e2e.test.ts | account-status constants bound; account reached ONLY as MODULE.Account; `fmd.crypto.EncodeURLElement`; Set-Cookie jar reads; css(); PAGENUMBER read-back | golden session; Login flow also API-wired (§2) |
| fill-list collector (Hentai2Read) | server/test/engine/e2e/hentai2read-getpagenumber.e2e.test.ts | XPathStringAll/XPathHREFAll fill-list overloads populating TASK.PageLinks (§5.6) | golden page links |
| Bonus: directory-page flow (Tapas TotalDirectory) | server/test/engine/e2e/tapas-totaldirectory.e2e.test.ts | GetDirectoryPageNumber + PAGENUMBER read-back row | golden |
| Bonus: AsuraScans GetInfo | server/test/engine/e2e/asurascans-getinfo.e2e.test.ts | Madara-family HTML GetInfo + normalization | golden |

---

## 2. Wiring verification (is it actually connected?)

### 2.1 API routes → zod → generated client → UI (every route traced at both ends)

- Route inventory as data: server/src/api/routes.ts:7–41 (34 routes incl. WS + health).
- Real Fastify handlers: server/src/api/app.ts:286–696 — **every** inventory row has a
  handler (healthz :286, readyz :290, metrics :307, modules GET/PUT :316/:321, accounts
  :343–390, settings :392–400, sync :402–433, catalog latest/title/search :478–505, info
  :537, jobs download/list/get/cancel :562–609, library :611–637, favorites :639–702).
- Single zod validation: schemas.ts re-exports `@fmd/contract` schemas (contract/schemas.ts
  is the ONE definition; schemas.ts:14–27) — `parseOr400` at every boundary (app.ts:563).
- OpenAPI snapshot: committed server/src/api/openapi.snapshot.json; openapi.test.ts:51–60
  asserts inventory ⇔ document bidirectionally (`API_ROUTES` consumed — not dead data).
- Generated typed client: web/src/api/openapi.d.ts generated by openapi-typescript from the
  snapshot (web/package.json gen:api); web/test/api-drift.test.ts regenerates in-memory and
  byte-compares (drift ⇒ fail, with a negative control).
- Client → hooks: web/src/api/hooks.ts — all 20 endpoint calls are path-literal keyed
  (`client.GET('/api/modules')` :69 … `client.POST('/api/favorites/{id}/check')` :453).
- Hooks → pages: BrowsePage useCatalogEntries :50; MangaPage useLiveInfo/useCreateDownloadJob
  :20–22; DownloadsPage useJobsList/useJobsFeed/useCancelJob :76–78; FavoritesPage
  useFavorites/useUpdate/useCheckNow/useDelete :33–36,:95; SettingsPage
  useModules/useSyncModules/useSyncAllCatalogs/useUpdateModule :25,:96,:151,:188–190;
  LibraryPage useLibrary :33; App useBootstrapStatus :46; library file links
  LibraryPage.tsx:25 (`/api/library/${id}/file`).
- Auth: FMD_WEB_PASSWORD → session cookie, login rate-limit 10/min (auth.ts;
  server/test/api/auth.test.ts, 11 tests).

**Verdict: fully wired, no dead route, no page reaching around the client.**

### 2.2 WS hub → ring buffer → web client

- Hub: server/src/api/ws/hub.ts — hello protocol :216–248, replay decision :343–360
  (resync when cursor > newest or < eviction watermark; no cursor ⇒ full buffered tail),
  single-synchronous-step seam :319–332 (live can never interleave with replay), D21
  drop-oldest + `gap` marker with unbounded hello replay (:112–160, pump gate :459–474),
  age sweep :362–371. Ring buffer: ring-buffer.ts (capacity 1000 / maxAge 15 min; 100 % stmts).
- Attach: api/ws/attach.ts (fastify-websocket; :79–96 close/error paths).
- Web: ws-protocol.ts (shared message schema), ws-backfill.ts:1–258 (D19 state machine,
  98.25 % cov), use-jobs-feed.ts (DownloadsPage live feed :77).
- Tests: server/test/api/ws/ws.integration.test.ts (10 — real server+WS client incl.
  backfill seam), hub.test.ts, wire-drift.test.ts (schema drift), web/test/ws-backfill.test.ts
  (9) + ws-contract-drift.test.ts (5). EXECUTED adversarial probe §5-A5 confirms garbage
  cursors answer `resync`.

**Verdict: wired end-to-end with a mechanical schema-drift defense on both sides.**

### 2.3 Sync → registry → engine → capability flags → /api/modules → UI badges

- sync/modules (fetcher/zipball/validate/swap/state, 92 % cov) writes the synced lua/ tree;
  registry startup (engine/registry/startup.ts) runs the Init pass; capabilities.ts:183–231
  computes flags by static require-graph analysis (subprocess closure :114–143 — templates
  deliberately NOT traversed per §5.10 Round-4; run_html_load closure :149–175;
  webdriver sentinel :177–181; live_scrape_fallback :212–214).
- Persistence: RegistrationRecord → module_state rows (persistence.ts; SHA-gated
  module_state per the registry story), served by /api/modules (services.ts:53–110 incl.
  §5.11 flag-drop when the sidecar profile satisfies a flag :75–77).
- UI: SettingsPage useModules :188 → CapabilityBadges (web/test/capability-badges.test.tsx).
- Tests: registry sweep.test.ts (11 — 417-module Init sweep, 98.6 % register), isolation.test.ts,
  persistence.test.ts, module-sync.integration.test.ts (13).

**Verdict: wired; flags flow from the actual synced tree to the UI badges.**

### 2.4 Download pipeline (full chain, not per-link units)

- Chain: POST /api/jobs/download (app.ts:562) → JobService (services.ts:451) →
  download-lane.ts (LaneRunner slot; idempotent replay vs terminal `<key>#<n>` chained
  re-enqueue :30–43) → EngineDownloadHooks (download-engine.ts:59–241: TaskStart
  :151–161, GetPageNumber :181–193 with 'W'-padding :227–240, GetImageURL :201–217 with
  the Lua 1-based WORKID shift :207) → download-runner.ts (marker persist :319–326
  FindImageFile parity = uDownloadsManager.pas:382–392; phases per ChapterPipeline) →
  image workers → packers (zip/pdf/epub streaming + validators) → library finalize
  (finalize.ts 98.9 %) → WS events (download-lane publishes every queue mutation).
- Full-chain assertion: e2e phase-3 Playwright specs (web/e2e/download-flow.spec.ts:193–340):
  scenario 1 enqueue→WS progress→library listing→**artifact validates**; scenario 2 slow
  images→cancel mid-download→cancelled→**re-enqueue resumes via persisted markers**;
  scenario 3 injected 500s→retry visible→recovers. Plus in-suite: download-runner.integration.test.ts
  (7, loopback fixture site: hook order, cancel≤deadline+'D' persistence, resume fetch
  counts, per-site limiter bound, URL rewrite, custom SaveImage filenames, retry budget),
  cancel-resume-determinism.test.ts, dual-write.test.ts (15).

**Verdict: the full chain is exercised by at least one test per link AND by the phase-3
e2e that spans enqueue→WS→pack→library→cancel/resume→retry.**

### 2.5 Favorites scheduler → DoCheck diff → dual-write → downloaded_chapters

- scheduler.ts (bounded concurrency, per-favorite interval+jitter; scheduler.test.ts 7 +
  concurrency asserts), do-check.ts 100 % cov (§7.2 item 1–2 parity: live GetInfo +
  immediate CurrentChapter/Status), diff.ts (case-insensitive IndexOf set-difference,
  :364–370 parity; golden-diff.test.ts 6), dual-write (§7.2 item 4: library/dual-write.test.ts
  15 — both the favorite-side list and global downloaded_chapters, DownloadedChaptersDB
  parity merge.ts). Engine wiring: engine.test.ts 12 + service.test.ts 7 (incl. "ch/1 was
  dual-written; only ch/2 is new; ch/1 NOT re-enqueued" :199). API surface: /api/favorites*
  (app.ts:639–702) + FavoritesPage.

**Verdict: wired; the diff input is the post-§5.8, post-dual-write state as designed.**

### 2.6 Accounts storage encryption → import commands → login binding

- secret-box.ts (AES-256-GCM, HKDF-derived key from FMD_WEB_SECRET, typed SecretBoxError;
  88.7 % cov), account-store/account-service (93–96 %), API PUT/DELETE /api/accounts/:moduleId
  (password never returned), POST /api/accounts/:moduleId/login → account-login.ts:127–133
  binds the credentials as `DispatcherShims.account` → MODULE.Account (module-facade.ts:260–302),
  reads back `MODULE.Account.Status/Cookies` via Lua (:150–154) — FMD2 DoLogin parity
  (status lives on MODULE.Account, LuaWebsiteModules.pas:412–431).
- Import commands (server/tools/import/*): FMD2 modules.json / downloadedchapters.db /
  EncryptString(uBaseUnit.pas:1557–1572 hardcoded key) — fmd2-import.test.ts (11).

**Verdict: wired end-to-end; native storage uses the deployment secret, the FMD2-compatible
decryption exists only inside the import command (§8.6/D4 respected).**

### 2.7 Dead wiring / hidden coupling sweep

- `emptySnapshot` (module-state.ts:568–577): production export whose ONLY consumer is a
  test (server/test/smoke.test.ts:140) → **dead production code** (MINOR, F-3).
- `API_ROUTES`/`findRoute`: consumed by openapi.test.ts (inventory⇔document) — alive.
- `makeHTTPSpec` inert stub: dispatcher fallback when no shim installed (dispatcher.ts:213)
  — alive by design for the v0 dispatcher tests.
- No test uses `vi.mock` anywhere in the tree (verified by scan) — no over-mocked suites.
- No page/component bypasses the typed client; no consumer reaching around its interface
  found. Engine code independent of observability via the `SwallowSharedDeduper` seam
  (txquery-shim.ts:573–577) — structural, not hidden coupling.

---

## 3. Correctness deep-dive (the 10 hard semantics)

All 10 probes below are marked tested-by (file+name) and/or EXECUTED during this audit.
Probe commands + outputs are quoted; probes live under `/tmp/opencode` (product tree
untouched).

**#1 Chapter dedupe (LowerCase key + case-insensitive merged list) — EXECUTED + tested-by.**
Implementation: jobs/library/merge.ts (`mergeCaseInsensitive` = uBaseUnit.pas:1438–1455
parity: sorted TStringList, dupIgnore, first-added case variant survives; key =
`asciiLowerCase(ModuleID+Link)` = DownloadedChaptersDB.pas:55/:78; empty value = no-op :65).
Tests: jobs/library/dual-write.test.ts (15), merge.golden.test.ts.
Probe `/tmp/opencode/probe3a.ts` (node against server/dist): 33/33 PASS — case-variant
duplicates keep the first variant + sort; reorder-invariant; `ÉCLAIR` ASCII-fold
(Pascal LowerCase parity); `hasChapter` case-insensitive membership for the favorites diff.
Quote: `PASS dedupe keeps first case variant of each`, `PASS key LowerCase(ModuleID+Link)`.

**#2 'W'/'D' resume markers (kill mid-chapter, corrupt marker file) — EXECUTED + tested-by.**
Implementation: markers.ts + chapter-pipeline.ts (reconcileWithFiles :75–91 =
CheckForExists :1040–1063; image-worker.ts marker short-circuits = uDownloadsManager.pas
:350–407 verified line-by-line) + download-runner.ts resume probe (FindImageFile :319–326).
Tests: marker-store.test.ts, cancel-resume-determinism.test.ts, crash-recovery.test.ts
(:35 "a download killed mid-chapter resumes at its last flushed chapter index", :124
"resumed job cycles retry→running→retry→running→done across repeated crashes"), e2e
phase-3 scenario 2. Probe: mid-chapter state `['D','D','D','D','W',url,…]` round-trips
verbatim; truncated-JSON marker file → `undefined` (falls back to file-on-disk
reconciliation); non-array / non-string entries → undefined / '' coercion; absent → undefined.

**#3 Antibot single-flight fallthrough under contention — tested-by (integration, real Lua).**
server/test/engine/state/antibot.test.ts (17) + antibot.pipeline.integration.test.ts (5):
the REAL FMD2 bypass scripts run in a real wasmoon engine against a loopback mock server;
the assertion "≥8 parallel image downloads on ONE module during a bypass window: exactly
one bypass, losers not delayed" (4.1 s) pins the TryEnterCriticalSection loser-fallthrough
(:161/:197–200 parity); IUAM challenge → duktape shim; FlareSolverr reload
(Storage['reload']='true' → re-issue). Port verified line-by-line against
LuaWebsiteBypass.pas:142–209 during this audit (see §1.2 table).

**#4 Favorites diff (case-variant new chapters, chapters appearing mid-download) — EXECUTED + tested-by.**
diff.ts (`newChapterPositions` = DoCheck :364–370 parity, live order preserved, duplicate
live entries stay distinct positions). Tests: favorites/golden-diff.test.ts (FPC-pinned
fixtures), engine.test.ts (:199 mid-download case: dual-written ch/1 not re-enqueued, ch/2 new).
Probe (probe3a #5): stored `'Chapter 1\nchapter 2'` vs live
`['chapter 1','CHAPTER 2','Chapter 3','chapter 2','Chapter 4']` → new = positions [2,4]
with names projected from the same positions; case-variants of existing chapters NOT new.

**#5 §5.8 normalization (last-occurrence dedup direction, name-cleanup pipeline order) — EXECUTED + tested-by.**
udata.ts:186–204 implements `Delete(j)` (earlier index) ⇒ last occurrence's link+name
survive — statement-identical to uData.pas:154–173 (verified against the Pascal source).
Tests: engine/normalize/pipeline.golden.test.ts (28), corpus normalization triples (66 cases).
Probe (probe3a #3): `['https://h.com/a/1','https://h.com/A/1',…]` → surviving link `/A/1`
with name `SECOND-dup` (the LAST occurrence); pad/prune both directions; name-cleanup
output `Chapter 1 [v2] (good)` (breaks removed, bracket kept, trimmed); link fallback
`https://site.com/manga/foo` → `/manga/foo`. During probing, an apparent "failure"
(host-strip emptying links for single-label hosts like `http://host1/x/ch1`) was traced
through the FMD2 `SplitURL` Pascal source (httpsendthread.pas:191–281: when `pos('.')==pos('/')`
the remainder becomes the host, path='') — **fmd-web faithfully reproduces the FMD2 quirk**
(entry deleted by RemoveHostFromURLsPair, uBaseUnit.pas:983–1004); probe expectation fixed,
product correct.

**#6 Filename tail-truncation boundary (exactly-at-limit) — EXECUTED + tested-by.**
library/filenames.ts `truncateKeepTail` :125–131 (Delete(s,1,len-max) parity,
uDownloadsManager.pas:543–550; 0 = no limit). Tests: jobs/library/filenames.golden.test.ts,
jobs/filename-policy.test.ts (D5 shared policy incl. FMD_NORMALIZE_PATHS opt-out).
Probe: `'12345'@5 → unchanged`; `'123456'@5 → '23456'`; `'123'@5 unchanged`; limit 0 =
no-op; UTF-16 surrogate boundary pinned (Pascal UnicodeString Length parity).

**#7 pb.load two-return contract — EXECUTED (v2, corrected probe; see disclosure).**
Probe `/tmp/opencode/probe-pb.ts` (real wasmoon + real utils/protoc.lua + shim), assertions
mirroring the product test `server/test/engine/shims/pb-protoc.integration.test.ts:90-109,131-152`
(`pos = compiledLen + 1` against the SAME parser's compile output; the recorded golden
payload is the field-2 ERROR variant → `success` stays nil). Verbatim output
(`/tmp/opencode/probe-pb.out`, exit 0):
```
PASS pb.load("") and pb.load(garbage) each return EXACTLY 2 values
PASS pb.load("") → (false, 1) — ret boolean(false, not nil), pos = 1
PASS pb.load(garbage) → ret=false (NOT nil), pos = number ≥ 1
PASS protoc:load(MangaPlus.proto) → ret=true, pos = compiledLen+1 (1623)
PASS pb.decode(Response, golden MangaPlus payload) decodes (bin non-nil; ERROR variant → success nil)
```
Tested-by: pb-protoc.integration.test.ts (7) — the same contract asserted from Lua in the
protoc.lua:1176 binding shape. (FMD2 contract: pb.c Lpb_load ALWAYS returns two values;
protoc.lua:1178 concatenates `pos` — a nil pos would raise "attempt to concatenate";
the shim returns a number in both outcomes, so the untouched protoc.lua error path works.)
Wire-stage error shape re-verified separately (diagnostic artifact
`/tmp/opencode/probe-pb-wirestage.out`): a 2-byte garbage descriptor inside the
protoc.lua:1178 error path yields exactly `load failed at offset 2`.

> **Correction disclosure (review finding):** the quote block in the first committed
> version of this report was produced by a probe whose script was lost in a `/tmp` reset
> during the session and was not byte-reproducible; its assertion semantics were also
> imprecise (1-based indexing of wasmoon's 0-based table spread; `pos` compared against
> the proto-TEXT length instead of the compiled-descriptor length + 1). The values it
> claimed (always-two returns; failure ⇒ (false, positive offset)) were all re-established
> as TRUE by the corrected v2 probe above, whose script and raw output are the cited
> artifacts. The findings themselves were never fabricated — but evidence must be
> reproducible, and now it is.

**#8 Corpus oracle validity (≥5 triples manually re-derived) — VERIFIED (9 triples).**
Re-derived by hand from the fixture HTML/JSON against the FMD2 algorithm (uData.pas +
uBaseUnit.pas helpers read directly), all MATCH the FPC-captured expected results:
1. capture/getinfo-normalization-0003 — full 10-field re-derivation (title/altTitles
   join-and-trim `ExampleMan  ,`; FixWhiteSpace = NBSP/BOM removal only — uBaseUnit
   :1913–1926; CleanMultilinedString `\n\n`→`\n` :1940–1962; coverLink double-slash
   collapse; link fallback; dedup direction; host strip; '  ' link deleted; numChapter 2).
2. KomikStation 32#1 `//meta[@property="og:image"]/@content` → exact fixture attribute value.
3. WebToons 91#1 og:title → `WEBTOON`. 4. WebToons 92#1 og:image → exact URL.
5. RawDEX 41#1 `//h1` → `Popular this week` (deep text across the `<span>` boundary, ends trimmed).
6. Raw1001 47#1 `//h1` → `最新更新\n` + 20 spaces + `トップ評価` — whole-string trim
   preserving the interior whitespace run (FMD2 treeElementAsString + XQGlobalTrimNodes).
7. HentaiNexus 115#1 pagination `li[last()]` → `612` (fixture's last page link).
8. Hentai2Read 17#1 `json(//script[@data-page="app"]).props.books.lastPage` → `1752`
   (JSON node-tree adapter; verified programmatically against the fixture's JSON).
9. ComicK all-empty triples (dead-domain fixture) — every expression correctly `empty`
   (error-swallowing semantics, XQueryEngineHTML.pas:358–399).
The oracle itself is right; the engine replays it at 100 %.

**#9 Catalog read-only invariant — tested-by + adversarially probed.**
catalog-store.ts:204–207 opens every catalog `readonly: true, fileMustExist: true`
(SQLITE_OPEN_READONLY — a read connection physically cannot write/create journal/WAL).
Test: catalog-store.test.ts "a heavy search workload leaves ZERO sqlite sidecars and the
file byte-identical". Adversarial probe (§5-A3): a catalog with pages 2–3 zeroed to 0xff →
typed SqliteError on read (no silent wrong rows), and STILL zero sidecars afterwards.

**#10 Idempotency-key edge cases — tested-by.**
services.ts:451–468 (canonical-JSON fingerprint; same key+payload ⇒ ORIGINAL job;
different payload ⇒ 409 conflict), queue.ts:279–289 (UNIQUE key + fingerprint column),
download-lane.ts:30–43 (terminal original ⇒ chained `<key>#<n>` re-enqueue).
Tests: api/jobs.test.ts (:39 replay returns ORIGINAL with 200 + no second job; :59
reordered-keys canonical JSON still replays; changed field 409), runtime/download-lane.test.ts
(replay vs chained re-enqueue), crash-recovery.test.ts. Adversarial probe (§5-A6) adds
wrong-type/missing/empty-key/null payloads → all rejected by JobCreateRequestSchema.

---

## 4. Test-completeness map

Suite totals (fresh run): **149 test files, 1597 tests, 0 failed, ~148 s**.
Zero `vi.mock` in the tree; assertion-density scan found no zero/trivial-assertion tests
(lowest expect/it ratios are table-driven golden/structural tests — spot-checked
marker-store.test.ts: real file IO + atomicity asserts).

| Subsystem | Files | Verdict | Coverage (stmts) | Missing paths (none critical) |
|---|---|---|---|---|
| engine/lua (host, engine, facades, pool) | 7 | **ADEQUATE** | 91.5 % (chunk-loader 58 % — error branches) | loader failure branches; host.ts:30–35 |
| engine/events (dispatcher, supervisor, deadline) | 3 | **ADEQUATE** | 90.3 % | bindings sanity-throws :202–214 |
| engine/shims (http, txquery, crypto, duktape, pb, imagepuzzle, pcre2, require…) | 27 | **ADEQUATE** | 89.0 % (png-codec 69 %, hostgate 70 %) | png codec error branches; proxy IPv6 literals |
| engine/state + pipeline + normalize + registry | 12 | **ADEQUATE** | 94.7 / 99.0 / 98.7 / 93.2 % | — |
| engine/e2e (seed flows) | 6 | **ADEQUATE** (flows, not coverage) | — | more seed modules would widen; not required by gate |
| api (routes, auth, openapi, pagination) | 13 | **ADEQUATE** | 96.5 % (auth 91 %) | rate-limit window edge :145–151 |
| api/ws (hub, ring, attach) | 4 | **ADEQUATE** | 94.7 % (ring 100 %) | slow-consumer bufferedAmount pause branch :464–465 |
| jobs/queue (+lanes, payloads, state machine) | queue.test 28, state-machine, coalescing, checkpoint, crash-recovery, retention, stress | **ADEQUATE** | 94.3 % | — |
| jobs/download | 7 | **ADEQUATE** | 87.4 % (runner 81 % — WS-publish branches covered via e2e) | downloader IPv6; image-files ext fallback |
| jobs/packers (+validators) | 3 (+1000-page memory test, watchdog) | **ADEQUATE** | 87.2 % (validators 67–81 % — deep-corruption branches) | packer validator tail branches |
| jobs/favorites | 4 | **ADEQUATE** | 91.3 % | scheduler timer-edge :260–281 |
| jobs/library | 4 | **ADEQUATE** | 89.2 % (store 78.6 %) | store pagination tails |
| accounts | 3 | **ADEQUATE** | 93.5 % | store migration tails |
| sync/modules | 4 | **ADEQUATE** | 92.0 % | fetcher transient-net branches :43–51 |
| sync/db (catalogs, FTS sidecar, rate budget) | 7 | **ADEQUATE** | 93.2 % (extract 80 %) | extract odd-input branches |
| db (schema) | — | **ADEQUATE** | 100 % | — |
| observability | 4 | **THIN** (unit) — metrics/log formatting branches untested in-suite | 88.7 % (instrumented-sync 62 %) | sync instrumentation tails; structured-log formatter branches |
| runtime (assembly, lanes, bootstrap, login, engine-info) | 3 | **THIN** in-suite, **ADEQUATE** system-level | 66.8 % (download-engine 13.5 %, library-service 15.7 %, download-lane 53.7 %) — the engine-bound path is exercised by e2e phase-3 (compose/process twin) rather than vitest | an in-vitest EngineDownloadHooks test would de-risk runtime refactors; download-lane.test.ts covers replay/re-enqueue only |
| web (state/api/pages/components) | 12 | **ADEQUATE** | 68.8–86 % (use-jobs-feed 55.8 %; index.ts barrel 0 %) | feed polling-edge branches |
| contract tools (extract, drift-check, validate) | 4 | **ADEQUATE** | 82.5 % (drift-check 72.6 % — error paths) | conservative-extractor failure branches (by design: unrecognized patterns must fail loud; partially covered) |
| corpus (runner/harvester/tests) | 6 | **ADEQUATE** | 84–94 % | replay.ts branch tails |
| e2e (phase-2/3, Playwright) | 5 specs | **ADEQUATE** for the exit gate | — | compose-mode (docker daemon) variant runs when available; process twin otherwise |

Chaos drills (§13.4) — all present as real fault-injection tests:
worker-stall watchdog (supervisor.test.ts:105–133), WASM OOM quarantine/rebuild + engine_oom
(:161–210), RSS-budget recycle (:211–255), restart-mid-download resume (crash-recovery),
catalog replace-under-read (fts-replace-under-read.test.ts), sync rate-limit backoff
(sync-integration.test.ts:161), WAL checkpoint (checkpoint.test.ts), stress
(stress.test.ts + stress-worker helper).

Live smoke (§13.2): opt-in only, correctly excluded from the gate; a committed
docs/live-smoke-report.json (schema live-smoke-report/1, generated 2026-11-15T20:52Z,
environment "live") documents the nightly harness status. Out of scope here — status noted,
not audited.

---

## 5. Adversarial testing performed by the auditor (6 probes, actual vs expected)

All probes run against the product build (server/dist from the fresh gate) with product
sources untouched; scripts under /tmp/opencode.

**A1 — malformed .proto through the REAL protoc.lua (`has_pb` branch).**
Input: `syntax = "proto3"; package x; message Bad { string a 1; }` (missing `=`).
Expected: a typed failure from the untouched protoc.lua, engine intact.
Actual (probe-adv.ts A1; raw failure text captured verbatim in
`/tmp/opencode/probe-adv.out`, final line): pcall captures exactly
`THREW utils/protoc.lua:83: <input>:1:54: '=' expected` — protoc's OWN parse-stage error;
wire-level descriptor failures surface through protoc.lua:1178's error path —
`load failed at offset 2` for a 2-byte garbage descriptor (separate one-liner diagnostic,
verbatim in `/tmp/opencode/probe-pb-wirestage.out`). Engine executes `1+1` afterwards.
Verdict: **PASS (typed failure, no crash, no nil deref, FMD2-identical error text).**

**A2 — hostile cookie-jar values through the HTTP shim.**
Inputs: names containing `=`/`;`/newline/empty, value with `CRLF+Set-Cookie: evil=1`,
100 KB value, unicode. Expected: KV store tolerates; Set-Cookie parse takes only the first
pair; requests unaffected. Actual: all hold (FMD2 raw-value parity — the jar keeps values
verbatim, exactly like FMD2's TStrings jar); `addServerCookie('evil2=1; Path=/…\r\nX: y')`
stores `evil2=1` only; request resolves. **But see MAJOR F-1**: the raw CRLF value reaches
the production transport boundary unvalidated.

**A2b — CRLF header value through the PRODUCTION LoopbackHttpTransport.**
`headers: { Cookie: 'a=1\r\nEvil: injected' }` against a real loopback server, server-side
injection probe armed:
Actual: `ok=false error="timeout" status=0` after 5.0 s (timeoutMs honored);
**header-injection-observed=false** (nothing malicious reached the wire — strictly safer
than FMD2/synapse, which would transmit the injected header); a following clean request
**also failed** — the shared transport worker died from the invalid-header write and is
never recreated. Expected (ideal): immediate typed `ERR_INVALID_CHAR`-style failure with
the worker surviving. Verdict: **MAJOR F-1** (no security breach; availability failure).

**A3 — catalog .db with corrupted pages (pages 2–3 set to 0xff).**
Expected: typed error, no silent wrong results, read-only invariant intact.
Actual: `SqliteError` from the page scan (no rows returned silently); zero
`-journal/-wal/-shm` sidecars created. Verdict: **PASS.**

**A4 — module whose Init() throws mid-registration.**
BadModule.lua: NewWebsiteModule → ID/Name set → `error('boom mid-registration')`.
Actual: `descriptors=0` (no partial registration) and the failure is LOGGED at error level:
`LUA>DoInit("modules/BadModule.lua")> LuaCallFunction("Init") modules/BadModule.lua:5: boom
mid-registration`; host disposed cleanly. Matches FMD2's DoInit SendLogException + drop
semantics. Verdict: **PASS.**

**A5 — WS client with garbage lastEventId.**
Cursors `abc`, `-5`, `1.5`, `99999999999999999999999999`, `''`, `'+7'` → each answered
`resync`/nothing (never a partial replay); valid cursor `1` → exact replay of id>1;
undecodable JSON first frame → `resync`. Root cause verified at the boundary:
`WsEventIdSchema = z.string().regex(/^[0-9]+$/)` (contract/schemas.ts:40) rejects
non-decimal cursors before the hub trusts them. Verdict: **PASS.**

**A6 — job payload with wrong types at the queue/API boundary.**
moduleId:number, chapterLink:object, idempotencyKey:number/''/absent, extra unknown field,
null body → all rejected by `JobCreateRequestSchema` (400 at the route, never reaching the
queue); canonicalJson is key-order-insensitive, drops `undefined`, sorts nested. Verdict: **PASS.**

---

## 6. Findings

Classification: BLOCKER = must fix before any real use; MAJOR = wrong/unsafe behavior on a
realistic path; MINOR = defect with limited blast radius; NOTE = verified divergence or
observation worth recording. Reproduction commands are given for every MAJOR/BLOCKER.

### F-1 — MAJOR: hostile CRLF header value kills the shared HTTP transport worker permanently (availability)
- Where: server/src/engine/shims/http-transport.ts:463 (`perform(seq, readReq())` runs in a
  `setInterval` with NO try/catch), :367–398 (`http.request` consumes module-controlled
  header values unvalidated), :513–530 (`ensureWorker` keeps `this.worker` set forever —
  no `worker.on('exit'/'error')`, no recreation), wired ONE-per-process at
  server/src/runtime/assembly.ts:295. Input path: module sets `HTTP.Cookies.Values['x']` or
  any header value containing CRLF (the jar intentionally keeps raw values — FMD2 parity,
  http-headers.ts:36–44) → http-pipeline.ts:324–336 copies headers verbatim → transport.
- Why it matters: one hostile (or buggy) module makes EVERY subsequent module HTTP request
  in the process fail — each burning up to `maxWaitMs` (120 s default) before the typed
  failure — stalling downloads, GetInfo, favorites until restart. No injection reaches the
  wire (verified), so this is availability, not security.
- Repro: `node /tmp/opencode/probe-adv-crlf2.ts` (self-contained: loopback server +
  `LoopbackHttpTransport({allowedHosts:['127.0.0.1']})`; output:
  `ok=false error="timeout" status=0 after 5001ms; header-injection-observed=false` then
  `post-probe → ok=false status=0`).
- Remediation pointer (no fix applied): (a) reject/strip CR/LF in header values at the
  shim boundary (NameValueMap.set or pipeline attempt()) with a typed error; (b) wrap the
  worker `perform()` body in try/catch → `writeResult(ok:false)`; (c) handle worker
  'exit'/'error' → `this.worker = null` so the next send recreates it.

### F-2 — MAJOR: MODULE cookie methods are silent no-ops (Madokami/SoftKomik auth silently broken; not flagged)
- Where: server/src/engine/lua/module-facade.ts:121–124
  (`AddServerCookies: () => undefined`, `GetServerCookies: () => ''`, `RemoveCookies`,
  `ClearCookies` stubs) vs FMD2 LuaWebsiteModules.pas:892–912 + registration :969–972
  (module `CookieManager.AddServerCookies(name, value, expiry)` / `GetServerCookies`
  / `RemoveCookies` — persisted server-cookie store injected into requests).
- Consumers: /workspace/FMD2/lua/modules/SoftKomik.lua:132 (`MODULE.AddServerCookies('tokkey=' .. MODULE.Storage['Auth'])`), :135 (`MODULE.RemoveCookies()`); Madokami.lua:40/:75/:78 (account-cookie injection + ClearCookies).
- Why it matters: those modules' auth flows silently lose their cookies (requests go out
  unauthenticated); neither module carries a known-broken flag (capabilities.ts:35 publishes
  only `fmd.subprocess`/`madara.run_html_load`/`webdriver.bypass`), so /api/modules reports
  them as healthy; the contract.json `moduleSurface` rows exist but with non-functional
  behavior — undetectable by the drift check, which verifies surface, not semantics.
- Repro: run Madokami.lua through server/test/engine/e2e/harness.ts with a fixture login
  page; `MODULE.AddServerCookies('a=1')` then `MODULE.GetServerCookies('a')` returns `''`.
- Remediation pointer: implement the module-level cookie methods over the §5.3 shared state
  (ModuleSettings.cookies / SharedCookieJar, which already exist and persist via module_state),
  or — minimum — flag the two modules known-broken and record the gap in COMPAT.md's
  LuaWebsiteModules row (D11: nothing dropped silently).

### F-3 — MINOR: dead production export `emptySnapshot`
- server/src/engine/state/module-state.ts:568–577; only consumer is
  server/test/smoke.test.ts:140. Dead wiring per §2.7. Remediation: delete or use in the
  §9 projection.

### F-4 — MINOR: in-vitest coverage thin spots on the runtime path
- runtime/download-engine.ts 13.5 %, library-service 15.7 %, download-lane.ts 53.7 %,
  runtime-entry.ts 0 % (compose entry), web use-jobs-feed.ts 55.8 % (per the coverage
  table in §4/§0). System-level behavior IS covered by the e2e phase-2/3 runs (process
  twin), so this is a refactor-safety gap, not a correctness gap. Remediation pointer:
  one vitest-level EngineDownloadHooks test (fixtures already exist in
  server/test/engine/e2e/) and a use-jobs-feed edge test.

### F-5…F-10 — NOTE (verified, no action required)
- N-1: Event dispatch failure semantics: FMD2 swallows a Lua exception into the row's
  default (False / information_not_found / ''); fmd-web returns `{kind:'failed', reason}`
  and the runtime turns it into a job failure with the engine log tail
  (download-engine.ts:164–178). Deliberate, visible-failure design (dispatcher.ts:24–31);
  behaviorally better (no silent information_not_found), recorded here for completeness.
- N-2: `TASK.CurrentDownloadChapterPtr`/`CurrentMaxFileNameLength` return host constants 0
  (dispatcher.ts:385–390). Consistent with fmd-web's one-chapter-per-job model: FMD2's
  Pascal `Strings[i]` is 0-based (LuaStrings.pas:88), so readers like MangaFire.lua:324 /
  DataLife.lua:112 (`ChapterLinks[ptr]` as Referer) get the same link under this model;
  EHentai.lua:156's limit check is correctly inert with 0 = no limit (host-side D5
  truncation owns the limit). ~10 modules + 2 templates read these fields — a COMPAT.md
  sentence would make the equivalence explicit.
- N-3: HTTP shim `ClearCookies` ≡ `ClearCookiesStorage` under the shared jar
  (http-shim.ts:298–308, documented divergence; FMD2 distinguishes object jar vs storage).
- N-4: antibot `check` throwing would propagate out of `intercept` (antibot.ts:174) where
  FMD2 logs-and-continues (LuaWebsiteBypass.pas:112–114); the default `checkAntiBot` cannot
  throw — only a pluggable injected check could. Defensive try/catch would harden it.
- N-5: pb shim `setdefault`/`option` are no-ops — corpus-verified that no FMD2 module uses
  them (D17 recorded in contract.json:502 note); kept as accepted stubs.
- N-6: live smoke is out of the offline gate by design; the committed live-smoke-report.json
  (2026-11-15T20:52Z, environment "live") is the nightly harness's own record — status noted
  per scope, not audited.

### Clean sections (stated plainly)
- §5.2 event table: verified clean, 15/15 rows, machine-drift-defended.
- §1.2 facade tables (TXQuery, IXQValue, TStrings, MangaInfo, Storage, HTTP, Crypto,
  ImagePuzzle, Duktape, pb, antibot interceptor, §5.8 pipeline): verified clean against the
  Pascal ground truth; no semantic divergence found beyond the documented ones (F-3 note
  N-3 class).
- §2 wiring (routes→zod→client→UI, WS, sync→badges, download chain, favorites, accounts):
  verified clean; the only dead item is F-3.
- §3 probes #1–#10: no BROKEN verdicts.
- §5 probes A1, A3, A4, A5, A6: expected typed-error behavior observed in all five.

---

## 7. Audit hygiene

- Product tree untouched by the audit: this audit only ran gates/tests/probes (read +
  execute) and adds this document. At commit time (`86b4a25`, 2026-11-16 ~00:11 UTC)
  `git status` was clean immediately before and after — the commit contains ONLY
  docs/AUDIT-FINAL.md.
- Probe scripts (referenced above) live in /tmp/opencode: probe3a.ts, probe-pb.ts,
  probe-adv.ts, probe-adv56.ts, probe-adv-crlf2.ts, probe-a4-log.ts; raw outputs:
  probe3a.out, probe-adv.out, probe-adv56.out, probe-pb.out, probe-pb-wirestage.out,
  ci-run.log, coverage-run.log.
- One probe-authoring correction is disclosed in §3 #5 and §5 A1: initial probe
  expectations were wrong (FMD2 SplitURL quirk; protoc parse-stage error text); the Pascal
  sources were consulted and the probes corrected — product code was never in doubt there.
  A second correction is disclosed in §3 #7: the original pb probe quote block was not
  byte-reproducible after a `/tmp` reset; it has been replaced by a corrected probe whose
  script and raw output are the cited artifacts (all claimed values re-verified TRUE).

### 7.1 Addendum — post-commit uncommitted product files are NOT the audit's (review finding resolved with provenance)

After the audit commit, review flagged uncommitted modifications to
`server/src/engine/shims/http-headers.ts` (+20) and
`server/src/engine/shims/http-transport.ts` (+20/−1) (mtimes 2026-11-16T00:50:09/00:50:24Z —
39 minutes AFTER commit 86b4a25) as possibly attributable to the audit. **They are not;
provenance evidence:**

1. **Timeline.** The audit's final `git status --short` (immediately before and after the
   commit) showed ONLY `?? docs/AUDIT-FINAL.md` / clean; the commit itself contains one
   file, 562 insertions, zero source paths. The two source files' mtimes postdate the
   commit by 39 minutes.
2. **Author identified.** Workspace session `olive-juggler-mows` — board worker titled
   "Audit fixes: CRLF transport + module cookies" (created 00:40:45Z, last active
   00:50:38Z) — has these exact edits in its transcript (its `edit` tool calls against
   http-headers.ts/http-transport.ts match the working-tree diff line-for-line, including
   the "audit F-1" comments). Its activity window brackets the mtimes exactly. It is the
   worker of remediation story **tsk-hilly-wagon-picnics** ("Audit remediation: F-1 HTTP
   transport resilience, F-2 MODULE cookie methods, F-3 dead export + COMPAT notes"),
   which went IN_PROGRESS in response to this audit's findings.
3. **Content.** The diff implements remediation pointers (b)+(c) of this report's F-1
   (worker-side CR/LF refusal + try/catch around the worker's `perform()` loop) — written
   in a remediation worker's voice, not audit prose. It is PARTIAL work: of the session's
   five planned edits, three persisted (its remaining todo list — host-side send()
   validation, worker 'exit'/'error' lifecycle handlers, F-2/F-3/N-4, tests, gates — is
   still pending in its transcript), so the tree is mid-remediation WIP, not a finished
   change.
4. **Action taken.** NONE — deliberately. The audit charter is read/run-only (no product
   edits, including revert/commit of third-party work). The WIP belongs to
   tsk-hilly-wagon-picnics, which must resume, complete, test, and commit it. The audit
   story's deliverable claim stands unmodified: **zero uncommitted product-code changes
   attributable to the audit** — the two dirty files are attributable to the remediation
   story's worker, with the session/timestamp/transcript evidence above.
