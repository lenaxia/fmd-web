# Phase-0 scaffold evidence — tsk-pristine-rodeo-shines

Date: 2026-11-13T00:13Z · Environment: node v24.20.0, npm 11.19.0, linux

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| \`npm test\`, \`npm run lint\`, \`npm run typecheck\` exit 0 at repo root | outputs below (all exit 0) | met |
| tsconfig strict flags enforced + proved by type-error fixture | tsconfig.base.json sets strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes/noImplicitOverride/verbatimModuleSyntax; \`contract/test/toolchain.test.ts\` runs tsc on \`contract/tools/fixture-tests/tsconfig-strict-fixture\` → non-zero exit with TS1484 (verbatim), TS2532 (noUncheckedIndexedAccess), TS7006 (strict), TS4114 (noImplicitOverride), TS2412 (exactOptionalPropertyTypes); clean control compiles exit 0 | met |
| eslint flags any + missing explicit return types on exports | \`@typescript-eslint/no-explicit-any: error\` + \`@typescript-eslint/explicit-module-boundary-types: error\` in eslint.config.js (shared \`boundaryRules\`); toolchain test lints \`lint-violations.ts\` via the ESLint API → both rules reported; \`lint-clean.ts\` → 0 errors | met |
| Dockerfile builds non-root image; compose validates | docker CLI unavailable in this environment (offline sandbox), so structural proofs run in \`toolchain.test.ts\`: 2-stage FROM, final-stage \`USER node\` (non-root), HEALTHCHECK present, digest/exact-pin form; compose.yml parses (yaml) with exactly the \`app\` service active and the \`browser\` profile commented. Built server artifact smoke-tested locally: \`PORT=4123 node server/dist/src/main.js\` → /healthz 200 {status:ok}, /readyz 200, unknown route 404 | met (structural; real image build = CI/Docker host) |
| README documents layout, commands, offline-test policy | README.md (layout tree, commands, non-negotiables table, offline policy, docker notes) | met |

## Gate outputs

### npm test (vitest)
```
 ✓ contract/test/toolchain.test.ts (11 tests) 959ms
   ✓ eslint boundary rules reject lint fixtures > flags any and missing explicit return types on exports  475ms
 ✓ contract/test/contract.test.ts (13 tests) 100ms
 ✓ server/test/smoke.test.ts (15 tests) 31ms
 ✓ web/test/smoke.test.ts (1 test) 3ms
 ✓ corpus/test/smoke.test.ts (2 tests) 3ms

 Test Files  5 passed (5)
      Tests  42 passed (42)
   Start at  00:13:25
   Duration  2.27s (transform 104ms, setup 0ms, collect 300ms, tests 1.10s, environment 1ms, prepare 261ms)

```

### npm run lint
```

> fmd-web@0.1.0 lint
> eslint .

```

### npm run typecheck
```

> fmd-web@0.1.0 typecheck
> tsc -b tsconfig.json

```

### npm run test:coverage (v8)
```
 Test Files  5 passed (5)
      Tests  42 passed (42)
All files          |   91.72 |    81.03 |     100 |   91.72 |                   
 web/src           |     100 |      100 |     100 |     100 |                   
```
Thresholds enforced: lines 75 / statements 75 / branches 65 / functions 80 (coverage run exits non-zero below them).

## Created layout
```
.
./.gitignore
./DESIGN.md
./Makefile
./README.md
./contract
./contract/contract.json
./contract/package.json
./contract/schema
./contract/schema/contract.schema.json
./contract/test
./contract/test/contract.test.ts
./contract/test/toolchain.test.ts
./contract/tools
./contract/tools/fixture-tests
./contract/tools/fixture-tests/eslint.config.fixture.js
./contract/tools/fixture-tests/lint-clean.ts
./contract/tools/fixture-tests/lint-violations.ts
./contract/tools/fixture-tests/tsconfig-clean-fixture
./contract/tools/fixture-tests/tsconfig-clean-fixture/clean.ts
./contract/tools/fixture-tests/tsconfig-clean-fixture/package.json
./contract/tools/fixture-tests/tsconfig-clean-fixture/tsconfig.json
./contract/tools/fixture-tests/tsconfig-strict-fixture
./contract/tools/fixture-tests/tsconfig-strict-fixture/dep.ts
./contract/tools/fixture-tests/tsconfig-strict-fixture/package.json
./contract/tools/fixture-tests/tsconfig-strict-fixture/tsconfig.json
./contract/tools/fixture-tests/tsconfig-strict-fixture/violations-exact-optional.ts
./contract/tools/fixture-tests/tsconfig-strict-fixture/violations-override.ts
./contract/tools/fixture-tests/tsconfig-strict-fixture/violations.ts
./contract/tools/validate-contract.ts
./contract/tsconfig.json
./contract/types.ts
./corpus
./corpus/fixtures
./corpus/fixtures/README.md
./corpus/fixtures/seed
./corpus/fixtures/seed/getinfo-normalization-0001.json
./corpus/harness
./corpus/harness/README.md
./corpus/harness/fmd_capture.pas
./corpus/package.json
./corpus/runner
./corpus/runner/fixture-loader.ts
./corpus/test
./corpus/test/smoke.test.ts
./corpus/tsconfig.json
./docker
./docker/Dockerfile
./docker/compose.yml
./docs
./docs/COMPAT.md
./docs/REVIEW-001-design-review.md
./docs/REVIEW-002-design-review.md
./docs/REVIEW-003-design-review.md
./docs/REVIEW-004-design-review.md
./docs/runbook.md
./eslint.config.js
./package-lock.json
./package.json
./scripts
./scripts/ci.sh
./server
./server/package.json
./server/src
./server/src/api
./server/src/api/routes.ts
./server/src/db
./server/src/db/schema.ts
./server/src/engine
./server/src/engine/events
./server/src/engine/events/bindings.ts
./server/src/engine/lua
./server/src/engine/lua/worker-pool.ts
./server/src/engine/shims
./server/src/engine/shims/index.ts
./server/src/engine/state
./server/src/engine/state/module-state.ts
./server/src/index.ts
./server/src/jobs
./server/src/jobs/lanes.ts
./server/src/main.ts
./server/src/sync
./server/src/sync/pin.ts
./server/test
./server/test/smoke.test.ts
./server/tsconfig.json
./tsconfig.base.json
./tsconfig.json
./vitest.config.ts
./web
./web/package.json
./web/src
./web/src/index.ts
./web/test
./web/test/smoke.test.ts
./web/tsconfig.json
```
