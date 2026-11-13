# Fixtures

Ground-truth corpus replayed **fully offline** in CI (DESIGN.md §13.1).

```
fixtures/
├── lua/             hand-written fixture .lua modules (harvester unit tests)
├── capture/         FPC-oracle capture batches (fmd_capture expression|normalize)
│   ├── *.html|*.json          recorded documents
│   ├── *.manifest.json        expression manifests fed to the oracle
│   └── *.triples.json         oracle output: expression + normalization truth└── seed/            ≥50 seed modules, one directory per module/template
    └── <Module>/
        ├── source.html|source.json|source.bin   ONE recorded HTTP response
        ├── manifest.json                        {moduleId, module, capturedAt,
        │                                         entries:[{fixtureId, file, kind, url}]}
        ├── oracle-manifest.json                 expressions fed to fmd_capture
        └── triples.json                         oracle truth (resultKind ∈ scalar|list|count|empty)
```

- `seed/` manifests validate against `corpus/runner/corpus-loader.ts`
  (`loadSeedManifest`); `kind: 'protobuf' | 'text'` entries are
  provenance fixtures (e.g. MangaPlus `pb.decode` payloads) that are
  recorded but not handed to the QueryEngine.
- Template fixtures (e.g. `seed/Madara`) have no real `m.ID`; their
  `moduleId` is `md5("fmd-template:<name>")` and flagged
  `syntheticId: true`. Stub modules record `expressionSource: 'templates'`
  when their query surface lives in the required template.
- Every triples file records the pinned `internettoolsCommit` (dialect
  behavior varies by version — §13.1). `resultKind: 'empty'` is FMD2's
  swallow semantics (engine error OR genuinely empty sequence).
- Capture provenance: live sites were fetched ONCE by
  `corpus/scripts/capture-seeds.ts` (direct curl; TLS-fingerprinted CDNs
  through the jina reader for raw HTML; one web.archive.org raw snapshot
  for 18Comic, whose live site is hard-blocked). After capture nothing
  in this tree touches the network — the zero-network vitest guard
  (`corpus/test/setup/no-network.ts`) enforces that.

Required coverage for the seed set: plain XPath, `json(...)` node-tree
forms (both `.prop` and `?prop` styles), list-fill overloads, `css()`,
error-swallowing cases, and GetInfo normalization pipelines
(raw module output → post-processed result, §5.8).

Regenerate the golden report after an INTENTIONAL report-shape change:

```
npx tsx corpus/scripts/generate-golden.ts
```

### Normalization capture batches (§5.8)

`getinfo-normalization-*.json` / `*.triples.json` are `fmd_capture normalize`
batches: each input file carries `rawModuleOutput` (raw module MANGAINFO,
§5.1 shape) plus optional `flags` (`removeHostFromChapterLinks` default true,
`optionRemoveMangaNameFromChapter` default false); each triples file carries
the FPC-oracle `normalized` payload — byte-exact ground truth for the §5.8
post-processing pipeline (`uData.pas:85-207` via `fmdnormalize.pas`).

Coverage by batch:

| batch | pins |
|---|---|
| 0003 | dedup order (SameText, earlier index deleted, LAST survives incl. `SITE` case), Link fallback from URL, CleanURL `//` collapse |
| 0004-prefixstrip | `OptionRemoveMangaNameFromChapter=true` (`Title- Ch` / `Title Ch` strip, length guard) |
| 0006 | StringFilter/HTMLEntitiesFilter tables on title/altTitles/authors/genres/summary incl. broken-entity pass, literal `\n`/`\r` strip |
| 0007/0008/0023 | dedup order: last-wins groups, interleaved duplicates (untouched entries never move), triple-duplicate |
| 0009/0010/0026 | pad with `''` / prune to match ChapterLinks; whitespace-heavy links |
| 0011/0012/0025 | prefix-strip flag on/off, uppercase + unicode title folding, `- ` variant, guard cases |
| 0013 | RemoveHostFromURLsPair deletes entries whose link reduces to `''` from BOTH lists |
| 0014/0029 | chapter-name cleanup chain (CommonStringFilter tables, full-width brackets, `&ndash;`→ASCII `-`, `&frac12;` etc.) |
| 0015 | fix-info sentinels (`<`, `-`, `:` prefixes; empty title → `N/A`) |
| 0016/0017 | FixWhiteSpace NBSP/BOM strip (ZWSP kept), CleanMultilinedString CRLF collapse |
| 0018 | single-string chapterLinks/chapterNames (TStrings Text-splitting) |
| 0019/0020 | null/missing fields, non-string array entries, numeric/bool scalars (fpjson AsJSON) |
| 0021/0022 | host-strip flag off (dedup still runs), CleanURL port + leading `:`/`//` variants |
| 0024/0030 | empty chapter list → NumChapter 0, empty URL → Link `''`, status passthrough |
| 0027/0028 | link fallback from `URL` (path only) vs Link already set |

Regenerate (FPC 3.2.2 + pinned vendor commits — `make harness` first):

```
B=corpus/harness/bin/fmd_capture; F=corpus/fixtures/capture
$B normalize $F/getinfo-normalization-0007.json /tmp/n.json && diff -q /tmp/n.json $F/getinfo-normalization-0007.triples.json
node corpus/scripts/validate-triples.mjs corpus/fixtures/capture/*.triples.json
```

The TypeScript port (`server/src/engine/normalize/`, §5.8) is golden-tested
against every batch: `server/test/engine/normalize/pipeline.golden.test.ts`
asserts `JSON.stringify(normalized)` byte-equality per fixture.
