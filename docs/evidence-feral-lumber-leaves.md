# Evidence — tsk-feral-lumber-leaves (facades: TStrings/MangaInfo/IXQValue/Storage + §5.8 pipeline, golden tests)

Date: 2026-11-13T06:40Z · Environment: node v24.20.0, wasmoon 1.16.0,
FPC 3.2.2 (`/home/sandbox/fpc-3.2.2`, the pinned corpus-harness toolchain),
linux. Implementer session: rational-cadet-plumbs.

## Scope

`server/src/engine/normalize/` (fmdstrings.ts + udata.ts — the §5.8 pipeline
port), `server/src/engine/lua/tstrings.ts` (FPC TStringList-semantics list),
`server/src/engine/lua/mangainfo.ts` (MANGAINFO facade factory),
`server/src/engine/lua/storage.ts` (Storage facade + StorageStrings seam),
`server/src/engine/lua/stubs.ts` (TStrings facade rewired to full contract +
jailed file IO), `server/src/engine/events/dispatcher.ts` (binds the shared
factories; per-module shared storage backings),
`server/test/engine/{normalize,lua,shims}` (28 golden + 46 facade/property +
9 IXQValue tests), `corpus/fixtures/capture/getinfo-normalization-0006..0030`
(25 new FPC-oracle input+triples batches) and their README documentation.

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Post-processing golden tests: outputs byte-equal to harness normalization ground truth for ≥20 fixture manga-infos (incl. dedup-order, name-cleanup, prefix-strip flag cases) | `corpus/fixtures/capture/` now carries **27 normalization batches** (0003, 0004-prefixstrip pre-existing + 25 new, `getinfo-normalization-0006..0030`), all captured with the pinned FPC oracle (`fmd_capture normalize`, FPC 3.2.2, internettools/FLRE pins baked in). `pipeline.golden.test.ts` (28 tests): ≥20 guard + one byte-equality test per fixture — `JSON.stringify(actual) === JSON.stringify(triple.normalized)`, i.e. exact field values AND the oracle's emit order. Coverage: dedup-order (0007 last-wins groups, 0008 interleaved/untouched-never-move, 0023 triple-duplicate), name-cleanup (0014/0029 entity tables incl. `&ndash;`→ASCII `-`, full-width brackets, broken entities), prefix-strip flag off/on (0011/0012/0025 incl. uppercase + unicode folding, `- ` variant, length guard), pad/prune (0009/0010/0026), pair-deletion on empty host-strip results (0013), fix-info sentinels (0015), FixWhiteSpace/CleanMultilinedString (0016/0017), single-string Text-split lists (0018), null/non-string/number shapes (0019/0020), host-strip flag off (0021), CleanURL variants (0022), link fallback vs set (0027/0028), empty lists + status passthrough (0024/0030). TDD: the golden test was written FIRST and failed (module absent) before `udata.ts` existed. All 27 triples **reproduce byte-identically** from the binary (`fmd_capture normalize` + `diff -q`, 27/27 OK); `validate-triples.mjs`: 30 files, 63 triples, 0 failures | met |
| TStrings property tests pass for the full documented surface incl. CommaText/DelimitedText round-trips | `tstrings.ts` is a statement-level port of the REAL FPC 3.2.2 rtl (`rtl/objpas/classes/stringl.inc` @ release_3_2_2 — fetched from the FPC GitLab and verified against the installed binary with probe programs; every decision documented case-by-case in the file header): Add(returns index)/AddText(DoSetTextStr append)/Get/Set[i] 0-based + EStringListError-parity throws/Count/Clear/Delete/IndexOf (case-sensitive)/IndexOfName (ASCII-case-insensitive, first-separator prefix, `''` matches lines starting with the separator)/Reverse (LuaStrings.pas exchange loop)/Sort (CompareText ASCII fold)/Text get (trailing LineBreak, LF per the Linux oracle — FMD2 Windows would emit CRLF; documented)/Text set (#10/#13/CRLF, trailing adds no item)/Values get-set (untrimmed values, in-place case-insensitive overwrite writing the name AS GIVEN)/CommaText (forces `,`+`"`, quoting rule ≤#32/comma/quote, single-empty-item → `""`)/DelimitedText (current delimiter/quote; whitespace-separated tokens, quoted sections with `''`→literal)/Delimiter/NameValueSeparator. `tstrings.test.ts` (23 tests): oracle-pinned unit cases (probes P1-P14/E1-E8/T1-T7/V1-V5/N1-N4/C1-C4/D1-D3/Q1-Q3) + 4 PROPERTY tests: CommaText get→set round-trip (200 fuzzed lists incl. commas/quotes/spaces/tabs/empty items), DelimitedText round-trip with custom delimiter/quote, CommaText set→get fixed point, Text set→get round-trip. Facade wired in `stubs.ts` (`makeTStrings`) — Lua-level facade tests in `facades.test.ts`: bracket access, sub-facades, Text/CommaText/DelimitedText/Delimiter/NameValueSeparator through Lua, OOR raises a catchable Lua error (`List index (5) out of bounds`), unknown-key no-ops | met |
| IXQValue facade methods each unit-tested (Get iterator over multi-node results, GetProperty on JSON nodes, GetAttribute on elements) | `ixqvalue.test.ts` (9 tests, Lua-driven through the facade bridge against the TxQueryShim's `createIxq`): Get() iterator over 3-node results (collects ToString of each, terminates nil, stays nil after exhaustion), Get(i) 1-based incl. Get(4)→nil and Get(0)→nil, Count read-only, GetAttribute on elements (present/missing attributes), ToString = inner TEXT not outerHTML (contract row) + identity for string items + empty for empty, InnerHTML/OuterHTML, GetProperty on JSON node-tree children (fmd:json shape: object→key-named children) incl. nested chains, GetProperty miss → EMPTY facade never nil (FMD2 xqvalue()), and the full §5.6 path `CreateTXQuery(html).XPath('//a')` → Get iterator + GetAttribute. **Tests drove two real facade fixes** (in `txquery-facade.ts`, coordinated with the concurrent §5.6 story): (1) method-slot installation now `rawset`s — the facade metatable's `__newindex` was routing the Lua closures through the JS bridge, handing back userdata-wrapped functions; (2) facade-id resolution is now pure-Lua (`__fmd_ixq_resolve` — get-or-create + slot install) and JS-side registration uses negative ids (`registerIxq`), removing re-entrant `doStringSync` from C-callbacks (Get(i)/GetProperty/XPath results); the Get closure now dispatches dot AND colon shapes (`tonumber(b) or tonumber(a)` — FMD2 modules use dot: `v.GetAttribute('href')`, `x.XPath(...).Get()`) | met |
| Unknown-property no-op + case-sensitivity covered by facade contract tests | `mangainfo.test.ts` (4 tests): the exact 10-string-field + ChapterLinks/ChapterNames surface (LuaMangaInfo.pas:23-34 order), the `MANGAINFO.Artist` typo (OrckuMangas.lua:91) reads nil + write dropped, `title` vs `Title` distinct keys (lowercase write does not touch the field), `chapterlinks` vs `ChapterLinks`, and the host-side harvest seam (fields + chapter lists read back what Lua wrote — the §5.8 input shape). `facades.test.ts` covers TStrings unknown-key no-ops; `storage.test.ts` covers the Storage rows (KV names ASCII-case-insensitive per FPC IndexOfName — the documented Storage semantics — plus Tag/Enable/Status typed writes and host-owned Free/Destroy no-ops) | met |

## Additional deliverables in scope

- **MangaInfo facade factory** (`lua/mangainfo.ts`): shared `makeMangaInfoSpec`
  used by the dispatcher (replacing the inline spec); exposes the host seam
  (`fields`/chapter lists) the GetInfo flow will feed into `normalizeMangaInfo`.
- **Storage facade** (`lua/storage.ts`): `makeStorageSpec` +
  `StorageStrings` seam + `TStringsStorageStrings` (FMD2 defaults: Tag=0,
  Enable=true, Status=`'my status of TStringsStorage'` — LuaStringsStorage
  ctor) + `storageStringsFromMap` adapter (TStrings semantics layered on a
  plain shared map: case-insensitive names, untrimmed values). Every op runs
  behind the injected critical-section lock (§5.3; JS event-loop atomicity
  documented in-file). The dispatcher keeps ONE `TStringsStorageStrings` per
  module id — the shared-state-service seam for the §5.3 story.
- **Jailed TStrings file IO** (§8.2): `createJailedFileIO(jailRoot)` —
  realpath containment + symlink-component walk; `LoadFromFile/SaveToFile`
  route through it when configured, raise when not (FMD2 raises on missing
  files); LoadFromStream/SaveToStream raise (stream objects are §5.4 — FMD2
  also raises on non-stream userdata).
- **FPC 3.2.2 rtl semantics pins**: `stringl.inc` @ release_3_2_2
  (DoSetDelimitedText/GetDelimitedText/GetTextStr/GetNextLine/IndexOfName/
  GetValue/SetValue/DoCompareText) fetched and cross-checked against the
  installed compiler with probe programs — the probes and their outputs are
  cited per-case in `tstrings.ts`/`tstrings.test.ts`.

## Test/gate status for this task's files

```
npx vitest run server/test/engine/normalize server/test/engine/lua \
  server/test/engine/shims/ixqvalue.test.ts server/test/engine/events \
  server/test/smoke.test.ts            → 13 files, 181 tests, 180 passed
  (the 1 failure is init-pass golden JSON: the concurrent §5.3 story added
   `totalDirectory` to descriptors — their artifact to regenerate)
node corpus/scripts/validate-triples.mjs corpus/fixtures/capture/*.triples.json
  → validated 30 files, 63 triples, 0 failures
eslint (all files touched by this task) → clean
tsc -b → my files clean (remaining errors are in the concurrent story's
  in-flight files: shims/duktape-shim.ts, shims/lua-require.ts, e2e/harness
  mid-edit — I fixed the one line referencing my API: harness bindMangaInfo
  now passes makeMangaInfoSpec(bridge).spec)
```

Full-suite snapshot at evidence time: 465 tests, 463 passed — the 2 failures
(madara-template e2e, init-pass golden) are in the concurrent story's
in-flight files, untouched by this task.

## Concurrent-work coordination notes

Two stories ran concurrently in this workspace (§5.3 shared state + §5.4/§5.6
shims). Boundary decisions taken to avoid stepping on them: the Storage facade
owns the `StorageStrings` interface and its FMD2-semantics implementations in
`lua/storage.ts` (the §5.3 service adapts via `storageStringsFromMap`); the
dispatcher's per-module storage backings use that seam. The IXQ facade fixes
were made surgically inside `txquery-facade.ts` (the §5.6 story's file) after
my tests proved the defects; the fixes preserve their architecture (luaSlots,
IXQ_GLUE, createIxq).

## Reproduction commands

```sh
# §5.8 golden (byte equality against FPC oracle, 27 fixtures)
npx vitest run server/test/engine/normalize/pipeline.golden.test.ts
# TStrings property/unit suite
npx vitest run server/test/engine/lua/tstrings.test.ts
# Facade contract suites
npx vitest run server/test/engine/lua/mangainfo.test.ts server/test/engine/lua/storage.test.ts
# IXQValue suite
npx vitest run server/test/engine/shims/ixqvalue.test.ts
# FPC byte-reproducibility spot check (needs make harness once)
B=corpus/harness/bin/fmd_capture; F=corpus/fixtures/capture
$B normalize $F/getinfo-normalation-0011.json /tmp/n.json 2>/dev/null || $B normalize $F/getinfo-normalization-0011.json /tmp/n.json
diff -q /tmp/n.json $F/getinfo-normalization-0011.triples.json
node corpus/scripts/validate-triples.mjs corpus/fixtures/capture/*.triples.json
```
