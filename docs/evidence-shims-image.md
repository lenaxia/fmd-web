# Evidence: fmd.imagepuzzle + fmd.mangafoxwatermark — faithful ports (tsk-tranquil-tanker-supports)

Audit bucket B (most user-visible): `fmd.imagepuzzle` and `fmd.mangafoxwatermark`
were unserved `planned` rows, leaving ~8 sites broken (18Comic, MangaGo,
TonarinoYoungJump family, FanFox, WolfManga, NexusScanlation, Comix,
PhiliaScans; FanFox additionally failed module *registration* with
`fmd.mangafoxwatermark not found`). Both shims are now implemented as
line-by-line ports of the Pascal algorithm, registered in the loader
registry, and covered by pixel-exact goldens.

## 0. Honest deviations (read first)

Two constraints of this workspace shaped the implementation. They are
disclosed here and in the affected artifacts — neither is papered over:

1. **sharp is not installable offline.** The task named "sharp raw-pixel
   ops"; sharp is absent from every node_modules tree in the workspace,
   is not in any package.json, and the npm registry is unreachable
   (offline by DESIGN §13). The ports therefore use the SAME raw-pixel
   interface shape (`{ data, width, height, channels }`) over plain
   Buffers: `png-codec.ts` implements PNG decode/encode on `node:zlib`
   (deterministic, lossless), and `chromium-image-bridge.ts` adds
   JPEG/WebP decode + JPEG encode through a synchronous one-shot
   headless-Chromium helper (Playwright ships in the workspace ROOT
   node_modules; the server carries no playwright dependency and the
   bridge degrades to the Pascal undecodable-stream failure when absent).
   The algorithm layer never touches a codec — swapping in sharp later
   is a bridge replacement, not a port rewrite.
2. **The goldens are synthesized, not network-captured.** "Captured
   real-site descramble goldens" require either the live sites (no
   network) or running FMD2 as the oracle (no FPC/Lazarus toolchain in
   this workspace). Each fixture instead applies the site's EXACT
   documented scramble (the inverse of the module's Matrix contract) to a
   known clean page, and `expected.png` IS that clean page — the
   descramble must reproduce it pixel-for-pixel. This is a stronger
   oracle than a captured FMD2 output for the LOSSLESS paths (a captured
   JPEG→JPEG FMD2 output would carry FPWriteJPEG encoder drift). What the
   synthesized fixtures cannot prove is that each LIVE site's scramble
   matches its module's Matrix direction — for 18Comic (row reversal) and
   TonarinoYoungJump (transpose) the scramble is self-inverse and the
   direction is irrelevant; MangaGo's key-direction assumption is
   documented in its manifest. Provenance per fixture:
   `corpus/fixtures/imagepuzzle/<Site>/manifest.json`.

## 1. fmd.imagepuzzle — port map (LuaImagePuzzle.pas:73-99 + ImagePuzzle.pas)

Surface (`server/src/engine/shims/imagepuzzle-shim.ts`, package preload,
the fmd.crypto/fmd.gzip pattern — the puzzle object must be a Lua table
with LuaClass-style metatables):

| Lua surface | Pascal binding | Port |
|---|---|---|
| `New`/`Create(w,h)` (:73-77, both → `imagepuzzle_create`) | ImagePuzzle.pas:32-44 (Matrix[i]:=i, Flips[i]:=0) | Lua-side seeding in the preload glue |
| `HorBlock`/`VerBlock` read-only (:78-82) | ImagePuzzle.pas:21-22 | `__index` reads only; writes dropped |
| `Matrix[]`/`Flips[]` read-write array props (:83-87) | ImagePuzzle.pas:24-25 | plain Lua child tables (`puzzle.Matrix[i]=v` indexes the child) |
| `Multiply` read-write integer (:99, `luaClassAddIntegerProperty`) | ImagePuzzle.pas:23 | `__newindex` with `math.tointeger` |
| `DeScramble(src,dst)` (:88-91) | ImagePuzzle.pas:136-305 | `imagepuzzle-core.ts descrambleBytes` |

Algorithm (`server/src/engine/shims/imagepuzzle-core.ts`) — every
operation cites its Pascal line in-code:

- null-stream guard → silent no-op :159-162 (shim: unresolvable facade
  argument = not a stream → return without logging)
- `Matrix is not set` / `Invalid matrix size` :163-172 (exact messages)
- input snapshot BEFORE any output write :180 — this is what makes the
  in-place same-Document call safe (MangaGo.lua:264)
- WebP probe (RIFF/WEBP magic) :183-199; `invalid webp size` :190-194
- TPicture decode; PNG graphic ⇒ ext='png' else 'jpg' :203-208; `could
  not decode image` :209-213
- dstIntf prefill 0xFF :230-234 (remainder band = opaque white — tested)
- `Multiply<=1`: `width div HorBlock` :236-239; `Multiply>1`:
  `Trunc(width div (HorBlock*Multiply))*Multiply` :241-245
- per-tile loop :246-291: Matrix[i] range fail `Matrix[%d]=%d out of
  range` :248-252; dest row/col := Matrix[i] div/mod HorBlock :253-254;
  dx1/dy1/dx2/dy2 := Trunc(col*blockWidth)… :255-258; src row/col :=
  i div/mod HorBlock :259-262; skip degenerate tiles :263-268; flags :=
  GetFlip(i) with out-of-range→0 (:46-56) :269; bit 2 = vertical source
  flip :270-276; bit 1 = horizontal per-pixel mirror :279-284; else row
  Move of tileWidth*4 :287-288
- output rewrite + encode with ext :294-296
- LogAndFail :151-156 — failure logs `TImagePuzzle.DeScramble: <reason>`
  (exact prefix) through the module-correlated host logger and EMPTIES
  the output stream (in-place ⇒ the document ends up cleared; tested)

GDI+ expressibility: TLazIntfImage[riqfRGB,riqfAlpha] is a flat 32-bit
pixel buffer; FillChar 255, `div`, and `Trunc` are exact JS ops. The
Pascal algorithm has NO GDI+-dependent semantics, so the anti-papering
stop condition does not apply — the port is algorithm-exact, and the
only replaceable layer (codec I/O) is injected as `ImageDecoderBridge`.

## 2. fmd.mangafoxwatermark — port map (LuaMangaFox.pas + MangaFoxWatermark.pas)

Surface (`server/src/engine/shims/mangafoxwatermark-shim.ts`, host-lib):
`LoadTemplate(ADirectory)` → Integer (LuaMangaFox.pas:16-21) and
`RemoveWatermark(AFileName, ASaveAsPNG=false)` → Boolean (:23-31, the
2nd argument optional per `lua_gettop(L)=2`). State is a MODULE-LEVEL
singleton matching MangaFoxWatermark.pas:134-136's unit-level
`WatermarkRemover` var — FanFox.lua loads templates during Init (in the
discarded Init-pass Lua state) and removes watermarks during
OnAfterImageSaved (event states) through the SAME remover.

Algorithm (`server/src/engine/shims/mangafoxwatermark-core.ts`):

- OtsuThresholding :139-181 — histogram, meanTotal, cumulative moments,
  between-class variance, `>` keeps the FIRST maximum; every accumulator
  rounds through `Math.fround` to mirror Pascal `Single` precision
- BuildImageToOneBit :185-252 — crop bounds fixups :190-196, gray via
  `CalculateGray(...) shr 8` :214 (FCL fpimage.pp formula
  `(r*77+g*151+b*28) shr 8` on ×257-expanded channels — cited from the
  FCL source; the workspace cannot vendor FPC sources offline, flagged
  here), binarize :177-181
- LoadTemplate :297-330 — dir remember :300-302, CleanAndExpandDirectory
  + DirectoryExists :303-305, non-recursive `*.*` scan :309 (sorted —
  FMD2's order is the filesystem's; first-max-PSNR ties are otherwise
  nondeterministic), per-file decode :310-319
- RemoveWatermark :391-487 — empty-templates/lazy-load :395-401
  (FCleared=False ⇒ immediate false); extension writer map :403-404;
  centered crop origin :426-430; white-border validity (first
  MinWhiteBorder*w bytes) :437-452; PSNR over DIFFERING bytes :384-402
  (Single precision, RMS<0.0001 ⇒ 1e6); first-max tracking :453-461;
  `BestValue >= MinPSNR` (9.0) :465; crop H-Th :467-471; SaveAsPNG
  writer override :472-474; `ExtractFileNameWithoutExt + '.' + WExt`,
  delete-then-write, `Result := FileExists` :476-493
- defaults MinPSNR=9.0 / MinWhiteBorder=4 (Create :285-291)

Path layer: FanFox.lua:36 passes
`fmd.LuaDirectory .. 'extras\\mangafoxtemplate'` — a WINDOWS backslash
path. `translateTemplatePath` (unit-tested) normalizes it at the path
layer; `fmd.env.LuaDirectory` now carries the trailing delimiter
(FMDOptions.pas:297 `LUA_REPO_FOLDER := FMD_DIRECTORY + 'lua' +
PathDelim` — LuaFMD.pas:24 binds it), so the concatenation resolves to
`<luaRoot>/extras/mangafoxtemplate`.

Assets: the REAL FMD2 template PNGs (10 files, palette PNGs — verified
IHDR colortype 3) are shipped in the synced-tree layout at
`corpus/fixtures/lua/extras/mangafoxtemplate/` (copied from the pinned
checkout, sync SHA 97c903b340d2b0fd82871dba1b0aa5f04a1790e8 — the module
sync ships the same `lua/` subtree into `<dataDir>/lua/extras/`). No
asset is embedded in code.

## 3. Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| imagepuzzle pixel-identical vs ≥3 captured real-site descramble goldens, incl. one non-square grid and one in-place same-Document call | `server/test/engine/shims/imagepuzzle-shim.test.ts` "imagepuzzle goldens": MangaGo (4×4 key permutation), 18Comic (1×6 NON-SQUARE), TonarinoYoungJump (4×4×8 transpose, the :241-245 Multiply path) — `got.data.equals(expected.data)` on decoded RGBA (0-LSB). IN-PLACE: the same suite drives the REAL Lua snippet shapes (MangaGo.lua:250-264, 18Comic.lua:99-106, TonarinoYoungJump.lua:93-99) through wasmoon + installShims with `DeScramble(HTTP.Document, HTTP.Document)` — output re-read from the same document, pixel-identical. Fixture provenance (synthesized, disclosed — see §0.2): corpus/fixtures/imagepuzzle/*/manifest.json | met (with the §0.2 capture caveat) |
| Algorithm port cites LuaImagePuzzle.pas line semantics per operation | imagepuzzle-core.ts module doc (operation ↔ line table) + inline citations per branch; LuaImagePuzzle.pas:73-99 surface map in imagepuzzle-shim.ts; mangafoxwatermark-core.ts cites MangaFoxWatermark.pas per operation | met |
| mangafoxwatermark: real FanFox.lua flow runs end-to-end offline against captured sample; PNG assets shipped from lua/extras; backslash-path translation unit-tested | mangafoxwatermark-shim.test.ts "the REAL FanFox.lua flow": loadRealModuleFile runs the REAL Init() (registers FanFox — the audit's registration failure is gone — and executes the real `LoadTemplate(fmd.LuaDirectory .. 'extras\\mangafoxtemplate')` through the backslash path, loading 10 REAL templates), then the event state binds MODULE (FanFox's option defaults), sets FILENAME (LuaWebsiteModules.pas:402) and calls the REAL AfterImageSaved() → the golden watermarked sample (corpus/fixtures/imagepuzzle/FanFox/watermarked.png, bottom band = REAL asset 728-01.png) cleans to expected.png rows pixel-identically. Assets shipped (§2). translateTemplatePath unit-tested | met (with the §0.2 sample-synthesis caveat) |
| Capability flags for all affected sites flip to supported; COMPAT.md + contract.json statuses updated; status gate green | `capabilities.ts` detects `requires_imagepuzzle` (7 sites) / `requires_mangafoxwatermark` (FanFox) — informational, and these sites carry NO known-broken flag (published via /api/modules, schemas.ts updated). contract.json requireShims rows → `implemented` with real implementation notes (facade-notes row too). COMPAT.md LuaImagePuzzle.pas / LuaMangaFox.pas rows → implemented (regenerated by `corpus/scripts/generate-compat.ts --gate`, corpus gate 912/912 = 100%). `scripts/contract-drift-check.ts` → 0 mismatches (statuses derived from REQUIRE_SHIM_REGISTRY, both rows flipped there). require-registry.test runtime agreement: both rows resolve through a real wasmoon require | met |

## 4. Test inventory (all offline)

- `server/test/engine/shims/imagepuzzle-shim.test.ts` (17): core
  semantics (identity, remainder-band white, both flip bits, Multiply
  geometry, exact validation messages, undecodable paths, GetFlip
  bounds), 3 pixel-identical goldens, 5 Lua-surface tests (require,
  in-place MangaGo/18Comic/Tonarino, read-only props, LogAndFail +
  silent Assigned guard).
- `server/test/engine/shims/mangafoxwatermark-shim.test.ts` (10): path
  translation, LuaDirectory delimiter, writer map, 10-asset inventory,
  backslash LoadTemplate = 10, pixel-identical cleanup golden, no-match
  leaves the file untouched, unknown-ext + empty-tree failures,
  chromium-gated JPEG SaveAsPNG writer override, real FanFox.lua
  Init+AfterImageSaved end-to-end.
- Regression: require-registry (7), capabilities (10), sweep (11 — the
  full 417-file tree; FanFox now registers), corpus gate (912/912),
  contract drift check (0 mismatches).

## 5. Known boundaries (documented, non-blocking)

- 16-bit PNGs decode to their high byte (Pascal keeps the full word) —
  no fixture/asset uses 16-bit; Adam7-interlaced PNGs fail loud.
- JPEG output is a re-encode through Chromium at FCL's default quality
  75 — the encoder differs from FPWriteJPEG, so JPEG output is never
  golden-compared (the pixel-exact claims are scoped to the lossless
  PNG/WebP→PNG paths).
- The white-border/PSNR matcher and Otsu are Single-exact via fround;
  the FCL `CalculateGray` weights (77/151/28) are cited from knowledge
  of fpimage.pp (FPC sources not vendored offline) — a ±1 gray
  divergence would only matter at the Otsu threshold on borderline
  pixels, and the shipped goldens are constructed so the matcher hits
  1e6 exactly.
- `tsc -b` (full monorepo, strict) → 0 errors, exit 0. Review round 1
  caught the first draft of this section claiming only a pre-existing
  sidecar-test error while the real build blockers were 5 TS2739 errors
  caused by THIS task's new required capabilities fields: four web
  capability object literals (`web/e2e/fixtures.ts:52`,
  `web/test/capability-badges.test.tsx:26` + `:68`,
  `web/test/fixtures.ts:22`, `web/test/proxy-settings.test.tsx:108`)
  lacked `requires_imagepuzzle` / `requires_mangafoxwatermark`
  (capabilities.ts:49-51). Fixed: both fields added to all four
  literals (false — none of the fixtures models an imagepuzzle/
  mangafoxwatermark-flagged module); `npx tsc -b` re-run to exit 0 and
  the affected suites re-verified green (capability-badges +
  proxy-settings 8/8, lint clean).
