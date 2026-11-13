# fmd-web

A Dockerized, web-based rebuild of **FMD2 (Free Manga Downloader 2)** that
reuses FMD2's Lua site-module ecosystem and the FMD2-DB catalogs
**unchanged** — one ecosystem, one module set, no fork of site adapters.

Authoritative design: [`DESIGN.md`](docs/DESIGN.md) (v5, review-converged —
see `docs/REVIEW-001..004`). This document covers the repository layout,
commands, and the Phase-0 toolchain contract.

## Repository layout (DESIGN.md §11)

```
fmd-web/
├── docker/            Dockerfile (multi-stage, non-root, healthcheck) · compose.yml
│                      (app service only; `browser` profile = commented placeholder)
├── server/            @fmd/server — API server + module engine + jobs + sync + db
│   ├── src/api/       Fastify routes, WS hub + backfill, auth, rate limits   (placeholder)
│   ├── src/engine/
│   │   ├── lua/       worker pool (engine-per-worker), chunk cache, watchdog (placeholder)
│   │   ├── shims/     http · txquery · strings · crypto · duktape · pb · …   (placeholder)
│   │   ├── state/     per-module shared state service (§5.3)                 (placeholder)
│   │   └── events/    binding tables GENERATED from contract/contract.json   (placeholder)
│   ├── src/jobs/      queue lanes, download pipeline, packer, favorites      (placeholder)
│   ├── src/sync/      FMD2 lua/ syncer (SHA pin) · FMD2-DB syncer            (placeholder)
│   └── src/db/        app.db migrations, catalog ro-attach, FTS sidecar      (placeholder)
├── contract/          @fmd/contract — machine-readable §5 contract
│   ├── contract.json  §5.2 event-binding table + surfaces, as data (source of
│   │                  generated code and CI drift checks)
│   ├── schema/        JSON Schema (draft 2020-12) for contract.json
│   ├── types.ts       EVERY cross-boundary interface/type lives here
│   ├── tools/         contract validator + toolchain-enforcement fixtures
│   └── test/          contract + toolchain tests (offline)
├── corpus/            @fmd/corpus — ground-truth triples (§13.1)
│   ├── harness/       FPC capture harness (D1) — Pascal skeleton + README
│   ├── fixtures/      recorded/synthetic triples (seed set)
│   └── runner/        offline replay loader/validator
├── web/               @fmd/web — React + Vite SPA (Phase-0 placeholder)
├── docs/              DESIGN.md · COMPAT.md · REVIEW-00*.md · runbook
├── scripts/ci.sh      local CI gate (typecheck → lint → test)
├── Makefile           thin wrapper over the npm scripts
├── vitest.config.ts   root vitest (all workspaces, coverage, offline)
├── eslint.config.js   flat config; boundary rules (see below)
└── tsconfig.base.json strict flag set shared by every workspace
```

Package manager: **npm workspaces** (root `package.json` workspaces =
`contract`, `server`, `corpus`, `web`). TypeScript builds run via
project references (`tsc -b`), so `contract` builds first automatically.

## Toolchain non-negotiables (apply to ALL stories)

| Gate | Enforcement |
|---|---|
| TypeScript strictest | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` + `verbatimModuleSyntax` (tsconfig.base.json) |
| `any` banned | `@typescript-eslint/no-explicit-any: error` (eslint.config.js) |
| Explicit return types on exports | `@typescript-eslint/explicit-module-boundary-types: error` |
| Boundaries live in one place | every cross-boundary interface/type is an export of `contract/types.ts` |
| Tests run offline | no live network in unit/integration tests — local mock servers/loopback or recorded fixtures only (DESIGN.md §13.1) |

These are *proved*, not just configured:

- `contract/tools/fixture-tests/tsconfig-strict-fixture/` contains code
  violating each flag; `contract/test/toolchain.test.ts` runs `tsc` on it
  and asserts the exact error codes (TS1484/TS18048/TS7006/TS4114 +
  `exactOptionalPropertyTypes`), plus a clean control that must compile.
- `contract/tools/fixture-tests/lint-violations.ts` trips both boundary
  lint rules; the same test asserts eslint reports them (clean control
  included). The fixtures are excluded from the normal lint/typecheck
  pass and checked only by the enforcement test.

## Commands

```sh
npm install          # install all workspaces
npm test             # vitest run (all workspaces, offline)
npm run test:coverage# vitest + v8 coverage
npm run lint         # eslint . (flat config)
npm run typecheck    # tsc -b (project references; also emits dist/)
npm run build        # same as typecheck (tsc -b)
npm run ci           # scripts/ci.sh: typecheck → lint → test
make ci              # alias of the above
```

Add `--workspace @fmd/<pkg>` to scope any script to one package.

## Docker (placeholder server)

```sh
docker compose -f docker/compose.yml up --build
# then: curl http://localhost:3000/healthz
```

- Multi-stage build (deps+build → runtime), non-root `USER node`,
  `HEALTHCHECK` against `/healthz`, bounded SIGTERM drain.
- Base image pinned to an exact Node LTS minor; CI swaps in the resolved
  `@sha256:` digest and SBOM-diffs double builds (DESIGN.md §3).
- The `browser` profile (FlareSolverr + Chromium, §5.11) ships as a
  **commented placeholder** in `docker/compose.yml`; opt in later with
  `docker compose --profile browser up`.
- Note: the enforcement tests structurally verify Dockerfile/compose
  (multi-stage, non-root, healthcheck, single active service); an actual
  image build needs a Docker host and is exercised in CI.

## Offline-test policy

Unit and integration tests NEVER touch the live network (DESIGN.md
§13.1): they use recorded fixtures (`corpus/fixtures`), in-process pure
functions, local spawns of repo tools (tsc/eslint), and loopback sockets
only (`127.0.0.1` — the healthcheck-stub test). The *live smoke suite*
is a separate, opt-in, nightly concern (§13.2) and must not ship in the
default `npm test`.

## Contract as data

`contract/contract.json` is the machine-readable §5 contract (the
15-dispatcher §5.2 event table, module surface, `TASK`/`MANGAINFO`
fields, require-shim table, capability flags, invariants), validated by
`contract/schema/contract.schema.json`. Later stories GENERATE the
`server/src/engine/events` binding tables from it and CI cross-checks it
against a fresh parse of the Pascal dispatchers (§13.5) — the §5.2 class
of transcription error becomes mechanically impossible to reintroduce.
