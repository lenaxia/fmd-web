# Evidence — tsk-retro-cyclone-kicks (seed module offline e2e: host + shims v0)

Phase-0 exit gate: the first end-to-end offline flows running REAL FMD2
module files through the wasmoon host with the §5.4/§5.6/§5.7 v0 shims,
ground-truthed against the FPC-oracle corpus.

## Delivered

**Shims (`server/src/engine/shims/`)**

- `http-shim.ts` — HTTP v0 (§5.4): undici `Response`/`Headers` envelopes from
  a `RecordedResponseResolver` (fixture lookup by URL — NO live network),
  Document stream facade (`ToString`/`WriteString`/`Clear`/`Size`, success ⇔
  `Size > 0` per httpsendthread.pas:717), ResultCode/ResultString/LastURL,
  case-insensitive `Headers.Values`/`Cookies.Values` + cookie jar fed from
  Set-Cookie, GET/POST (+ the POST Content-Type→MimeType move and the
  `text/html` → `application/x-www-form-urlencoded` rewrite :730-747), XHR,
  Reset/ResetBasic header sets, `Terminated` from the abort handle.
- `query-dialect.ts` + `txquery-shim.ts` + `txquery-facade.ts` — TXQuery v0
  (§5.6): FontoXPath 3.1 over linkedom behind the InternetTools dialect
  transform (`json()`/`parse-json()` node trees — objects → key elements,
  arrays → `item` elements, typed scalar leaves; `.step` shorthand, chained
  `name()()` array steps, `?map` lookups, `css()`, `not(key)` →
  JSONiq value-EBV (`fmd:not`) inside json predicates); repairing-parser
  preprocessing (CRLF/CR → LF, adjacent-text-node merge, comment/PI drop,
  whitespace-after-`</body>` skip, bare-payload scaffold); list-fill
  overloads (`XPathStringAll`/`XPathHREFAll`/`XPathHREFTitleAll` incl.
  `(expr, node, list)`); IXQValue facade (`Get()` iterator / `Get(i)` /
  `GetProperty` / `GetAttribute` / `ToString` inner-text / `InnerText` /
  `Count`); `ParseHTML` 1-arg instance reparse; error swallow → empty +
  rate-limited WARN per (module, expression).
  Focused unit suites: `txquery-json.test.ts`, `txquery-fill.test.ts`,
  `txquery-swallow.test.ts`, `ixqvalue.test.ts`.
- `duktape-shim.ts` — Duktape v0 (§5.7): `ExecJS` via node:vm (5 s timeout),
  ONE heap per ExecJS (duk_peval semantics: completion value, JSON text for
  object/array results — the Madara template's gsub/gmatch contract),
  `Duktape.enc`/`dec` polyfill, JS-side CommonJS `require` (module/exports,
  heap-cached, path-jailed to the synced lua tree), error → nil
  (LuaDuktape.pas:18-24), print → host log (Duktape.pas:90).
- `pb-shim.ts` — `pb` v0 (D17): protobufjs-backed `package.preload['pb']` —
  `load` (raw `.proto` text AND serialized google.protobuf.FileDescriptorSet
  via the bundled descriptor.proto; `(ret, pos)` binding per
  protoc.lua:1176,1183), `decode` (proto3 defaults, proto name casing via
  keepCase), `encode`.
- `lua-require.ts` — the Lua `require` machinery (LuaPackage.pas): `fmd.*`
  host libs + file-package searcher over the synced lua tree + `pb`
  preload; `fmd.env`, `fmd.crypto` v0 subset, `fmd.fileutil` helpers.
- `install.ts` — engine wiring: facade-id marker, require install before
  chunk execution (modules require templates at top level), real
  `CreateTXQuery` (HTTP.Document facade | string | none).
- Engine integration: `WasmoonLuaEngine.loadModule(…, preChunkSetup)` hook,
  dispatcher `DispatcherShims` (real per-event HTTP factory + host account
  seeding reached as `MODULE.Account`), `LuaModuleDescriptor.totalDirectory`.

## Seed flows (offline, golden-evidenced)

`server/test/engine/e2e/` — goldens under `server/test/engine/golden/e2e/`:

1. **comick-getinfo** — JSON API GetInfo: json() node trees, node-scoped
   `XPathString(expr, json)`, `?*` map iteration, `MangaInfoStatusIfPos`,
   `require 'utils.json'`, option lookups, chapter-list pagination,
   future-dated chapter filtering.
2. **asurascans-getinfo** — `json(*).series` context nodes, `?*` inside
   string-join, `upper-case||lower-case` composition, nested
   CreateTXQuery(string) reparse, `[not(is_premium)]` value filtering,
   chapter Reverse().
3. **hentai2read-getpagenumber** — list-fill `json(...).props.images()` →
   TASK.PageLinks, plus **PAGENUMBER read-back = 1752** from the RECORDED
   corpus fixture (oracle triple 17#1).
4. **madara-template-getpagenumber** — BrainRotComics → templates.Madara →
   the chapter-protector path: `fmd.duktape.ExecJS` with JS-side
   `require("utils/crypto-js.min.js")` + `utils/cryptojs-aes-format.js`
   (committed AES ciphertext, one-time encrypted with the pinned crypto-js),
   TASK.PageLinks gmatch + the `i%d.wp.com/` cleaning loop,
   TASK.PageNumber read-write semantics, WORKID binding-table guard.
5. **ehentai-getinfo-login** — account-status constants, MODULE.Account
   (Enabled/Username/Password/Status → asValid), EncodeURLElement POST body,
   cookie jar from server Set-Cookie, css()/@style extraction, and FMD2
   parity on the REAL module bug at EHentai.lua:71 (`.x` field — errors
   identically in FMD2; host default page count).
6. **tapas-totaldirectory** — `MODULE.TotalDirectory = 2`, no
   GetDirectoryPageNumber handler → host guard (uUpdateThread.pas:197-206
   semantics), Init option surface.

## Corpus replay (live engine vs FPC oracle)

`server/test/engine/shims/corpus-live.test.ts` + committed golden report
`server/test/engine/golden/seed-corpus-live-report.golden.json`:

- **912 cases · 908 passed · pass rate 99.56%** (gate ≥99%); 100% of the
  885 seed EXPRESSION cases — the 4 remaining failures are §5.8 uData
  normalize gaps owned by the facades story (tsk-feral-lumber-leaves),
  each with root cause + tracking in `docs/COMPAT.md`
- engine `fontoxpath-linkedom`, normalization `udata-normalize` (§5.8)
- every miss carries a root cause in `docs/COMPAT.md` (generated by
  `corpus/scripts/generate-compat.ts`, curated sections preserved)

## Unit gates

- `pb-shim.test.ts` — sample schema round-trips decode/encode/load
  ((ret,pos)), proto3 defaults, protoc.lua path (FileDescriptorSet).
- `duktape-shim.test.ts` — **`require("utils/crypto-js.min.js")` resolves
  from the pinned lua tree inside node:vm and the Madara decryption
  snippet executes**; error→nil incl. the 5 s timeout; jail escapes → nil;
  enc/dec polyfill; print → host log.

## Verification

- `npm run typecheck` — 0 errors
- `npm run lint` — clean
- `npx vitest run` — **501 passed (44 files)**, fully offline
  (zero-network guard active)

## Concurrency notes (shared workspace)

Merged with three concurrent sibling stories: facades (TStrings/MangaInfo/
IXQValue/Storage + §5.8), crypto (full LuaCrypto), generated event runtime
(bindings). Fixes landed on the shared seam: fmdItemString atomic-string
handling, facade.lua require order (init hook), dispatcher account arg,
stale compiled `.js` artifacts inside `server/src` removed (they shadowed
the TS sources for vite). `docs/COMPAT.md` was accidentally overwritten by
the first generator run and rebuilt; the generator now PRESERVES curated
sections below the `## fmd.crypto compatibility notes` marker.
