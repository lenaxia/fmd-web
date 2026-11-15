# Antibot interceptor pipeline integration — tsk-senior-pulley-covers

**Audit finding (bucket B):** the anti-bot interceptor was unit-tested only —
DESIGN §12 Phase-0 required bypass fixtures in the corpus and none existed
(`corpus/fixtures/` had zero bypass captures). The audited, agreed level is
**NOT** live Cloudflare capture (fragile, ToS-adjacent) but a faithful
OFFLINE pipeline test: **real FMD2 bypass scripts executed against a local
mock server that emits real antibot signatures**.

## What landed

| Piece | Where |
|---|---|
| Bypass fixture set (manifest + constants) | `corpus/fixtures/antibot/` — `manifest.json`, `challenge-iuam.html`, `challenge-block.html`, `signature-plan.json`, `websitebypass-config-default.json`, `websitebypass-config-flaresolverr.json`, `flaresolverr-endpoints.json`, `README.md` |
| Corpus registration | `corpus/fixtures/README.md` (tree + §5.9 section), `corpus/meta.json` (`antibotFixtures`) |
| Pipeline integration test | `server/test/engine/state/antibot.pipeline.integration.test.ts` (5 tests) |
| COMPAT.md antibot row (unit → **integration**-tested) | `docs/COMPAT.md` `LuaWebsiteBypass.pas + checkantibot.lua` row, generated via `corpus/scripts/generate-compat.ts` |
| Fidelity fixes unlocked by the pipeline | `subprocess-stub.ts` (4-value return + variadic args), `install.ts` (`bypass` port forwarding) |

## Test architecture (100 % offline)

- **Mock antibot server** — worker-thread `node:http` server (the Lua-facing
  request path is synchronous via `LoopbackHttpTransport`'s `Atomics.wait`),
  plan-seeded from the committed fixtures: the `checkantibot.lua:5-12`
  signature matrix at `/sig/*`, the IUAM challenge page (503 + `anon` cookie)
  at `/media/iuam-*`, the webdriver-only block page (403) at
  `/media/reload-*`, the IUAM solve endpoint `/cdn-cgi/l/chk_jschl`
  (**validates the POSTed `jschl_answer`** against the pinned constant — a
  broken Duktape shim produces a wrong answer → `Access denied. Your IP` →
  the bypass fails → the test fails), the FlareSolverr health endpoint
  `GET /`, and cleared-content/reload interstitial behavior per path.
- **Real stack under test** — one wasmoon engine per scenario carrying the
  REAL FMD2 chunks in one global scope (`checkantibot.lua` +
  `websitebypass.lua`; `cloudflare.lua` arrives through `require`), the v0
  shim installer (`fmd.duktape` ExecJS on node:vm, `fmd.crypto`,
  `fmd.logger`, `fmd.subprocess`, `utils.json` file chunks, TXQuery for the
  FlareSolverr health JSON), request-scoped HTTP facades over the loopback
  transport sharing the §5.3 `SharedCookieJar`, and a `MODULE` facade over
  the shared `SharedStorage`. The `AntiBotInterceptor` is wired with the
  REAL Lua heuristic (`____CheckAntiBot(HTTP)`) as its injected check and a
  stub-profile executor that runs the REAL `____WebsiteBypass(METHOD, URL)`.
- **Scenario configs** — `cloudflare.lua:load_config()` reads
  `lua\websitebypass\websitebypass_config.json` from the wasmoon wasm MEMFS;
  the test mounts the committed config per scenario (default → IUAM branch,
  `use_webdriver=true` + loopback port → FlareSolverr branch). Nothing is
  written to the repo tree.

## Run evidence

```
npx vitest run server/test/engine/state/antibot.pipeline.integration.test.ts
 ✓ 5 tests (8.4s)
```

| Test | Pipeline stages proven (assertions) |
|---|---|
| detects every checkantibot.lua:5-12 signature | 9 loopback responses (403/429/503 × text/html × cloudflare/ddos-guard incl. case variants; negatives: JSON content-type, 200, nginx, 404, missing Server) each read by the REAL Lua heuristic through `checkAntiBotActive`; `maxObservedCheckConcurrency === 1` |
| intercept negative (nginx 403) | `path: 'plain'`, `antibotHit: false`, executor never entered (`executor.entries === 0`, `bypass.entries === 0`) |
| IUAM pipeline (4.0s — the REAL 4000 ms `sleepOrBreak` timeout) | detect → serialize → single-flight → **challenge JS via the real duktape shim** (btoa = `Duktape.enc('base64')`, `Duktape.dec('base64')`; the mock validated `jschl_answer=Zm1kLXdlYjp0azUyMA%3D%3D` + `r`/`jschl_vc`/`pass` with `Origin`/`Referer` headers set by cloudflare.lua) → `AllowServerErrorResponse` forced on the REAL pipeline object (:156) → cookies cleared-then-set (seeded `stale=1` gone, `cf_clearance=bypassed-int-1` persisted :177/:182) → UA persisted (:183) → `Storage['reload'] === 'false'` (script-owned) → exactly ONE execution, no re-issue, `bypass.entries === 1`, zero `SendError` |
| FlareSolverr pipeline | webdriver branch end-to-end: mounted config (`use_webdriver=true`, loopback port) → health probe `GET /` parsed by REAL TXQuery (`XPathString('msg', json(*))` === `FlareSolverr is ready!`) → `subprocess.RunCommandHide(table.unpack(cmd_))` → stub-profile sidecar solve → **LuaSubprocess.pas 4-value return** `(true, cloudflare.py stdout, '', 0)` consumed by `json.decode` → `applyCookies` (`ClearCookiesStorage` + `cf_clearance=bypassed-flare-1` + `user_agent=flaresolverr-agent/1.0`) → `result == 2` → reload-strings matched → **`Storage['reload'] = 'true'`** → the interceptor `Reset()`s and re-issues the original request (:184-188) — wire: 3 GETs on the path (initial 403 → reload-check with clearance → re-issue with clearance), re-issue landed 200, settings hold exactly the solved cookie (no `anon`, no `stale`), sidecar solved exactly once with the ROOT url (cloudflare.lua passes `rooturl`) |
| ≥8 parallel image downloads, one bypass window | 8 workers on ONE module: exactly ONE bypass (`executor.entries === 1`, `bypass.entries === 1`, exactly ONE solve POST on the wire) — the 7 fallthroughs' first intercepts resolved **while the bypass was still pending** (`executor.released === false` at resolution, each < 1500 ms vs the seconds-long real bypass — losers never serialized), checks stayed globally serialized (`maxObserved === 1`), all 8 finished true, shared `cf_clearance` in the jar |

Neighboring suites after the subprocess/interceptor changes:
`antibot.test.ts` (17), `bypass-adapter.test.ts` (13),
`require-registry.test.ts` (7) — all green; `npm run typecheck` clean;
eslint clean on touched files.

## Fidelity notes (documented divergences + fixes)

1. **`atob`/TextDecoder gap (inherited, not introduced).** cloudflare.lua's
   generated IUAM preamble defines `atob(s)` via
   `new TextDecoder().decode(Duktape.dec('base64', s))` — `TextDecoder`
   exists in neither real Duktape nor the shim's node:vm heap (verified:
   `typeof TextDecoder === 'undefined'` inside the context). The fixture
   challenge therefore decodes through `Duktape.dec('base64', …)` directly
   and encodes through the preamble's `btoa` (= `Duktape.enc('base64')`) —
   exercising exactly the primitive pair the preamble wires, without
   depending on the absent global. The ExecJS timeout quirk is preserved:
   `timeout = tonumber(answer:match('"timeout":(%d+)')) or 4000` reads only
   INSIDE the extracted answer value, so the REAL 4000 ms `sleepOrBreak`
   runs (visible as the ~4 s IUAM test duration).
2. **`fmd.subprocess` 4-value return (fidelity FIX).** Real
   `LuaSubprocess.pas:_runcommand` returns FOUR values
   (`Result := 4`: boolean, OutputString, ErrorString, ExitStatus); the
   sidecar-routed stub returned a single boolean, which made
   `cloudflare.lua:solveWithWebDriver`'s
   `local _status, result, _errors = subprocess.RunCommandHide(...)` receive
   `result = nil` and `json.decode(nil)` error. The stub now returns the
   exact 4-value contract via wasmoon `LuaMultiReturn` (the `pb` shim's
   pattern), with `OutputString` = the `cloudflare.py` stdout shape
   (`flaresolver_status_code` + stringified flat cookie map + `user_agent`).
   The DENIED stub is unchanged (`RunCommand* => nil` — contract-pinned);
   `run` also joins ALL variadic arguments now (real `_runcommand` takes
   exe + N parameters; cloudflare.lua passes 7).
3. **`installShims` bypass forwarding (wiring FIX).** `InstallShimsOptions.bypass`
   (§5.11 sidecar adapter) was accepted but never forwarded to
   `installRequireShim` — the `fmd.subprocess` stub silently stayed in
   denied mode. Forwarded now; the §5.10 known-broken default (no adapter →
   denied stub) is unchanged.
4. **Header OWS.** cloudflare.lua sets `Headers.Values['Origin'] = ' ' ..
   rooturl`; the leading space is optional whitespace on the wire and does
   not survive a real HTTP round trip (node's parser strips it). The test
   asserts the Origin header carries the origin value, not the space.
5. **GET bodies.** The shim (FMD2-faithful) sends the current Document as
   the request body when non-empty — visible in the mock captures (the
   health probe carries the previous block page). Harmless; recorded here
   because the captures look odd at first glance.

## Acceptance criteria

| Criterion | Evidence |
|---|---|
| Full pipeline test green offline: detect → serialize → single-flight (fallthrough) → challenge JS via duktape shim → cookie/UA persistence → reload re-issue | IUAM test (first five stages) + FlareSolverr test (reload re-issue) — 5/5 tests green in `antibot-run` logs above; both run against loopback only (zero-network guard active) |
| Concurrency test: exactly one bypass under ≥8 parallel requests; losers not delayed (timing assertion) | Concurrency test: `executor.entries === 1`, `bypass.entries === 1`, one solve POST on the wire; 7 fallthroughs resolved with `executor.released === false` (bypass pending), each first intercept < 1500 ms |
| Fixtures committed under `corpus/fixtures/antibot/` and registered in the corpus manifest; COMPAT.md upgraded | 8 fixture files committed; `corpus/fixtures/antibot/manifest.json` (+ `meta.json` `antibotFixtures` + fixtures README sections); COMPAT.md `LuaWebsiteBypass.pas + checkantibot.lua` row generated with the integration-test note |
