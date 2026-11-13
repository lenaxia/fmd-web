# REVIEW-003 — Adversarial Design Review, Round 3 (of DESIGN.md v3)

Reviewer: independent skeptical-architect agent. Round-2 findings were
incorporated into v3; this round verified v3 row-by-row and probed the
module corpus where earlier rounds probed the Pascal host. Status:
**accepted** — the one Major finding (M1) and all minors are fixed in
DESIGN.md v4.

---

## Verdict summary

The design has converged structurally. The v3 centerpiece — the §5.2
table — is, for the first time in three rounds, **fully correct**: all 15
dispatchers verified row-by-row against `LuaWebsiteModules.pas:154–465`,
no wrong rows, no fabricated globals, correct read-back rules and return
types. §5.3's concurrency claims, §5.8's pipeline location, §7.2's
favorites semantics, §5.6's fill overloads, and §5.4's HTTP claims all
verify against source. One genuine Major gap remained, found by probing
the module corpus: FMD2 ships a native Lua C module (`pb`, lua-protobuf,
as `pb.dll`) that MangaPlus hard-requires and that was absent from the
contract — under v3's require policy that module dies at chunk-load.
No Critical findings.

## Major findings

### M1. `pb` (lua-protobuf) required runtime dependency absent from the contract
- `lua/modules/MangaPlus.lua:54` — `local pb = require 'pb'` at chunk top
  level (hard require), `pb.decode('Response', …)` at `:123, :143, :191`.
- FMD2 provides `pb` as a **native C-module DLL** (`dist/x86_64-win64/
  pb.dll`, `dist/i386-win32/pb.dll`) resolved via `package.cpath`; there is
  no `pb.lua` and no `package.preload` registration. `utils/protoc.lua`
  pcall-requires it and degrades gracefully; MangaPlus does not.
- Under v3: `require 'pb'` throws → MangaPlus chunk fails registration →
  module dropped — a guaranteed, undocumented breakage of a high-profile
  module (Shueisha official, protobuf API).
- Fix (adopted as D17): `package.preload['pb']` shim backed by protobufjs
  (`decode`, `encode`, `load` — the protoc `has_pb` branch needs
  encode/load too, `protoc.lua:993+`); add `pb` to §5.7 + §8 allowlist;
  MangaPlus into the Phase-0 seed list.

## Minor findings (all fixed in v4)

1. §5.8 duplicate-chapter rule inverted: `uData.pas:158–172` deletes index
   `j` (the **earlier**) — **last** occurrence survives. Also omitted:
   per-name cleanup (`Trim(CleanString(RemoveStringBreaks(
   CommonStringFilter(...))))`, `:181–183`) and
   `OptionRemoveMangaNameFromChapter` (`:186–202`).
2. Bypass single-flight is a `TryEnterCriticalSection` with **fallthrough**
   — concurrent loser proceeds with the plain request
   (`LuaWebsiteBypass.pas:161, 196–200`); bypass-internal HTTP safely
   re-enters the interceptor because the global antibot lock releases
   before bypass execution (`:94–115` vs `:159`). Waiting-on-singleflight
   implementations would serialize download workers behind a 15–60 s
   bypass.
3. `Storage` facade is more than a KV map: `Text` (get/set), `Remove`,
   `Tag`, `Enable`, `Status` (`LuaStringsStorage.pas:150–159`); modules
   use `MODULE.Storage.Text`.
4. Require-name drift: registrations carry the `fmd.` prefix
   (`LuaPackage.pas:23` — `fmd.pcre2`, `fmd.strings`,
   `fmd.mangafoxwatermark`); **`fmd.websitebypass` does not exist** (file
   loader as `websitebypass.cloudflare`/`ddos-guard`, host-invoked,
   `websitebypass.lua:8,10`); `templates.*` missing from the table (41
   files; 76 Madara consumers).
5. Unknown-property tolerance is contract: LuaClass silently no-ops
   unknown keys, case-sensitive (`LuaClass.pas:94–169`);
   `MANGAINFO.Artist` typo in `OrckuMangas.lua:91` must be silently
   dropped.
6. Citation drift: success=`Document.Size>0` is `:717` (not :559); `XHR`
   `:749–755` (not :786–792); `SetProxy` impl `:838–874`.
7. WS backfill unbounded — cap needed.
8. First-run bootstrap unspecified (all catalogs missing until manual
   sync).
9. Count nit: `lua/modules/` holds **417** `*.lua` files.
10. Phase-0 harness: pin internettools + FLRE externally; record the
    internettools commit in corpus metadata; `uBaseUnit.pas` pulls
    LCL/LConvEncoding — replicate pure helpers instead of linking.
11. §13.5 extractor: implementable over the small stable call vocabulary,
    but must fail loudly on unrecognized patterns.

## v3 verification result

All §5.2 rows ✅ (15/15, including SaveImage string return and
AfterImageSaved FILENAME-only); no `ACCOUNT` anywhere; §5.1 surface
complete; §5.3 concurrency citations real; §5.4 header sets + behavior
✅ (citations drifted only); §5.6 fill overloads + IXQValue ✅; §5.8
location/order ✅ (two textual nits → minor 1); §5.9 mechanics ✅;
§5.10/5.11 ✅; §5.12 ✅; §7.1/7.2 ✅; §6 schema ✅; §8 key ✅; Lua 5.4
define matches Win64 shipping build (`md.lpi:293`); Init rules ✅; base
globals ✅; UPDATELIST ✅; TASK/MANGAINFO field lists exact; 128 modules
use MangaInfoStatusIfPos (count verified).

## Sound areas

§5.2 binding table (finally correct in full) · PAGENUMBER sole read-back ·
push-only BeforeDownloadImage URL · §5.3 shared-state model · HTTP shim
semantics · fill overloads · normalization pipeline location · favorites
engine + dual-write · 'W'/'D' resume + dedupe key · bypass mechanics ·
zstd policy · D10 language safety · CI dispatcher cross-check
implementable · no decision-log contradictions.

## Remaining open questions (resolved as D17–D20 in v4)

1. `pb` shim scope (decode vs encode/load for protoc) → D17 covers both.
2. zstd add-on trigger → D18 (measurable: ≥2 affected modules in weekly
   smoke).
3. WS backfill cap → D19 (1000 events / 15 min).
4. First-run bootstrap → D20 (auto-seed default-on).
