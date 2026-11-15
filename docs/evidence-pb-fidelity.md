# Evidence: pb shim fidelity — `pb.load` two-value contract (tsk-punctual-toybox-plumbs)

Audit bucket C, release-blocking finding: `server/src/engine/shims/pb-shim.ts`
(v0) returned a **single value** from `pb.load`, while FMD2's bundled
`utils/protoc.lua:1176,1183` binds `local ret, pos = pb.load(...)` — the
second return was dropped. The existing test titled "(ret,pos)-style"
asserted only one value (test-bent-to-match-the-shim).

## 1. Ground truth (both sources, cited in-code)

**lua-protobuf README** (github.com/starwing/lua-protobuf, `pb` Module):

> | `pb.load(data)` | boolean,integer | load a binary schema data into `pb` module |
>
> **Schema loading**: "`pb.load()` accepts the schema binary data and
> returns a boolean indicates the result of loading, success or failure,
> and a offset reading in schema so far that is useful to figure out the
> reason of failure."

**lua-protobuf pb.c** (`Lpb_load`, master) — always exactly TWO values:

```c
static int Lpb_load(lua_State *L) {
    lpb_State *LS = lpb_lstate(L);
    pb_Slice   s = lpb_checkslice(L, 1);
    int        r = pb_load(&LS->local, &s);
    if (r == PB_OK) global_state = &LS->local;
    return lua_pushboolean(L, r == PB_OK), lua_pushinteger(L, pb_pos(s) + 1), 2;
}
```

**The bundled consumer** — `FMD2/lua/utils/protoc.lua` (untouched ground
truth):

```lua
:1143 function Parser.reload()
:1144    assert(pb.load(descriptor_pb), "load descriptor msg failed")
:1145 end
:1176 local ret, pos = pb.load(self:compile(s, name))
:1177 if ret then return ret, pos end
:1178 error("load failed at offset "..pos)   -- pos must be a NUMBER (concat)
:1183 local ret, pos = pb.load(self:compilefile(fn))
```

## 2. Derived contract (charter assumption confirmed, with refinements)

The charter's assumption — `pb.load` returns `(ret, pos)` — is **confirmed**
by all three sources; no anti-papering divergence. Refinements the
evidence pins down beyond the charter:

1. `ret` on failure is boolean **false** (pb.c `lua_pushboolean(L, r == PB_OK)`),
   never nil; and the return is ALWAYS two values.
2. `pos` is the 1-based byte offset **read so far** (`pb_pos(s) + 1`):
   success = `byteLength + 1` (slice fully consumed); failure = the offset
   the parse stopped at (protoc.lua:1178 concatenates it — it must be a
   number). Empty input → `(false, 1)`.

The shim now implements exactly this via wasmoon's `LuaMultiReturn`
(the function decorator expands it into two Lua values;
`select('#', pb.load('')) == 2` proven in the integration test), with
`pos` derived from the protobufjs `Reader.pos` cursor.

## 3. Findings the fix surfaced (v0 could never serve protoc.lua)

1. **Byte-lossy marshaling kills the descriptor path.** wasmoon converts
   Lua strings to JS by UTF-8 decoding with replacement (and truncates at
   NUL), and pushes JS strings UTF-8-encoded. Probe (wasmoon 1.16.0):
   `string.char(10,179,59,0,200,206,184)` (7 bytes) arrived in JS as a
   3-char string; a 5-byte latin1 string arrived in Lua as 4 bytes.
   protoc.lua's embedded `descriptor_pb` (protoc.lua:996-1141, full of
   `\ddd` escapes ≥ 0x80) can never cross raw. The committed
   registration-summary artifact **proves it happened in practice**: the
   recorded MangaPlus Init failure was
   `"utils/protoc.lua:1144: load descriptor msg failed"` — Parser.reload's
   assert on the old shim. Fix: the same byte-exact base64 Lua bridge the
   fmd.crypto shim established (COMPAT.md "byte strings") — `PB_LUA_GLUE`
   envelopes `pb.load`/`pb.decode` args and `pb.encode` results; the
   dispatcher returns `pb.load`'s `LuaMultiReturn` straight through as a
   two-value Lua return.
2. **`pb.encode('.google.protobuf.FileDescriptorSet', …)` never worked in
   v0**: descriptor.proto was parsed into a throwaway root for decoding
   but never registered in the shim's main root, and v0's test never
   called `pb.encode` with it. protoc.lua:1165/1171 require it before any
   user load. Fix: eager descriptor registration in `makePbShim` —
   Parser.reload parity (protoc.lua:1143-1145, invoked at :1188).
3. **Raw `.proto`-text load path removed** (v0 heuristic
   `s.includes('message ')…`): native `pb.load` accepts only serialized
   descriptors; protoc.lua is the text→descriptor compiler. Nothing in
   FMD2 calls `pb.load` with raw text (grep: protoc.lua:1144,1176,1183
   only). The approximation the audit dislikes is gone rather than kept.
4. **enum-as-name**: lua-protobuf's default `enum_as_name` decodes enums
   to their NAME strings; v0's `enums: Number` would break
   `MangaPlus.lua:129 GetLang` (keys off names like `'RUSSIAN'`). Fixed.
5. **Null stripping**: protobufjs `toObject` emits `null` for absent
   message fields; wasmoon's `pushValue` crashes on JS `null` crossing
   into Lua (`Cannot read properties of null (reading 'then')` — observed
   decoding the golden payload). Native lua-protobuf yields nil there;
   `decode` now strips nulls.

## 4. Test matrix (all offline)

`server/test/engine/shims/pb-shim.test.ts` (rewritten; 9 tests):
- eager descriptor preload → `pb.encode('.google.protobuf.FileDescriptorSet', …)`
  works before any load (Parser.reload parity);
- `(true, len+1)` success contract with exact offset;
- `(false, pos)` failure contract + the literal protoc.lua:1178 statement
  (`error("load failed at offset "..pos)`) throwing `/^load failed at offset \d+$/`;
  empty input → `(false, 1)`;
- trailing-bytes-after-descriptor-set rejection (native pb_load parity);
- schema round-trip with proto3 defaults + enum-as-name;
- re-load idempotence (reload + module loads over each other);
- Lua bridge protocol: base64 envelope byte-exactness (NUL + high bytes +
  CJK), two-value expansion, nil-failure decode.

`server/test/engine/shims/pb-protoc.integration.test.ts` (new; 7 tests,
the REAL `utils/protoc.lua`, no stub, through wasmoon + `installRequireShim`):
- `require 'utils.protoc'` executes the `has_pb` branch (protoc.lua:993)
  INCLUDING `Parser.reload()` (protoc.lua:1188) over the embedded
  descriptor bytes — fails the test if the bridge loses a byte;
- `pb.load` binds `(ret, pos)` as two values from Lua (`select('#') == 2`,
  numeric pos — the protoc.lua:1176 shape);
- `protoc:load(MangaPlus.proto)` (committed fixture copy of
  `FMD2/lua/modules/MangaPlus.proto`, md5 a74dc73768ba1f46301d83b113352fc8,
  with `protoc.proto3_optional = true` — MangaPlus.lua:109-110) returns
  `(true, pos)` with `pos == #protoc:compile(src) + 1`;
- round-trip `pb.encode`/`pb.decode` of `Response`/TitleDetailView fields
  from the schema MangaPlus actually uses (incl. enum names + nested
  repeated Tag);
- golden recorded payload replay
  (`corpus/fixtures/seed/MangaPlus/source.bin` — the §13.1 seed, manifest:
  "pb.decode Response payload — provenance for the pb shim"): the fixture
  is the API's **field-2 error variant** ("Account Banned"); the module's
  unguarded MangaPlus.lua:123 chain errors exactly as it does under native
  pb (pcall-asserted), which FMD2's event handler turns into net_problem;
- full GetNameAndLink chain on a schema-true allTitlesViewV2 Response
  (titles/links/names/languages as MangaPlus.lua:126-129 consumes them);
- protoc.lua:1178 error shape through the bridge (numeric offset).

Results: `pb-shim.test.ts` 9/9, `pb-protoc.integration.test.ts` 7/7,
`contract/test/drift-check.test.ts` 15/15 (0 mismatches),
`server/test/engine/registry/` 28/28 (incl. require-registry gate parity
with the real loader registry — `require 'pb'` served through
`package.preload`), full `server/test/engine/shims/` 319 passed.

## 5. Registration-summary artifact (updated, gate-justified)

`server/test/engine/registry/registration-summary.json` byte-matches a
fresh sweep (`UPDATE_REGISTRATION_SUMMARY=1`; the committed gate). The
ONLY diff line is MangaPlus's recorded Init-failure reason:

- before: `"utils/protoc.lua:1144: load descriptor msg failed"` — the pb
  shim's own failure (see §3.1) — this story's fix removes it;
- after: `"MangaPlus.lua:99: MangaPlus.proto: No such file or directory"` —
  the sweep harness's CWD-relative `io.open` for the module's data file
  (MangaPlus.lua:106-108 resolves `MangaPlus.proto` next to the script;
  FMD2's deploy layout has it, the sweep's CWD does not). The pb/protoc
  path itself now passes; the residual miss is the §io.open data-file
  concern, outside this story's charter.

## 6. Pre-existing failures NOT from this story (verified unmodified inputs)

- `crypto-composed.test.ts` CFB8 EncryptString vector — in-flight edits to
  `crypto-core.ts`/`crypto-shim.ts`/that test (another story's working
  tree; this story never imports them).
- `corpus-live.test.ts` `docs/corpus-report.json` ENOENT — the artifact
  another story's test expects does not exist in the tree yet.

Concurrent-story coordination observed (no action taken on their files):
`contract.json` pb row flipped `planned`→`implemented` by the registry
story (matches `REQUIRE_SHIM_REGISTRY`'s implemented row); the drift gate
(15/15) stays green with the pb wiring in place.

## 7. Review bounce response (verdict: fail → addressed)

**Blocker — `docs/COMPAT.md:27` + `corpus/scripts/generate-compat.ts:164-166`
[criterion 3].** Root cause found: COMPAT.md is a GENERATED artifact — the
pb row text is hardcoded in the generator's `bindingStatus.pb.note`, and a
regeneration reverted the first-pass row edit. Fixed at the source:
- `generate-compat.ts` pb note rewritten to the implemented-with-two-return
  fidelity text (bridge, two-value contract citations, serialized-FDS-only
  input, eager descriptor preload, enum-as-name, nil parity, integration
  test pointer);
- `npx tsx corpus/scripts/generate-compat.ts` regenerated `docs/COMPAT.md`
  (row 27 now carries the new text) and materialized
  `docs/corpus-report.json` (912/912 = 100.00%) — resolving the corpus-live
  ENOENT too. The generator's stale gzip/logger/pcre2 unit rows were also
  refreshed to match the shipped shims (they had been implemented by the
  deferred-lib stories but the generator still said deferred/partial).

**Minor — `scripts/contract-drift-check.ts` requireShims rows [criterion 3].**
The sanctioned CLI (now registry-attached) exposed 3 real mismatches:
`requireShims["fmd.gzip"|"fmd.logger"|"fmd.pcre2"].status: contract=planned
registry=implemented` — the deferred-lib stories flipped the registry
(the declared single source of truth) but not contract.json. Fixed by
aligning the three contract.json rows to the registry (implemented, with
implementation text updated to the shim truth: gzip 3-way auto-detect
Inflate, logger full Send/SendWarning/SendError surface, pcre2
exec/find/match/gmatch/gsub facade). Gate now:
`npx tsx scripts/contract-drift-check.ts` → **OK — 0 mismatches**.

Supporting fixes required by the same gate family (verified green):
- `contract/test/drift-check.test.ts`: frozen `registryFixture` rows for
  gzip/logger/pcre2 refreshed to the shipped registry state (the fixture
  exists because @fmd/contract cannot depend on @fmd/server); the
  "planned → implemented lie" mutation victim moved from fmd.gzip (now
  genuinely implemented) to fmd.imagepuzzle (still planned);
- `gzip-shim.ts` Lua glue: the `package.preload['fmd.gzip']` entry was a
  raw TABLE — Lua `require` treats a non-callable preload entry as
  not-found, so `require 'fmd.gzip'` failed the registry's
  runtime-agreement gate (`require-registry.test.ts`). Wrapped as a
  loader function returning the lib table (the same shape as the
  fmd.crypto / pb preloads); probe verified: `require 'fmd.gzip'` now
  resolves.

Final gate state at re-dispatch: contract drift-check vitest 27/27,
require-registry 7/7 (incl. real-drift-check gate parity + runtime
agreement), pb-shim 9/9, pb-protoc integration 7/7, corpus-live 4/4,
registry sweep 11/11, sanctioned CLI 0 mismatches — 82/82 in one run.
Known-external (owned by their in-flight stories, predates this bounce):
`gzip-shim.test.ts` fails at collect time with a JS `ReferenceError
(engine is not defined)` in its own uncommitted file (the Lua require
itself is proven working by require-registry's runtime gate), and
`pcre2-shim.test.ts`/`runtime.test.ts` carry unused-import/config type
errors in their stories' uncommitted files.

## 8. Review bounce response #2 (major: citation accuracy [criterion 0])

Every MangaPlus.lua line citation was re-verified against the real file
(`grep -n` against `FMD2/lua/modules/MangaPlus.lua`). The protoc.lua
citations (993, 1143-1145, 1176, 1177-1178, 1183, 1188) and the
MangaPlus.lua:54 (`require 'pb'`) / :123 / :143 / :191 / :99 (`io.open`)
citations were already correct — but four line references had drifted:

- `GetLang(v.language)` usage: cited :131, actual **:129** — fixed in
  pb-shim.ts decode comment, pb-shim.test.ts, evidence §3, and the
  generator's pb note (COMPAT.md regenerated, 912/912 = 100.00%);
- `protoc.proto3_optional = true`: cited :74, actual **:109**;
- `protoc:load(ReadFile(target_file))`: cited :75, actual **:110** —
  both fixed in pb-protoc.integration.test.ts header + test comment and
  evidence §4;
- GetNameAndLink loop: cited :127-133, actual **:126-129** (group loop
  :126, titles loop :127, LINKS.Add :128, NAMES.Add :129) — fixed in
  pb-protoc.integration.test.ts and evidence §4; the sweep-section
  data-file resolution cite :96-99 corrected to **:106-108**
  (curr_path/curr_script/target_file; the :99 in the QUOTED artifact
  string is io.open's error position and stays verbatim).

Corrected sites: pb-shim.ts:11,312 · pb-shim.test.ts:141 ·
pb-protoc.integration.test.ts:25-26,88,168,191 · evidence §3/§4/§5 ·
generate-compat.ts pb note → COMPAT.md:27. Post-fix verification: stale
citation grep = 0 hits across all touched files; contract drift gate +
82/82 test run + lint all green.
