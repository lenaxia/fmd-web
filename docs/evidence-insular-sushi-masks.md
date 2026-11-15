# Evidence — tsk-insular-sushi-masks (Proxies end-to-end + browser sidecar profile + capability surfacing)

Stage: in_progress → in_review. All four acceptance criteria are met;
verification: `npm test` (1305/1306 green — the one red test is
`web/test/downloads-feed.test.tsx`, owned by the favorites story's
in-flight DownloadsPage change), `npx tsc -b` clean, scoped eslint
clean, `npm run contract:check` OK,
`bash scripts/compose-check.sh` PASS (incl. the new browser-profile
leg), vendored `docker compose config` renders validated both with and
without `--profile browser`.

## 1. Proxy integration tests (HTTP + SOCKS5 routing, egress asserted at the proxy)

`server/test/engine/shims/http-proxy-routing.integration.test.ts` — 7
tests against LOCAL mock proxies hosted in a worker harness (the caller
blocks in `Atomics.wait`, so mocks live on another thread):

- HTTP forward proxy: absolute-form request line + `Proxy-Authorization`
  recorded AT the proxy; origin answers through it (origin log = egress
  proof).
- `initialProxy` settings default routes without SetProxy; SetNoProxy
  clears (parity with `httpsendthread.pas:838-874`).
- SOCKS5 without auth: CONNECT target recorded at the proxy.
- SOCKS5 with auth: wrong creds fail the handshake (RFC 1929, recorded
  at the proxy); correct creds route; failed attempts never reach the
  origin.
- SOCKS4(a): user id + CONNECT hostname recorded; routes.
- Non-loopback proxy host refused before any socket opens (DESIGN §13).
- Stalling proxy trips the request `Timeout`.

Plumbing: `RawProxy` rides `RawHttpRequest`
(`server/src/engine/shims/http-transport.ts` — worker routes HTTP
forward-proxy / SOCKS5 greeting+auth+CONNECT / SOCKS4a, per-phase
timeouts); `HttpPipeline.proxyProvider` consulted per hop; the shim
accepts `initialProxy` (settings default; module `SetProxy` overrides at
runtime) and exposes `proxyProvider` per hop.

## 2. Sidecar adapter contract tests (mock flaresolverr: concurrency 2, 60 s, health-gate)

`server/test/engine/sidecar/bypass-adapter.test.ts` — 13 tests vs a
worker-hosted mock sidecar:

- Budgets are the defaults (60 000 ms / 2) — §5.11.
- health() true/false; health-gate refuses solve WITHOUT touching /v1.
- solve() maps the FlareSolverr v1 solution envelope (url/status/
  headers/body/cookies/userAgent) and sends `request.get` + `maxTimeout`.
- Bounded concurrency: 5 concurrent solves → sidecar observes
  `maxInFlight === 2`.
- Stall → `BypassTimeoutError` within the configured budget.
- FlareSolverr error outcome → `BypassUpstreamError` with the message.
- `solveSync()` — the Atomics blocking bridge for synchronous Lua facade
  calls — routes through the same pump.
- Unreachable sidecar → `BypassUnavailableError`.
- `fmd.subprocess` stub (`server/src/engine/sidecar/subprocess-stub.ts`):
  denied stub returns nil without the adapter; with the adapter
  `RunCommandHide` routes (URL extracted) and returns the launch
  boolean; failures log WARN + return false.

Adapter: `server/src/engine/sidecar/bypass-adapter.ts`
(`FlareSolverrBypassExecutor` — one pump worker owning the semaphore,
per-call AbortController budget and the cached /health gate).

## 3. Compose `browser` profile validated + capability flip (config test)

- `docker/compose.yml`: real `flaresolverr` service, `profiles:
  ["browser"]`, digest-pinned
  `v3.3.21@sha256:f104ee51e5124d83cf3be9b37480649355d223f7d8f9e453d0d5ef06c6e3b31b`
  (index digest resolved from ghcr.io at 2026-11-15; recorded in
  `docs/docker-pinning.md`), `/health` healthcheck; the app carries
  `FMD_WEB_BROWSER_SIDECAR_URL: ${FMD_WEB_BROWSER_SIDECAR_URL:-}`
  (empty default — opt-in).
- Real-render validation: `scripts/compose-check.sh` now renders the
  merged config WITHOUT the profile (flaresolverr absent) and WITH it
  (pin + healthcheck + env pass-through asserted) — PASS on the vendored
  docker/compose CLI.
- Offline config tests: `server/test/docker/compose-browser-profile.test.ts`
  (4) + contract `contract/test/toolchain.test.ts` compose section
  (profile-gated services, digest pin, healthcheck).
- Capability flip (config-driven): `applyBrowserProfile`
  (`server/src/api/services.ts`) drops `fmd.subprocess`,
  `madara.run_html_load`, `webdriver.bypass` from `known_broken_flags`
  when the profile is enabled (requires_* stay truthful).
  `server/test/api/settings.test.ts` asserts the flip both ways via
  `buildHarness({ browserProfile: true })`; assembly wiring:
  `FMD_WEB_BROWSER_SIDECAR_URL` → `FlareSolverrBypassExecutor` +
  settings service + module-service flip flag
  (`server/src/runtime/assembly.ts`); engine paths (info + download)
  receive `proxyFor` (per-module effective proxy) and `bypass`
  (`server/src/runtime/engine-info.ts`, `download-engine.ts`,
  `engine/shims/install.ts`, `engine/shims/lua-require.ts`).

## 4. Settings UI component tests (proxy + module capability rendering)

`web/test/proxy-settings.test.tsx` — 5 tests: sidecar off/on badges,
five-field global proxy editor (typed config PUT /api/settings/proxy,
Save disabled until drafted, disabled fields for type=none), Settings →
Modules 'needs browser' + known-broken badges, per-module override
set/null-clear via the typed generated client. Hooks
(`useSettings`, `useUpdateProxy`, `ModuleUpdateInput.proxy`) ride the
GENERATED openapi types (`web/src/api/openapi.d.ts` regenerated from the
committed snapshot; api-drift + ws-contract-drift tests green).

## API surface (typed)

`GET /api/settings`, `PUT /api/settings/proxy`, `PUT /api/modules/:id`
(+`proxy`), `ModuleSummary.proxy`, `ProxySettings` schema
(HTTP|SOCKS4|SOCKS5 + host/port/user/pass; '' type = no proxy; host
required when typed) — openapi snapshot regenerated; 10 API tests in
`server/test/api/settings.test.ts` (validation matrix, override
set/clear, flip both ways, empty-update 400).

## Docs

`docs/runbook.md`: "Browser sidecar profile (§5.11, D2)" (enable steps
with the env + profile, flip semantics, adapter budgets, subprocess
routing) + "Proxy settings (§9/§10, SetProxy parity)" (global +
per-module precedence, transport notes);
`docs/docker-pinning.md`: flaresolverr pin + verify flow.
