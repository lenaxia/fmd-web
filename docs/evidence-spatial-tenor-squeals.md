# Evidence — tsk-spatial-tenor-squeals (corpus harvester/loader/runner + seed fixtures)

All four acceptance criteria met; the full CI gate (`bash scripts/ci.sh`)
passes: **17 test files, 188 tests, lint clean, typecheck clean**.

## What was built

| Piece | Files | Notes |
|---|---|---|
| Contract | `contract/types.ts` | Added §13.1 boundary types: `QueryDocumentKind`, `QueryLanguage`, `QueryOutputMode`, `QueryExpression`, `ParsedQueryDocument`, `QueryEngineResult` (FMD2 swallow semantics), `QueryEngine`, `NormalizationEngine` |
| Harvester | `corpus/harvester/harvest.ts` | Lua lexer (code/string/comment regions), the exact 6-method TXQuery surface (LuaXQuery.pas:194-199), decoding of `'…'`/`"…"`/`[[…]]`/`[==[…]==]`/escapes (`\ddd`, `\xXX`, `\u{…}`, `\z`), `..`-concatenation (static vs dynamic with `{…}` placeholders), json()/css() dialect tagging, per-method output modes |
| Loader | `corpus/runner/corpus-loader.ts` | Seed manifest loading/validation (`protobuf`/`text` = provenance-only kinds), harness-triple loading (expression + normalize modes), `buildCorpusCases`/`buildFullCorpus` → replayable `CorpusCase[]` |
| Runner | `corpus/runner/replay.ts`, `mock-engine.ts`, `golden-corpus.ts`, `report.schema.json` | Versioned report (`REPORT_SCHEMA_VERSION = 1`), per-module/per-expression pass-fail with mismatch detail (expected vs actual), deterministic ordering, `MockQueryEngine` + `MockNormalizationEngine` (keyed recordings, deterministic error path), ajv-validated report schema |
| Seed capture | `corpus/scripts/capture-seeds.ts` + 66 fixture dirs | One-time curl of live pages (direct; jina-reader raw-HTML fallback for TLS-fingerprinted CDNs; one `web.archive.org` `id_` raw snapshot for 18Comic — live site hard-blocked), oracle truth computed by the pre-built FPC harness (`corpus/harness/bin/fmd_capture`, internettools `2724779`, FPC 3.2.2) |
| Zero-network guard | `corpus/test/setup/no-network.ts` + `corpus/test/no-network.test.ts` | Global vitest `setupFiles`: patches `net.connect`, `net.createConnection`, `Socket.prototype.connect`, `tls.connect`, http/https `Agent.prototype.createConnection` — any non-loopback attempt **throws** and is recorded; loopback stays allowed (DESIGN §13); guard tests assert the block |
| Golden test | `corpus/test/runner.test.ts` + `test/golden/report-v1.golden.json` | Deep-equal against the committed golden report AND ajv validation against `report.schema.json` (plus a drift-rejection test), `corpus/scripts/generate-golden.ts` regenerates |

## Acceptance criteria — evidence

### [x] Harvester extracts ≥1500 expressions corpus-wide; quoting unit tests

- Corpus-wide: **2620 expressions** across 417 modules (2073) + 41
  templates (547) — `corpus/test/harvester.test.ts` asserts ≥1500 and
  ≥400 modules (DESIGN's ~1947 figure is the analysis bound).
- Quoting edge cases: `corpus/fixtures/lua/EdgeCases.lua` (hand-written
  fixture module) + 13 harvester tests covering single/double quotes,
  escaped quotes, decimal escapes, long brackets at levels 0/2 (including
  the Lua rule that `[[…]]` closes at the first `]]`), multi-line
  expressions, literal vs variable concatenation, commented/string-embedded
  fake calls, node-context second args, json()/css() classification, count
  and list-fill output modes, non-query method rejection, stable ids.

### [x] Runner replays the full corpus offline against MockQueryEngine, deterministically; report matches schema (golden)

- `corpus/test/seed-corpus.test.ts`: builds the **full corpus (887 cases
  = 885 expression + 2 normalization)**, replays via MockQueryEngine +
  MockNormalizationEngine → **byte-identical reports across runs**, 100 %
  pass, ≥50 modules in the report; a mutated recording flips exactly its
  own case to `fail` with a `scalar` mismatch (expected vs actual).
- `corpus/test/runner.test.ts`: golden deep-equal + ajv schema validation
  + schemaVersion drift rejection.

### [x] ≥50 seed modules with fixtures + manifest entries, incl. all 10 named special cases

- **66 seed modules** captured (≥50 required), all with valid manifest +
  oracle triples (`seed-corpus.test.ts` asserts ≥50 and validates every
  manifest/fixture/triples file).
- All 10 named special cases present with real recorded bodies:
  ComicK (JSON API, comick.cc), MangaPlus (protobuf `allV2` — pb.decode
  provenance), Madara template (live Madara site directory), EHentai
  (account/login module, public list page), Tapas (TotalDirectory landing
  page), Hentai2Read (XPathStringAll list-fill + json() page), MangaDex
  (JSON API), 18Comic (imagepuzzle module — archive.org raw snapshot),
  MangaGo (Duktape module, genre directory), AsuraScans (Madara-family).
- Mix: Madara-based, MangaThemesia-based (template + id/es/vi modules),
  gallery sources, raw/Japanese sources, aggregators, JSON APIs — 65
  modules contribute report cases, 885 oracle expression triples
  (799 xpath / 85 json / 1 css).
- Stub modules record `expressionSource: 'templates'` and replay the
  required template's expressions (faithful: that IS their query surface).

### [x] Zero network access in any vitest run

- `vitest.config.ts` adds `setupFiles: ['corpus/test/setup/no-network.ts']`
  for EVERY test file of every workspace.
- `corpus/test/no-network.test.ts` proves the guard: remote `net.connect` /
  `net.createConnection` / `http.request` / `https.request` throw
  `NETWORK ACCESS FORBIDDEN`; loopback classification stays permissive
  (server smoke tests still exercise the loopback-only server); every
  recorded attempt carries `blocked: true`.

## Verification

```
$ bash scripts/ci.sh        # lint + typecheck + vitest run
==> CI gate passed          # 17 files / 188 tests, coverage ≥ thresholds
```

Coverage (v8): all files 84.86 % lines / 78.9 % branches — thresholds
75/65 met; `corpus/runner` 88.95 % lines.

## Notes / decisions

- Report schema v1 keys: `schemaVersion`, `engine`, `normalization`,
  `summary{cases,passed,failed,passRate}`, `modules[]`, `normalizations[]`.
  `passRate` is 4-decimal rounded; module lists are name-sorted — both
  required for byte-stable golden output (no timestamps anywhere).
- Swallow semantics: the oracle merges engine-error and genuinely-empty
  into `resultKind: 'empty'`; the runner accepts either engine error or
  empty result for those cases (XQueryEngineHTML try/except parity).
- Normalization replay is a separate pluggable boundary
  (`NormalizationEngine`) — honest design; the runner refuses
  normalization cases with a loud `no normalization engine supplied`
  error result instead of silently self-comparing.
- capture-seeds URL order fixed (`-o/-w` before positional URL args) —
  first capture run silently fetched nothing because of it; re-run
  verified real bodies (>200 bytes) for every seed.
