# Evidence — tsk-lofty-rosemary-reviews (compose e2e: bootstrap → browse → search → info → dry-run enqueue; Phase-2 exit gate)

Date: 2026-11-13T23:20Z (rev. 2 — review-fix bounce 1, 23:45Z) · Environment: node v24.20.0, Playwright 1.65, docker CLI 27.5.1 + compose v2.32.4 (client-side) · Offline (fixtures + local mock upstream only)

## Scope

The Phase-2 exit gate: ONE command (`scripts/e2e.sh`) boots the whole
system WITHOUT live manga sites — fixture catalogs (crafted `.7z` from
the sync-db fixture schema), the fixture lua tree (seed module packaged
as a codeload-shaped zipball), and a local `node:http` mock upstream
container for module + catalog sync — and drives the UI with Playwright
through empty-state → bootstrap progress → browse latest → search →
manga detail (live info via the mock upstream through the seed module) →
enqueue dry-run → job visible in Downloads queued. Plus the ops
assertions: non-root container user, SIGTERM graceful drain (≤30 s,
flush logs), image SBOM/digest pin documented.

## Delivered

- **Production runtime** (`server/src/runtime/` + `runtime-entry.ts`):
  the real service assembly the container runs —
  - `assembly.ts`: env-driven config (`loadRuntimeConfig`); wires the
    REAL module sync (SHA pin, `createModuleSyncService`), the REAL
    catalog sync (`CatalogSync` with `dbUrl`/`apiBase` overrides), the
    registry sweep (`StartupRegistryService`, fresh per boot), an
    engine-backed live info (`EngineInfoService`), the in-memory §10
    job store (documented stand-in until the SQLite queue story), and
    the API app. Documented stand-ins only: job store + per-boot
    registry persistence (their stories are still backlog).
  - `bootstrap.ts` (D20): staged bootstrap — modules → registry →
    catalogs (`checkForUpdates()` §6.1 commits check, then per-id blob
    syncs) — every stage skipped when its artifact is installed
    (restart-resume), readiness surfaced as `/readyz` 503 + stage
    `reason`, start-order retries, optional `FMD_BOOTSTRAP_DELAY_MS`
    stage pacing (demo/e2e affordance, documented).
  - `engine-info.ts`: `POST /api/info` runs the module's real GetInfo
    through wasmoon with the §5.4 shims over a LIVE transport, then the
    §5.8 `normalizeMangaInfo` pipeline; per-call engine, serialized;
    unknown module → typed 404.
  - `static.ts`: dependency-free SPA static server (index + hashed
    assets, content types, SPA fallback, traversal-jailed, `/api/*` +
    health keep their own semantics).
  - `runtime-entry.ts`: the container CMD — listen first, bootstrap
    with `/readyz` gating, SIGTERM/SIGINT bounded drain (25 s bound):
    stop accepting → queued-job flush summary → catalog stores closed +
    engines disposed → exit 0, all as `fmd: ` log lines.
- **Transport allow-list** (`http-transport.ts`): `LoopbackHttpTransport`
  gains an explicit `allowedHosts` option (host-side AND worker-side
  checks) so module HTTP can reach the compose mock container
  (`e2e-mock`) — default stays loopback-only, http-only, §13 intact.
- **`/readyz` readiness semantics** (`app.ts` + `openapi.ts` +
  regenerated snapshot/generated client): not-ready → **503** with the
  same `{ready:false, reason}` envelope — that is what makes wait-on a
  real gate and gives the SPA banner its stage text (health test
  updated accordingly).
- **UI**: D20 bootstrap banner (`App` shell + `useBootstrapStatus`
  polling `/readyz`, `data-testid="bootstrap-status"`); fixed the App
  shell's provider nesting (the inner `ApiClientProvider` shadowed the
  injected client — provider moved to `main.tsx`, as the design comment
  already documented). Component tests for both banner states.
- **e2e assets** (`e2e/`): `fixtures/lua/lua/modules/E2ESeed.lua` (FMD2
  module convention: `NewWebsiteModule`, TXQuery GetInfo off the `URL`
  global — no hardcoded host, so one module serves both modes),
  `utils/e2eutil.lua` (subtree-proof), recorded manga page, shared
  `e2e.json` constants (40-hex e2e lua pin, commits sha, 32-hex
  catalog id), `mock-upstream.mjs` (zero-dep `node:http` fixture
  container: strict-sha zipball, commits with ETag/304, static
  `.7z`/site serving, `/_requests` evidence log, `--port 0` discovery),
  `prep.mjs` (builds the upstream tree: crafted `masterlist` catalog db
  → real 7za `.7z`, stored-entry zipball from the fixture lua tree,
  commits.json, compose `e2e.env`).
- **Compose** (`docker/compose.e2e.yml`, test profile): digest-pinned
  mock container (`node:22.14.0-bookworm-slim@sha256:1c18d9ab…`), the
  fixture tree + mock script bind-mounted in, host-mapped 8091 for the
  request-log assertion, `service_healthy` ordering, app override
  (env_file from prep, `stop_grace_period: 30s`, fast healthcheck,
  `restart: "no"`). Dockerfile: ships `web/dist-web`, runs the runtime
  entry. `docs/docker-pinning.md`: base-image digests (resolved live
  from the registry), digest-record + syft SBOM double-build diff
  procedures.
- **`scripts/e2e.sh`**: the one command — build → fixture prep → boot
  (compose or process twin) → bootstrap-watch → `wait-on /readyz` →
  main scenario → offline proof (mock request log) → non-root id →
  SIGTERM drain ≤30 s with flush-log greps → artifacts + teardown.
  Port pre-flight guard; `--mode auto|compose|process`.
- **Playwright** (`web/playwright.compose.config.ts` + specs):
  `bootstrap-watch.spec.ts` (empty-state → banner appears with stage →
  banner clears → `/readyz` 200) and `compose-scenario.spec.ts`
  (browse 5/5 → search `alpha` → live info (author/genres/chapters) →
  dry-run preview with zero POSTs → enqueue → Downloads row `queued`).
  Smoke config scoped to `smoke.spec.ts` (compose specs no longer leak
  into `npm run e2e -w @fmd/web`).

## Environment constraint (disclosed)

This sandbox has NO docker daemon (no `docker` binary, no
`docker.sock`, unprivileged user). The compose path is fully authored
and takes the SAME inputs the process mode consumes; what actually ran
here is `--mode process` — the identical runtime entry, mock script,
fixtures, and Playwright specs as host processes, with the two
container-only assertions replaced by their documented equivalents
(server uid ≠ 0; digest/SBOM commands recorded in
`docs/docker-pinning.md` for a docker host). Compose-mode specifics
(`service_healthy` ordering, bind mounts, env_file, `stop -t 35`,
`compose logs` grep) are validated by construction + the port/pin
sanity checks; the first docker-enabled CI run exercises them
end-to-end.

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Playwright e2e green against the compose stack (offline: fixtures + mock upstream only) | `bash scripts/e2e.sh --mode process` — **PASS end-to-end**: bootstrap-watch ✓ (7.5 s), main scenario ✓ (0.8 s), then the script's own asserts: mock request log shows EXACTLY `GET /codeload/dazedcat19/FMD2/zip/<pin>`, `GET /api-github/repos/dazedcat19/FMD2-DB/commits?sha=master&per_page=1`, `GET /FMD2-DB/db/7z/<catalogId>.7z`, `GET /manga/alpha-quest` — the ONLY upstream traffic, all to the local mock (`e2e/.tmp/artifacts/mock-requests.json`). The in-process twin `server/test/runtime/runtime.test.ts` proves the same pipelines against the REAL mock script: bootstrap traffic asserted, populated-data-dir boot makes **zero** upstream requests. | met (process twin; compose file authored) |
| Auto-bootstrap: empty data dir → sync runs → catalogs browsable (UI-asserted) | bootstrap-watch spec: D20 empty-state visible → `bootstrap-status` banner appears with the server stage (`bootstrap: modules…` — `FMD_BOOTSTRAP_DELAY_MS=2500` pacing makes the progress observable; documented affordance) → banner clears → `/readyz` 200. Main spec then browses the BOOTSTRAPPED catalog in the UI (`Showing 5 of 5 entries`). App log for the run: `empty data dir — running module sync (D20)` → `module sync installed sha e2ee000000` → `registry ready (sweep, 1 modules)` → `catalog update check — head 5eed000000` → `catalog updated` → `bootstrap: done`. Unit twin: `/readyz` 503 before, `{ready:true}` after, `data/lua/` + `sync-state.json` + receipt installed via the real pipelines. | met |
| SIGTERM drain ≤30 s with flush logs; non-root container (id-asserted) | Drain: script stops the app, greps `SIGTERM received — beginning graceful drain`, `stopped accepting connections`, `queued job(s) preserved`, `flush complete`, `drain: complete in` — measured 0 s (bound 25 s in-process; compose stop budget 30 s). Run log shows the flush listing the queued job by id. Spawned-child test `server/test/runtime/drain.test.ts` proves exit code 0, wall < 30 s, empty stderr, SPA served through the raw bridge. Non-root: compose mode asserts `compose exec app id -u` ≠ 0; process twin asserted uid 1000 (`e2e/.tmp/artifacts/non-root-id.txt`). The image itself ships `USER node` (uid 1000). | met (process twin for the id assert) |
| Reproducible via one command (scripts/e2e.sh) + documented in README | `bash scripts/e2e.sh` (auto-detects docker; `--mode compose` / `--mode process` forced). README gained the "Compose e2e (Phase-2 exit gate)" section (scenario steps, offline guarantees, mode split); runbook gained the Runtime section (env surface, drain, D20). | met |

## Verification

- `bash scripts/ci.sh` — contract drift 0 → lint clean → typecheck
  clean → **887/887 tests green (86 files)** → corpus 912/912 = 100%,
  COMPAT.md byte-stable.
- `npm run e2e -w @fmd/web` — smoke 4/4 green (compose specs excluded).
- `npx vitest run server/test/runtime/` — 8/8 (bootstrap, live info,
  enqueue, resume-no-traffic, config, static × 2, drain child).
- `bash scripts/e2e.sh --mode process` — **PASS** (twice consecutively
  after the final code state), artifacts regenerated.
- wait-on gate semantics verified directly: `/readyz` 503 → wait-on
  exits nonzero; ready 200 → exits 0.
- `npm run test:coverage` not re-run this story (no threshold-relevant
  coverage drop: `server/src/runtime/` is exercised by the runtime
  suite; the vitest thresholds still hold under `npm test`).

## Design decisions worth review

1. `/readyz` now answers 503 while not ready — a semantic change to the
   §10 health surface (documented in the OpenAPI description; the
   envelope shape is unchanged). Required for wait-on gating and
   standard readiness semantics.
2. `LoopbackHttpTransport.allowedHosts` — the one sanctioned non-loopback
   path, explicitly allow-listed via `FMD_HTTP_ALLOW_HOSTS`, enforced
   twice (egress policy + transport, host-side and worker-side).
3. Bootstrap's `FMD_BOOTSTRAP_DELAY_MS` — test/demo affordance only;
   production default 0. Needed because fixture syncs finish in
   milliseconds and would make the D20 progress surfaces unobservable.
4. Catalog fixture links embed the mock base (module fetches the URL
   global verbatim), so one seed module serves both process (127.0.0.1)
   and compose (`e2e-mock`) topologies; `prep.mjs` is mode-aware.
5. The container runs the runtime entry with the in-memory §10 job
   store and per-boot registry sweep — the SQLite queue/module_state
   stories swap in behind the same ports without route or e2e changes.

## Review round 1 → fixes (windy-musket-endures: fail)

**Blocker — `scripts/e2e.sh` compose-mode drain section.** The compose
branch captured `compose logs app` BEFORE `compose stop`, so the
drain-log assertions (`SIGTERM received…`, `flush complete`, …) could
never pass — the log snapshot predated the SIGTERM. Fixed: stop FIRST,
then capture the full log (drain lines included) and assert. Hardened
the same section while in there: drain timing now millisecond-precise
(`date +%s%3N`; whole-second `$SECONDS` could pass a 30.x s drain),
and a CLEAN-EXIT assert was added — after stop, `compose ps -a -q app`
→ `docker inspect` must show `Status=exited, ExitCode=0` (the app
exited itself through the bounded drain, never SIGKILLed at the stop
bound). Also fixed two adjacent compose-leg defects found in
self-review: `compose ps -q` shows only RUNNING containers (the
stopped app would have been "not found" — now `ps -a`), and the EXIT
trap registered AFTER `up -d` (a failed start leaked partial state —
trap now registered before `up`). All compose invocations go through
one `$COMPOSE` string with an explicit `-p fmd-e2e` project name.

**Major — `--mode compose` validated by construction only.** Now
validated with the REAL docker compose implementation:
`scripts/compose-check.sh` runs `docker compose config` (client-side
render + merge — env_file interpolation, profiles, depends_on
conditions, healthcheck overrides; NO daemon needed) and asserts the
effective merged config: `depends_on e2e-mock service_healthy`,
`stop_grace_period: 30s`, `restart: "no"`, published 3000, app-data
volume, the interpolated app env (`FMD2_CODELOAD_URL`… from the
prep-generated `e2e.env`), `/healthz` healthcheck, the digest-pinned
mock image + test profile + existing bind sources + 8091→8081 mapping,
the Dockerfile contract (non-root `USER node`, HEALTHCHECK, CMD → the
BUILT `server/dist/src/runtime-entry.js`, COPY sources present), and
the mock image digest pin freshness resolved LIVE from
registry-1.docker.io (matches `sha256:1c18d9ab…`, recorded in
`docs/docker-pinning.md`). It uses the host docker CLI on docker hosts,
else a vendored static CLI (docker 27.5.1 + compose v2.32.4,
authoring-time download — commands documented). `e2e.sh` runs
compose-check in BOTH modes; compose mode requires it (strict). What
remains daemon-only — image build + container lifecycle — is fully
scripted (`build → up -d → exec id -u → stop -t 35 → logs/inspect`)
with the port pre-flight, `service_healthy` ordering, and clean-exit
asserts wired so the first docker-host run executes mechanically.
Disclosure stays explicit: this sandbox cannot host a daemon (no
socket, unprivileged, `unshare` probe refused), so the RUNTIME verdict
still comes from the process twin, green end-to-end after the fixes
(drain 21 ms).

## Post-fix verification (this round)

- `bash scripts/compose-check.sh` — PASS (real-tooling merge render,
  all effective-config asserts, Dockerfile contract, digest-pin
  freshness).
- `bash scripts/e2e.sh --mode process` — **PASS**: bootstrap-watch ✓,
  main ✓, offline request-log proof ✓, non-root uid 1000 ✓, drain
  21 ms with all five flush-log needles ✓.
- `bash scripts/ci.sh` — contract 0 drift → lint → typecheck →
  887/887 tests → corpus 912/912 (100%).

