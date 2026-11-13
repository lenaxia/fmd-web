# Evidence — tsk-lofty-poncho-slogs (FPC ground-truth capture harness, review round 2)

Date: 2026-11-13T02:40Z · Environment: FPC 3.2.2 (`~/fpc-3.2.2`, official
x86_64-linux tarball), linux · internettools `2724779c4287547137141ec9ec2a6df0af0f82af`
· FLRE `643bac1dbfb90ed658859db747c99ad558efb613`

## Scope

`corpus/harness/` (fmd_capture.pas, fmdstrings.pas, fmdnormalize.pas,
fmdselftest.pas, build.sh, fetch-vendor.sh, Makefile, vendor/),
`corpus/fixtures/capture/*`, `corpus/fixtures/seed/getinfo-normalization-0001.json`,
`corpus/meta.json`.

## Review round 1 (profane-pamphlet-reviews) findings → resolution

| Finding | Resolution |
|---|---|
| **major** fmdstrings.pas:168 — `&ndash;` mapped to U+2013 en-dash; FMD2 uBaseUnit.pas:183 maps to ASCII `-` | `('&ndash;', '-')` restored (fmdstrings.pas:177); selftest pin added (`entities-ndash-ascii`, fmdselftest.pas:180) and the full chapter-name chain pin (`common-ndash-chain` → `'Ch. 5 - End'`). Both tables (StringFilterChar 36 rows, HTMLEntitiesChar 83 rows) re-verified **byte-identical** against `FMD2/baseunits/uBaseUnit.pas` by an independent byte-level extractor. No checked-in fixture or triple contains `&ndash;`/U+2013 (grep-verified), so no capture regeneration was required by this defect. |
| **minor** json-iq-0005 — manifest/triples without fixture document (triples captured from json-basic-0002.json) | Dedicated fixture document shipped (`json-iq-0005.json`); manifest names it (`fixtureDocument`) with a `documentNote`; triples re-captured **from the new document** (triple header `fixture: corpus/fixtures/capture/json-iq-0005.json`), byte-reproducible. |
| **minor** seed getinfo-normalization-0001.json expected.postProcessed | `expected.postProcessed` re-derived to the faithful uData form: summary `\n\n`→`\n` (CleanMultilinedString, uData.pas:127) and altTitles/authors/genres as single uData strings (array inputs `', '`-joined first — `ExampleMan  ,` / `Author One , author one` / `Action,  Drama`). **Live harness run over the seed's exact input matches all 8 expected fields**; corrections recorded in `meta.source` and a new `pipelineNotes.fieldShape` entry. Smoke test (which asserts `chapterLinks` + `numChapter`) still green. |
| **minor** fmdstrings.pas:23 header attribution | Header fixed: RemoveHostFromURL attributed to `uBaseUnit.pas:969` (was misattributed to httpsendthread.pas:969), SplitURL cited as httpsendthread.pas:152 (impl :191, poschar :179); also corrected stale line cites TrimChar :2201→:2171 and CleanMultilinedString :1938→:1940 (header + inline comments + selftest citations), all re-verified against the FMD2 tree at `97c903b`. |
| **minor** build.sh vendor tree artifact hygiene | build.sh purges stray `*.ppu/*.o/*.rsj` from `vendor/` before compiling and directs all unit output to `bin/` (`-obin/fmd_capture -FUbin`, build.sh:66-77). Post-build vendor tree contains **0 artifacts** (verified). |

## Additional fix this round

`json-iq-0005` manifest: the two `count(...)` expressions rode
`output:"count"`, which maps FMD2's `XPathCount` (`Eval(...).Count` — the
sequence SIZE), so the triples recorded the count-of-count artifact (`1`)
instead of the count value — exactly the misuse documented in
`harness/README.md:70-71`. Fixed: `chapter-count` and `members-of-object`
now emit `scalar` (genuine values `"3"` and `"0"` — the latter pins
`jn:members` on an object erroring → swallowed → 0), a new
`chapter-count-nodeset` expression pins the node-set `XPathCount` idiom
(integer `3`), and the manifest documents the semantics in `outputNote`.
Triples re-captured from the pinned binary with repo-root provenance
matching the sibling files.

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Harness builds with the pinned toolchain and runs both modes on ≥3 sample fixtures producing schema-valid triples JSON | `make harness` (repo root) from a clean `bin/`: fetch-vendor verifies pins → FPC 3.2.2 → pins.inc regenerated → compile → **selftest gate: 90 checks, 0 failures**. Both modes run on 5 fixtures → 5 triple files, `validate-triples.mjs`: **38 triples, 0 failures**. All 5 checked-in triple files **reproduce byte-identically** from a fresh rebuild (`expression` ×3, `normalize` ×2, `diff -q`). No build blocker → no COMPAT.md entry needed. | met |
| corpus/meta.json records internettools + FLRE commit pins and fpc version | `pins.internettools.commit` `2724779c…` (+subject, vendoredAt), `pins.flre.commit` `643bac1d…` (+subject, PUCU note), `pins.fpc.version` `3.2.2` (+arch/tarball/installPrefix); `fmd2` block records the semantics source commit `97c903b`. Pins are baked into the binary via `pins.inc` and echoed in every emitted triple (`internettoolsCommit`/`flreCommit`/`fpcVersion`). | met |
| Normalization mode demonstrably reproduces uData.pas ordering incl. last-occurrence dedup and the manga-name-prefix-strip flag (self-test fixtures included) | `fmdnormalize.pas` is a statement-by-statement port of uData.pas:85–207 (cited inline). Selftests: `norm-dedup` (`SameText` dedup deletes the EARLIER index — last occurrence's link+name survives, incl. the seed's `SITE` case and a triple-duplicate), `norm-prefix-strip` (flag off untouched) / `norm-prefix-strip-on` (`- ` handling, `Length(s2) > j` guard), pad/prune, Link fallback, host-strip pair deletion, NumChapter. Fixtures: `getinfo-normalization-0003` (dedup + fallback) and `-0004-prefixstrip` (flag) captured triples reproduce byte-identically; seed replay matches 8/8 fields. | met |

## Reproduction commands

```sh
make harness                                   # clean build + selftest gate (90 checks)
B=corpus/harness/bin/fmd_capture; F=corpus/fixtures/capture
$B expression $F/html-basic-0001.html  $F/html-basic-0001.manifest.json  /tmp/h.json && diff -q /tmp/h.json $F/html-basic-0001.triples.json
$B expression $F/json-basic-0002.json  $F/json-basic-0002.manifest.json  /tmp/j.json && diff -q /tmp/j.json $F/json-basic-0002.triples.json
$B expression $F/json-iq-0005.json     $F/json-iq-0005.manifest.json     /tmp/iq.json && diff -q /tmp/iq.json $F/json-iq-0005.triples.json
$B normalize  $F/getinfo-normalization-0003.json /tmp/n3.json && diff -q /tmp/n3.json $F/getinfo-normalization-0003.triples.json
$B normalize  $F/getinfo-normalization-0004-prefixstrip.json /tmp/n4.json && diff -q /tmp/n4.json $F/getinfo-normalization-0004-prefixstrip.triples.json
node corpus/scripts/validate-triples.mjs corpus/fixtures/capture/*.triples.json
npx vitest run corpus/test/smoke.test.ts
find corpus/harness/vendor -name '*.ppu' -o -name '*.o' -o -name '*.rsj'   # expect none
```

## Review round 3 (independent re-verification, 2026-11-13T04:00Z)

Every round-2 resolution re-verified from scratch against the FMD2 tree @
`97c903b` (remote: `https://github.com/dazedcat19/FMD2.git`):

- **Header cites**: all 20+ provenance line-cites in `fmdstrings.pas` /
  `fmdnormalize.pas` re-checked against the originals (TrimChar :2171,
  TrimLeftChar :2177, TrimRightChar :2193, TrimStrings :1396,
  StringFilterChar :62, HTMLEntitiesChar :101, StringFilter :2056,
  HTMLEntitiesFilter :2088, CommonStringFilter :2119, RemoveStringBreaks
  :2153, FixWhiteSpace :1913, CleanString :1928, CleanMultilinedString
  :1940, CleanURL :1964, StringOfString :1507, status constants :230-233,
  MangaInfoStatusIfPos :2793, SplitURL httpsendthread.pas:152/:179/:191,
  RemoveHostFromURL uBaseUnit.pas:969, RemoveHostFromURLsPair :983,
  OptionRemoveMangaNameFromChapter FMDOptions.pas:168, GetInfoFromURL
  uData.pas:85-207 — Link fallback :111-113, summary collapse :127, dedup
  :154-173, host-strip :175-179, NumChapter :205). One residual attribution
  wart found and fixed this round: both unit headers still cited the stale
  repo URL `rombinary/fmd2`; corrected to the canonical
  `dazedcat19/FMD2` (comment-only change).
- **Tables**: `tools/verify-tables.py` → StringFilterChar 36 rows and
  HTMLEntitiesChar 83 rows IDENTICAL byte-for-byte, in order. The
  `&euro;`→`©` / `&copy;`→`€` swap (uBaseUnit.pas:89-90) and the
  `&ndash;`→ASCII `-` mapping (uBaseUnit.pas:183) confirmed present in the
  replication — the round-1 major defect stays fixed.
- **Build + gate**: `make harness` from clean → FPC 3.2.2, pins verified,
  **selftest 96 checks, 0 failures** (selftests now also pin
  `entities-auml` U+00E4 = C3 A4 — the fmdstrings.pas:168 row — and the
  `&Uuml;`/`&uuml;` probe/replace asymmetry).
- **Determinism**: all 5 triple files re-captured from the fresh binary →
  **byte-identical** (`diff -q`, expression ×3 incl. json-iq-0005 from its
  own document, normalize ×2).
- **Seed replay**: seed `getinfo-normalization-0001` rawModuleOutput run
  through `fmd_capture normalize` → all 8 declared `expected.postProcessed`
  fields match (title `Example Manga`, altTitles `ExampleMan  ,`, authors
  `Author One , author one`, genres `Action,  Drama`, summary `\n`-collapsed,
  chapterLinks `[/manga/x/ch-1, /manga/x/ch-2]`, chapterNames
  `[Chapter 1, chapter 2]` — the LAST duplicate's name survives, numChapter
  2). The harness additionally emits artists/status/coverLink/url/link —
  fields the seed's expected block does not declare; all correct passthrough.
- **Criterion 3 demonstration**: dedup order pinned three ways — the seed's
  `SITE` case (captured 0003 triple: `chapter 2` at index 2 survives with
  its own link), a triple-duplicate (`[/a,/A,/a]` → `/a`), and interleaved
  pairs (`[/x,/y,/X,/Y]` → `/X|/Y` with names `x2|y2`, untouched entries
  never move); prefix-strip flag pinned both off (`norm-prefix-strip`) and
  on (captured 0004 triple: `ExampleMan Ch. 5` → `Ch. 5`,
  `ExampleMan- Ch. 6` → `Ch. 6`, `NotExampleMan`/short-name guarded).
- **Schema + hygiene**: `validate-triples.mjs` 5 files / 38 triples /
  0 failures; smoke test 2/2 green; vendor tree contains 0 build artifacts.
