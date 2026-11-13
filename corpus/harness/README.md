# FPC capture harness (D1)

Ground-truth oracle for the FMD-Web corpus: a **Free Pascal console
program** (NO LCL units) that evaluates expressions through the **same
engine FMD2 uses** (InternetTools: `xquery`, `xquery_json`,
`simplehtmltreeparser`) and replicates the `uData.pas:85–207` GetInfo
normalization. It links **internettools + FLRE pinned by commit**
(`vendor/`, pins recorded in `corpus/meta.json`) and bakes the pins into
the emitted triples.

## Build

```sh
make harness            # repo root, or:
bash corpus/harness/build.sh
```

`build.sh` (1) materializes `vendor/` at the pinned commits via
`fetch-vendor.sh`, (2) uses `fpc` from PATH if it reports the pinned
version, otherwise installs the official **FPC 3.2.2** binary tarball into
`$FPC_PREFIX` (default `~/fpc-3.2.2` — no root required), (3) regenerates
`pins.inc` from `corpus/meta.json`, (4) compiles with `-FcUTF8` and runs
the selftest gate. Build outputs live in `bin/` (gitignored).

- **Required toolchain:** FPC 3.2.2, x86_64-linux (see
  `corpus/meta.json → pins.fpc` for the tarball URL).
- **Vendored deps:** internettools
  `2724779c4287547137141ec9ec2a6df0af0f82af`, FLRE
  `643bac1dbfb90ed658859db747c99ad558efb613` (its `src/` bundles the PUCU
  unit used via `USE_BBFLRE_UNICODE`).
- FMD2 declares the internettools submodule (`3rd/internettools`) without
  a committed gitlink, so the pin is taken from upstream master at fetch
  time and recorded in `corpus/meta.json`.

## Modes

```
bin/fmd_capture expression <fixture.html|fixture.json> <manifest.json> <out.json>
bin/fmd_capture normalize  <input.json> <out.json>
bin/fmd_capture selftest
```

### expression mode

The manifest selects the fixture id, document kind, and expressions:

```json
{
  "fixtureId": "capture/html-basic-0001",
  "moduleId": "<32-hex>",
  "document": "html",             // html | json | json-iq (default: by extension)
  "expressions": [
    { "id": "genres", "expression": "//div[@class='genres']/a",
      "engine": "xpath",          // xpath | css
      "output": "list" }          // scalar | list | count | all
  ]
}
```

Every evaluation mirrors `mangadownloader/XQueryEngineHTML.pas` exactly:
the tree parser is configured identically (`pmHTML`,
repair missing start/end tags, no trim, no comments/PIs, no encoding
auto-detect) and `Eval` wraps the call in try/except → **empty sequence**
(`resultKind: "empty"` — this is the error-swallow ground truth, §13.1).
Output triples are `(fixtureId, expression, resultKind, result)`:

- `scalar` — `XPathString`: `Eval(...).toString` (empty seq → `empty`/`""`)
- `list` — `EvalStringAll(TStrings)` shape: `Trim(v.toString)` per item
  (empty seq → `empty`/`[]`)
- `count` — `XPathCount`: `Eval(...).Count` (sequence SIZE; so
  `output:"count"` wants a node-set expression, not `count(...)`)
- `all` — `XPathStringAll`: `", "`-join of trimmed non-empty values

Document kinds:

- `html` — tree-parsed as above.
- `json` — **the FMD2 idiom**: JSON responses ride the same tree parser
  and queries unwrap them with `json(*)...`
  (cf. FMD2 `lua/modules/9hentai.lua:22`
  `x.XPathString('json(*).results.image_server')`).
- `json-iq` — alternative in-engine path: the raw JSON is parsed with the
  engine-default options (`TXQJsonParser`, `xquery.pas:8410`) and rides
  the ContextItem evaluation path; property access via `.("key")` postfix
  or `(.).key` chains.

### normalize mode

Input: `{fixtureId?, moduleId?, rawModuleOutput: {...}, flags?: {...}}` →
normalized triple `{fixtureId, input, normalized}`. The pipeline is a
line-faithful port of `uData.pas:85–207` (see `fmdnormalize.pas` for the
statement-by-statement citation): Link fallback from URL, field cleanup
(`CommonStringFilter`/`RemoveStringBreaks`/`FixWhiteSpace`/`Trim`,
`TrimRightChar(',')` on authors/artists/genres, `CleanMultilinedString`
on summary), `'<'/'-'/:` clearing, `'N/A'` title fill, chapter
pad/prune, Trim, **case-insensitive dedup deleting the EARLIER index**
(`SameText`, so the LAST occurrence's link+name survives),
`RemoveHostFromURLsPair`, chapter-name cleanup, the
`OptionRemoveMangaNameFromChapter` prefix strip, `NumChapter := count`.

Flags: `removeHostFromChapterLinks` (default **true**, uData ctor) and
`optionRemoveMangaNameFromChapter` (default **false**, FMDOptions).
Documented deviations: `FillBaseMangaInfo` is a provable no-op for a
fresh capture (empty pre-call snapshot); array-typed fields join with
`', '` (the Lua `table.concat` shape modules actually assign).

Status passes through untouched (`uData.pas:85–207` never rewrites it);
`MangaInfoStatusIfPos` is replicated in `fmdstrings.pas` and unit-tested
for the modules that call it.

## Replicated helpers (uBaseUnit is NOT linked)

`uBaseUnit.pas` pulls LCL units, so `fmdstrings.pas` replicates the pure
helpers **copied-by-semantics**: `TrimLeftChar`/`TrimRightChar`/`TrimChar`,
`TrimStrings`, `StringFilter` + `StringFilterChar`, `HTMLEntitiesFilter` +
`HTMLEntitiesChar` (including FMD2's swapped `&euro;`→`©` / `&copy;`→`€`
rows and the `&ndash;`→ASCII-hyphen row), `CommonStringFilter`,
`CleanString`, `CleanMultilinedString`, `FixWhiteSpace`,
`RemoveStringBreaks`, `CleanURL` (same FPC `RegExpr` call),
`SplitURL`/`RemoveHostFromURL`/`RemoveHostFromURLsPair` (ported from
`httpsendthread.pas:152–271`), and `MangaInfoStatusIfPos`.
`fmdselftest.pas` pins their behavior (96 checks, exit≠0 on failure) —
run automatically by `build.sh`. The replicated tables are additionally
**byte-for-byte verified against the FMD2 originals** row by row (incl.
order) by `python3 tools/verify-tables.py` (or `make verify-tables`;
advisory, not part of the build gate). Both derived units carry the same
license as their FMD2 sources (GPLv2; see the unit headers).

## Corpus fixtures (this directory's runs)

`corpus/fixtures/capture/*` — sample fixtures + recorded triples
(`*.triples.json`, schema-checked by `corpus/scripts/validate-triples.mjs`):

- `html-basic-0001` — 13 expressions (xpath scalar/list/count/all, css,
  missing-target and broken-syntax error-swallow)
- `json-basic-0002` — 13 expressions (FMD2 `json(*)` idiom incl. unicode,
  missing keys, index access)
- `json-iq-0005` — 10 expressions (ContextItem path, own fixture document
  `json-iq-0005.json`; `count(...)` expressions ride `output:"scalar"` so
  triples carry the count VALUE, plus a node-set `output:"count"` pin for
  the `XPathCount` idiom — see the manifest `outputNote`)
- `getinfo-normalization-0003` — seed-pipeline case: pad/prune +
  last-occurrence dedup + host strip + Link fallback + field cleanup
- `getinfo-normalization-0004-prefixstrip` — the
  `optionRemoveMangaNameFromChapter` flag incl. `- ` handling

Seed-fixture alignment: `corpus/fixtures/seed/getinfo-normalization-0001.json`
is synthetic (`synthetic: true`); review corrections (recorded in its
`meta.source`) re-derived `expected.postProcessed` to the faithful uData
form — `uData.pas:127` (`CleanMultilinedString`, MaxLineEnding=1)
collapses `\n\n` → `\n`, and `altTitles`/`authors`/`genres` are single
uData strings (array inputs are `', '`-joined first, e.g.
`'Action,  Drama'`). Every field of that seed now byte-matches the live
harness output for its input and the captured triple
`corpus/fixtures/capture/getinfo-normalization-0003.triples.json`
(same raw field inputs) pins the same values.

## Verification evidence (in_review round, tsk-lofty-poncho-slogs)

Disposition of the prior review findings, each with a reproducible check:

- **fmdstrings.pas filter tables (major):** both `StringFilterChar` (36
  rows) and `HTMLEntitiesChar` (83 rows) are **byte-for-byte identical to
  `FMD2/baseunits/uBaseUnit.pas`, including row order** — `make
  verify-tables` → PASS. Row order matters: the filter loops are
  order-sensitive. The umlaut block the finding pointed at
  (`&auml;` → `C3 A4` et al.) is now also behavior-pinned in
  `fmdselftest.pas` (`entities-auml`, `entities-probe-replace-asymmetry`,
  `entities-mu` — the latter two pin real FMD2 quirks: case-sensitive
  probe + `rfIgnoreCase` replace, and the μ named/numeric row pair).
- **json-iq-0005 provenance:** the manifest's own fixture document
  `json-iq-0005.json` exists and every recorded triple re-captures
  **byte-identical** from it (regenerate + `diff` → identical);
  `fixtureId` is `capture/json-iq-0005` throughout.
- **seed `expected.postProcessed`:** every field byte-matches the
  captured `getinfo-normalization-0003.triples.json` normalized output
  (programmatic field-by-field comparison) and fresh `normalize` runs of
  the same input.
- **header attribution:** every `uBaseUnit.pas`/`httpsendthread.pas`/
  `FMDOptions.pas`/`frmMain.pas` line citation in the unit headers was
  re-checked against the FMD2 checkout (`97c903b`) — all accurate; GPLv2
  provenance stated in both derived units.
- **vendor hygiene:** `build.sh` purges stray `*.ppu`/`*.o`/`*.rsj` from
  `vendor/` before compiling, `fetch-vendor.sh` strips any
  upstream-committed artifacts at fetch, and `make clean` now purges too.
  Verified: a full clean rebuild leaves **0 stray artifacts** in
  `vendor/` (unit output goes to `bin/` via `-FUbin`).

Reproduction (all green at review time, FPC 3.2.2 /
internettools `2724779c` / FLRE `643bac1`):

```sh
make harness                                        # build + 96/96 selftest
python3 corpus/harness/tools/verify-tables.py       # tables byte-identical
node corpus/scripts/validate-triples.mjs            # 5 files, 38 triples OK
# regenerate every triple and diff → all byte-identical to the recorded ones
```
