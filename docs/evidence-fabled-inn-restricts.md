# Evidence — tsk-fabled-inn-restricts (TXQuery shim §5.6 completion)

Task: bring `server/engine/shims/txquery` to full §5.6 (LuaXQuery.pas,
LuaIXQValue.pas:110-149, XQueryEngineHTML.pas:346-399) — JSON node-tree
dialect, css(), list-fill overloads, ParseHTML, IXQValue facade, error
swallowing, corpus ≥99%.

## Acceptance criteria → evidence

### 1. Corpus runner report: ≥99% result-equality across ≥50-module seed set (report artifact committed)

- **Live replay: 908/912 = 99.56%** — and **100% of the 885 seed EXPRESSION
  cases** (the 4 remaining failures are §5.8 uData normalize gaps owned by
  tsk-feral-lumber-leaves; documented in `docs/COMPAT.md` §Per-expression
  results with root cause + tracking).
- Golden report artifact committed at
  `server/test/engine/golden/seed-corpus-live-report.golden.json`
  (regenerate with `UPDATE_GOLDEN=1 npx vitest run
  server/test/engine/shims/corpus-live.test.ts`).
- Test: `server/test/engine/shims/corpus-live.test.ts` — builds the full
  seed corpus (67 module dirs, offline), replays it through the real
  `FontoXPathQueryEngine`, asserts ≥0.99 pass rate, asserts every failure
  is documented in COMPAT.md, and byte-compares the committed golden.
- Seed set coverage: plain XPath, json() node trees (`.prop` and `?prop`
  styles), list-fill expressions, css(), error-swallowing cases,
  GetInfo normalization pipelines — 67 ≥ 50 modules.

The path to 100% was driven by corpus-proven divergences (each fix
grounded in the pinned InternetTools sources under
`corpus/harness/vendor/internettools`):

| Divergence (linkedom/fontoxpath vs InternetTools) | Ground truth | Fix |
|---|---|---|
| CRLF/CR kept raw | `strDecodeHTMLEntities` `dhefNormalizeLineEndings` folds CR→LF at tokenize time (bbutils.pas:5538) | source-level `\r\n?→\n` before parse |
| Entity references split text runs | `readText` appends to the CURRENT text node (`readText`:2709-2714) | merge adjacent text nodes post-parse |
| Comments/PIs stay in the tree and split whitespace runs | `readComments/readPIs := False` (XQueryEngineHTML.pas:395-396) | drop comment/PI nodes, re-merge |
| Whitespace text after `</body>` kept as html child | bpmAfterBody state skips it (FPC-oracle probe: `//html/text()` empty for the tail region) | `dropTextAfterBody` preprocessing |
| Bare text payloads dropped (JSON bodies, sentences) | repairing parser scaffolds html/head/body (`readText` repair branch) | wrap scaffold when parse yields no elements |
| `//text()` items untrimmed | EVERY node→string conversion is trimmed: `treeElementAsString` + `XQGlobalTrimNodes=true` (xquery.pas:5281-5292) | `pascalTrim` in `fmdItemString` (Pascal trim set `[#0..' ']` — NBSP is NOT whitespace) |
| scalar join of a sequence with ' ' separators | sequence `toString` = `toJoinedString('')` (xquery_types.inc:566) | scalar output = items joined with `''` |
| list/all outputs stringified per-item | oracle mirror: list = `Trim(v.toString)` per item; all = AddSeparatorString ', '-join of trimmed non-empty (fmd_capture.pas:353-380) | `evaluate()` output shapes rewritten |
| `string(`/`string-join(` compute raw fontoxpath string values | InternetTools fn:string/string-join route through `toString` → trimmed | rewritten to registered `fmd:string` / `fmd:string-join` |
| `not()` node-EBV over JSON booleans | `json()` yields BOXED values — `not(is_premium)` sees pvkBoolean | `not(` → `fmd:not(` with JSONiq EBV over typed leaf markers |
| json() parse failure swallowed per-call | EXQEvaluationException propagates OUT of json() → whole Eval aborts to empty (XQueryEngineHTML Eval try/except) | `fmd:json` throws on malformed input; empty input → empty sequence (no error) |
| JSON containers stringify to their text | pvkObject toString raises FOTY0014 (xquery_types.inc:571-575) | map/array containers raise in `fmdItemString` → swallowed empty |
| json(*) over head+body drops the payload | `args[0].toString` of the head/body SEQUENCE joins to the full JSON | `fmd:json` joins ALL argument items |
| chained `arr()()()` member steps | pxp member access per `()` pair | `expandEmptyParenSteps` + multi-pair `expandJsonCallArrayStep` |
| XQuery string literals keep CR | parser default `LineEndingNormalization := xqlenXML1` (xquery.pas:8384) | CR/CRLF → LF inside literals (quote-aware) |

Oracle probes used to pin ambiguous behaviors (compiled FPC harness at
`corpus/harness/bin/fmd_capture`): text-item sequences via
`string-join(//text(), "§")`, post-body whitespace via `//html/text()` +
`//body/text()`, `count(//a)`-style item-count semantics, encoding
handling — see the transcript of this session; probe manifests under
`/tmp/opencode/`.

### 2. JSON node-tree property tests (ordering, array→sequence, .prop/?prop, fn:data mixed content)

`server/test/engine/shims/txquery-json.test.ts` — 10 tests over GENERATED
JSON documents (mulberry32 seeded PRNG, deterministic):

- object key order + array member order survive the tree round-trip
  (25 seeded shapes; per-array member counts and per-leaf paths re-read)
- `.prop` / `?prop` / `.data()` / `?data?*` / `data/*` resolve identically
- array→sequence iteration over nested arrays (chained `()`)
- `fn:data` over mixed leaf content in document order + string-coercion
  fidelity (numbers integer-form, booleans true/false, null → '')
- type coercion: `fmd:not` sees boxed-value EBV (false/0/""/null → false)
  while plain nodes keep standard EBV
- JSON containers stringify as FOTY0014 → swallowed empty; malformed JSON
  aborts the whole expression (InternetTools exception semantics); empty
  json() input → empty sequence without error

### 3. Fill-overload tests prove TStrings mutation (order preserved), all three families

`server/test/engine/shims/txquery-fill.test.ts` — 10 tests driving REAL
Lua through the facade bridge with §5.5 `makeTStrings` facades:

- `XPathStringAll(expr, list)` — fills (Trim per item, ALL items, order
  preserved), appends without clearing existing content
- `XPathStringAll(expr, node, list)` — IXQValue context form
- `XPathStringAll` string forms — ', '-join of trimmed non-empty values
  (AddSeparatorString skip semantics; verified against an empty element)
- `XPathHREFAll(expr, links, texts)` / `(…, node)` — href raw, text
  trimmed, lockstep document order
- `XPathHREFTitleAll(expr, links, titles)` / `(…, node)` — title attribute
  raw (missing → '')
- `ParseHTML(html)` 1-arg instance reparse (document swap verified) and
  `ParseHTML(HTTP.Document)` TStream form through the documents map
- indexing follows Pascal TStrings 0-based `Get(i)` (LuaStrings.pas)

### 4. Error-swallowing test (malformed → empty + deduplicated WARN via log capture)

`server/test/engine/shims/txquery-swallow.test.ts` — 5 tests:

- malformed expression → `ok:false` (never thrown) + exactly one WARN
  record containing the expression; structured record carries `moduleId`
- all four output shapes carry the FMD2 swallow verdict
- dedupe: same expression re-failing stays silent; a different expression
  warns again (per (module, expression) key — SwallowLogger)
- the Lua-driven shim path (`XPathString`/`XPathStringAll`/`XPathCount`)
  returns empty results and dedupes the WARN per run
- bare JSON payload scaffolding preserves queryability (parse hardening)

### 5. ToString inner-text vs OuterHTML distinction (element-text fixtures)

`server/test/engine/shims/ixqvalue.test.ts` (13 tests) added fixtures:

- `ToString` = trimmed deep text (script content included, markup absent)
  vs `OuterHTML` = serialized element starting with the tag — asserted to
  differ on the same node
- `InnerText` = HTML5 inner-text algorithm port (single-space runs,
  `br`→\n, `p`→\n\n, hidden/skip-element drop) vs `ToString` raw deep text
  on the same fixture
- full §5.6 Get()/Get(i)/Count/GetAttribute/GetProperty (JSON node-tree
  children, empty-never-nil) surface — pre-existing tests retained
- NEW: `css('.chapter')` through the engine dialect; `json(*).data()` +
  GetProperty + ToString end-to-end from `CreateTXQuery(<json string>)`

## Implementation summary

- `server/src/engine/shims/txquery-shim.ts` — parse preprocessing
  (CRLF, text merge, comment/PI drop, post-body skip, payload scaffold),
  Pascal string semantics (`pascalTrim`), JSON node-tree adapter with
  typed leaf markers (WeakMap), `fmd:json`/`fmd:parse-json` (join-all +
  throw-on-malformed), `fmd:css`, `fmd:not` (JSONiq EBV),
  `fmd:string`/`fmd:string-join`, FMD2 item stringification, the four
  output shapes, `innerTextOf` (HTML5 inner-text port), SwallowLogger.
- `server/src/engine/shims/query-dialect.ts` — literal CR normalization,
  `not(`/`string(`/`string-join(` rewrites, chained `()` member steps.
- `server/src/engine/shims/txquery-facade.ts` — FMD2 scalar sequence
  join, skip-empty string forms, fill forms with per-item Trim, InnerText
  slot, HREF/title fills.
- `vitest.config.ts` — `@fmd/corpus` source aliases (live replay test
  crosses the server↔corpus package boundary).
- `corpus/scripts/generate-compat.ts` — updated curated gaps: the three
  resolved §5.6 gaps removed; TXQuery binding → done; the bare
  `[json-prop]` predicate EBV gap documented.

## Verification

- `npx vitest run` — **44 files, 500 tests, all passing** (includes the
  concurrent workers' suites).
- `npx eslint` on every touched file — clean.
- `npx tsc -b server/tsconfig.json` — no errors in touched files
  (workspace-wide typecheck blocked only by OTHER tasks' in-flight files:
  duktape-shim, madara e2e — not this task's scope).

## Known gaps (documented in docs/COMPAT.md)

1. Bare `[prop]` predicates over JSON trees keep node EBV (modules use
   `not(prop)`; unexercised by the seed corpus).
2. §5.8 normalize prefix-strip/host-strip flags — tsk-feral-lumber-leaves
   (4 report failures, all normalize-mode).
3. `css()` runs linkedom css-select; exotic selectors degrade to
   swallowed-empty per FMD2 semantics.
