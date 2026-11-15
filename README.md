# fmd-web

A Dockerized, web-based rebuild of **FMD2 (Free Manga Downloader 2)** that
reuses FMD2's Lua site-module ecosystem and the FMD2-DB catalogs
**unchanged** — one ecosystem, one module set, no fork of site adapters.

Authoritative design: [`DESIGN.md`](DESIGN.md) (v5, review-converged —
revisions driven by `docs/REVIEW-001-design-review.md`,
`docs/REVIEW-002-design-review.md`, `docs/REVIEW-003-design-review.md`,
`docs/REVIEW-004-design-review.md`, and the release review
`docs/REVIEW-velvet-pulley-prosper.md`). This document covers the
repository layout, commands, and the Phase-0 toolchain contract.

## Quickstart

```sh
# 1. run the stack (builds the image, serves the SPA on :3000)
docker compose -f docker/compose.yml up --build
#    first boot performs the D20 bootstrap (module+catalog sync);
#    /readyz flips to 200 when done — the UI shows the progress banner.

# 2. open the app
xdg-open http://localhost:3000     # Browse → search → manga → download

# 3. tag the release image (0.1.0)
FMD_WEB_IMAGE_TAG=0.1.0 docker compose -f docker/compose.yml build app
```

No Docker? The process twin is the same app without the container:

```sh
npm install
npm run build && npm run build -w @fmd/web
PORT=3000 FMD_STATIC_DIR=web/dist-web FMD_WEB_DATA_DIR=./data \
  node server/dist/src/runtime-entry.js
```

Docs: operations → `docs/runbook.md`; compatibility →
`docs/COMPAT.md`; release details (decision status, known-broken
modules, hardening verification) → `docs/RELEASE-NOTES.md`.

### Screenshots

<!-- PLACEHOLDER — capture at 0.1.x: Browse (latest), Manga detail with
     live info, Downloads with WS progress, Settings with capability
     badges. Drop PNGs into docs/screenshots/ and reference here. -->

| Screen | Screenshot |
|---|---|
| Browse / Latest | _pending_ |
| Manga detail (live info) | _pending_ |
| Downloads (WS progress) | _pending_ |
| Settings (capability badges, bootstrap) | _pending_ |

## Repository layout (DESIGN.md §11)

```
fmd-web/
├── docker/            Dockerfile (multi-stage, non-root, healthcheck, ships the
│                      SPA) · compose.yml (app; `browser` = commented placeholder)
│                      · compose.e2e.yml (test profile: mock upstream + app env)
├── server/            @fmd/server — API server + module engine + jobs + sync + db
│   ├── src/api/       Fastify routes, WS hub + backfill, auth, rate limits   (placeholder)
│   ├── src/engine/
│   │   ├── lua/       worker pool (engine-per-worker), chunk cache, watchdog (placeholder)
│   │   ├── shims/     http · txquery · strings · crypto · duktape · pb · …   (placeholder)
│   │   ├── state/     per-module shared state service (§5.3)                 (placeholder)
│   │   └── events/    binding tables GENERATED from contract/contract.json   (placeholder)
│   ├── src/jobs/      queue lanes, download pipeline, packer, favorites      (placeholder)
│   ├── src/runtime/   production assembly: D20 bootstrap, engine-backed live
│   │                  info, static SPA serving; runtime-entry.ts = the
│   │                  container entry (SIGTERM drain, readiness gate)
│   ├── src/sync/      FMD2 lua/ syncer (SHA pin) · FMD2-DB syncer
│   └── src/db/        app.db migrations, catalog ro-attach, FTS sidecar
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
├── web/               @fmd/web — React + Vite SPA: Browse · Manga · Downloads · Settings
│                      (typed API client GENERATED from the OpenAPI snapshot; see web/README.md)
├── e2e/               Phase-2 e2e assets: fixture lua tree + upstream fixtures,
│                      node:http mock-upstream.mjs, prep.mjs (builds the crafted
│                      catalog .7z + fixture zipball), shared e2e constants
├── docs/              DESIGN.md · COMPAT.md · RELEASE-NOTES.md · REVIEW-00*.md ·
│                      REVIEW-velvet-pulley-prosper.md · runbook ·
│                      docker-pinning.md · per-story evidence-*.md
├── scripts/ci.sh      local CI gate (contract → lint → typecheck → test →
│                      corpus → e2e phase-2 → e2e phase-3; --live adds the smoke)
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
npm run ci           # scripts/ci.sh full gate: contract → lint → typecheck →
                     # test → corpus → e2e phase-2 → e2e phase-3 (--live: + smoke)
make ci              # alias of the above
bash scripts/e2e.sh  # compose e2e gate (see "Compose e2e" below)
```

Add `--workspace @fmd/<pkg>` to scope any script to one package.

## Docker

```sh
docker compose -f docker/compose.yml up --build
# then: curl http://localhost:3000/healthz
```

- Multi-stage build (deps+build → runtime), non-root `USER node`,
  `HEALTHCHECK` against `/healthz`, ships the built SPA (`web/dist-web`)
  and runs `server/dist/src/runtime-entry.js`.
- The runtime assembles the REAL Phase-2 services and performs the
  **D20 first-run bootstrap**: with an empty data dir it syncs the lua
  tree at the configured pin, sweeps the registry, and installs the
  catalogs in `FMD_BOOTSTRAP_CATALOGS` — `/readyz` stays 503 (with the
  bootstrap stage as `reason`) until done. `/healthz` is liveness-only.
  Set `FMD_BOOTSTRAP_DISABLE=1` to skip the first-run sync entirely
  (see the env table below).
- SIGTERM → bounded drain (≤25 s bound): stops accepting, logs the
  queued-job flush, closes catalog stores, disposes engines, exits 0.
- Base image pinned to an exact Node LTS minor; CI swaps in the resolved
  `@sha256:` digest and SBOM-diffs double builds (DESIGN.md §3 — see
  `docs/docker-pinning.md` for the procedure + recorded digests).
- The `browser` profile (FlareSolverr + Chromium, §5.11) ships as a
  **commented placeholder** in `docker/compose.yml`; opt in later with
  `docker compose --profile browser up`.
- Note: the enforcement tests structurally verify Dockerfile/compose
  (multi-stage, non-root, healthcheck, single active service); an actual
  image build needs a Docker host and is exercised in CI.

## Environment variables (runtime)

| Variable | Default | Effect |
|---|---|---|
| `FMD_WEB_DATA_DIR` (alias `FMD_DATA_DIR`) | `./data` (container: `/app/data`) | Data-dir root: `app.db`, `lua/`, `catalogs/`, `fts/`, `library/`, `sync/`, `tmp/` |
| `PORT` | `3000` | HTTP listen port |
| `FMD2_REPO` / `FMD2_LUA_SHA` / `FMD2_CODELOAD_URL` | pinned defaults (D9) | Module-tree sync pin; bumping is a deployment act (see runbook) |
| `FMD_LUA_DIR` | unset | Dev-only: stage+install this local lua tree, skipping the fetch |
| `FMD_DB_URL` / `FMD_DB_API_BASE` | pinned repo | FMD2-DB catalog upstream override (§6) |
| `FMD_BOOTSTRAP_CATALOGS` | empty | D20 first-run bootstrap: csv of catalog ids to install on an empty data dir |
| `FMD_BOOTSTRAP_DELAY_MS` | `0` | D20 minimum stage wall time (demo/e2e observability; leave 0 in production) |
| `FMD_BOOTSTRAP_DISABLE` | unset | D20 disable switch: `1` skips the first-run module+catalog sync ENTIRELY (bootstrap short-circuits to done, `/readyz` stays green, the lua-tree readiness check is dropped — the operator owns provisioning) |
| `FMD_NORMALIZE_PATHS` | unset | D5 opt-out: `1` (or the `--normalize-paths` CLI alias) switches filename resolution from the default Windows-desktop parity (tail truncation over `CurrentMaxFileNameLength`) to sanitized Linux-normalized paths — same sanitization, control units deleted, NO tail truncation |
| `FMD_HTTP_ALLOW_HOSTS` | empty | Extra (non-loopback) hosts module HTTP may reach (csv); loopback is always allowed |
| `FMD_STATIC_DIR` | unset | SPA dist dir served at `/` (unset = API-only) |
| `FMD_WEB_BROWSER_SIDECAR_URL` | empty | §5.11 browser sidecar (FlareSolverr) — enables the `browser` profile wiring |
| `FMD_FAVORITE_THREADS` / `FMD_FAVORITE_INTERVAL_MS` / `FMD_FAVORITE_JITTER_MS` | scheduler defaults | §7.2 favorites scheduler bounds |

Full operational detail: `docs/runbook.md`.

## Compose e2e (Phase-2 exit gate) — one command

```sh
bash scripts/e2e.sh                # compose stack when docker is available …
bash scripts/e2e.sh --mode process # … or the process-mode twin (no docker)
```

Fully offline (fixtures + local mock upstream only). The scenario:

1. builds the repo + SPA and preps the fixture upstream tree
   (`e2e/prep.mjs`: crafted catalog `.7z` from a `masterlist` fixture db,
   codeload-shaped zipball of the fixture lua tree, commits JSON,
   recorded manga page);
2. boots the stack — `docker/compose.e2e.yml` (test profile) adds a
   digest-pinned `node:http` mock-upstream container (fixture catalogs +
   zipball mounted in) and retargets the app at it;
3. **Playwright bootstrap-watch** (before the readiness gate): the UI
   shows the D20 empty-state, the bootstrap progress banner appears
   (server stage surfaced via `/readyz` 503 `reason`), then clears;
4. `wait-on /readyz` gates the test startup on the bootstrap;
5. **Playwright main scenario**: browse latest (5 fixture entries) →
   FTS search `alpha` → manga detail with LIVE info through the seed
   module (`E2ESeed.lua` from the synced fixture tree, fetched against
   the mock upstream) → enqueue dry-run preview without sending →
   enqueue → Downloads shows the job `queued`;
6. evidence: mock request log (zipball + commits + `.7z` + site page —
   the only upstream traffic), non-root container `id`, SIGTERM drain
   ≤30s with flush-log assertions, image digest/SBOM record
   (compose mode), all dumped under `e2e/.tmp/artifacts/`.

Without a docker daemon (this sandbox), `--mode process` runs the same
runtime entry + mock script + Playwright specs as host processes —
same assertions, minus the container id/digest steps (documented in
`docs/docker-pinning.md`). In BOTH modes the compose leg is validated
with the real docker compose implementation first
(`scripts/compose-check.sh`: `docker compose config` merge render +
effective-config asserts + digest-pin freshness — daemon-less).

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
