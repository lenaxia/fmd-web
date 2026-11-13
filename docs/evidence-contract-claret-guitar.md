# Contract story evidence — tsk-claret-guitar-loses (review stage)

Date: 2026-11-13T00:44Z · Reviewer session: daring-vocalist-pricks (claim persona
4d1d37df-9338-4bd2-8ee6-79edd5471807) · Implementer: crystal-javelin-prosper

Deliverable reviewed: `fmd-web/contract/` (`contract.json`,
`schema/contract.schema.json`, `types.ts`, `tools/extract.ts`,
`tools/drift-check.ts`, `tools/validate-contract.ts`, 4 test files).

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| contract.json validates against contract.schema.json; all 15 event rows equal the extractor's output on the real `/workspace/FMD2` source | `contract.test.ts` validates the shipped document with Ajv2020 (`allErrors`, strict schema: exactly 15 events, 9 facades, `dedup` const-pinned to `last-occurrence-wins`) → 13/13 pass. `extractor.test.ts` integration block parses the real dispatchers (15 `Do*` + `DoInit` reported as non-dispatcher) and asserts equality with the DESIGN.md §5.2 table AND every shipped contract.json row → 33/33 pass. `npm run contract:check` (build + `drift-check.ts` fresh parse) → exit 0, `0 mismatches`. Reviewer independently spot-checked real sources: `LuaWebsiteModules.pas:190-449` dispatcher bodies (LoadObject/NetStatus/IntegerGlobal/StringGlobal/getglobal-read-back vocabulary) and `LuaXQuery.pas:192-201` method table match contract.json verbatim | met |
| `npm run contract:check` exits 0 on shipped contract.json and ≠0 on mutation (test proves it) | Exit 0 observed (below). `drift-check.test.ts` (15 tests): mutates a temp contract copy (globals / return kind / constants / readBack / dropped row / fabricated row / facade method / facade property / missing MODULE / fabricated ACCOUNT / unbound read-back) → every mutation yields exit 1 with a pinpoint message; exit 2 paths (missing contract, missing lua dir, unrecognized Pascal pattern with `file:line`). Reviewer's independent CLI proof on a mutated GetInfo row → exit 1 (below) | met |
| Extractor unit tests cover every vocabulary call and the unrecognized-pattern loud failure | `extractor.test.ts` "vocabulary coverage" describe: fixtures for `L.LoadObject`, `luaPushIntegerGlobal`, `luaPushStringGlobal`, `LuaPushNetStatus`, `LuaPushAccountStatus`, `lua_getglobal` read-back idiom (guard + integer assignment), and return reads `lua_tointeger`/`lua_toboolean`/`luaToString`; binding order and non-dispatcher `Do*` reporting covered. "loud failures" describe: unrecognized statement with file:line, CallFunction/name mismatch, no CallFunction, no return read, double return read, bare integer assignment outside read-back, duplicate global, both constant tables, invalid global name, missing column-0 `end;`. Facade fixtures: `luaL_Reg`/`lual_Reg_prop` tables, bound-count mismatch, unrecognized entry, Storage AddMetaTable statements, Crypto table concatenation | met |
| contract/types.ts compiles strict, exports interfaces for every facade/event/module surface; zero `any` | `tsc -b` passes under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`. Exports: `EventBinding`, `EventReturnKind`, `ConstantBinding`, `NetStatusCode`, `StatusConstants`, `FacadeTable`/`FacadeMethod`/`FacadeProperty`/`FacadeHeaderSet`/`FacadeAccess`/`PropertyAccess`, `ContractDocument` (+ meta, pipeline, task fields, require shims, capabilities), plus shared domain types (jobs/lanes/health/routes). Zero `any` (grep clean; `@typescript-eslint/no-explicit-any` enforced by `toolchain.test.ts`) | met |

## Gate outputs

### npm run contract:check (shipped contract.json)
```
contract drift-check: OK — 0 mismatches (events + TXQuery/Storage/ImagePuzzle/Duktape/Crypto facades vs FMD2/baseunits/lua)
```

### Independent CLI mutation proof (reviewer)
Mutated `events[GetInfo].globals` in a temp copy →
```
exit code on mutated row: 1
contract drift: events[GetInfo].globals: contract=[MODULE, MANGAINFO, URL] extractor=[MODULE, MANGAINFO, HTTP, URL]
```

### vitest contract suite
```
 ✓ contract/test/toolchain.test.ts (11 tests)
 ✓ contract/test/contract.test.ts (13 tests)
 ✓ contract/test/drift-check.test.ts (15 tests)
 ✓ contract/test/extractor.test.ts (33 tests)
 Test Files  4 passed (4) — 72 passed (72)
```

### Full repo gate (post-review state)
```
npm run typecheck → tsc -b (exit 0)
npm run lint      → eslint . (exit 0)
npm test          → 7 files, 90 tests, all passed (contract 72, server 15, corpus 2, web 1)
```

## Reviewer notes (non-blocking follow-ups)

1. **Schema path**: the task sketch named `contract/contract.schema.json`; shipped as
   `contract/schema/contract.schema.json`, consistently referenced by
   `contract.json.$schema`, package `exports`, and tests. Consistent everywhere; no action.
2. **Account-exists-only-if-AccountSupport rule not yet in the data**: contract.json
   encodes "no `ACCOUNT` global — the account is reached only as `MODULE.Account`"
   (invariants[0]) and lists `AccountSupport`, but the conditional-existence rule
   (`LuaWebsiteModules.pas:1035-1036`) and the `Account{Enabled, Username, Password,
   Status, Cookies}` sub-surface are not encoded. `moduleSurface` is deliberately a flat
   name list, so adding it needs a small schema shape decision. Recommend encoding both
   in the story that generates the MODULE facade bindings (before any account-capable
   module can run), so the generator cannot ship a facade that exposes `MODULE.Account`
   unconditionally.
3. **Extractor scope**: five facade registration tables are machine-verified (TXQuery,
   Storage, ImagePuzzle, Duktape, Crypto — exactly the five the task names);
   IXQValue/TStrings/MangaInfo/HTTP surfaces remain contract data (their §5.4-§5.6
   semantics are behavioral, not table-extractable) — matches the task split.
