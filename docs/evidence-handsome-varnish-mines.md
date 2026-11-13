# Evidence — tsk-handsome-varnish-mines (Shared module state service + anti-bot interceptor, single-flight fallthrough)

Date: 2026-11-13T06:35Z · Environment: node v24.20.0, vitest 3.2.7, linux

## Scope

`server/src/engine/state/` per DESIGN §5.3 (shared module state service),
§5.9 (anti-bot / websitebypass host-level interceptor), §9 (`module_state`
persistence boundary) — mirrors the locked FMD2 Pascal objects
(`LuaStringsStorage.pas:17,75`, `httpcookiemanager.pas:46`,
`WebsiteModules.pas:90`, `LuaWebsiteBypass.pas:142-209`,
`checkantibot.lua:5-12`). D12: same-module events MAY run concurrently;
only state objects lock.

New files: `state/locks.ts` (AsyncMutex with TryEnter, AsyncRWLock
write-preferring, PerKeyMutexPool, LockHoldTracker — ALS-context-scoped
detector, `hostOf`), `state/module-state.ts` (full implementation of the
§5.3 service: SharedCookieJar RW + snapshot-on-read, SharedStorage per-key
KV + committing `transact`, SharedAccount mutex, ModuleSettings
copy-on-read frozen snapshots, BypassGate TryEnter gate,
HostConnectionLimiter per-host FIFO with 0=unlimited `:543-550`,
ModuleStateService one-instance-per-module + persistence seeding/flush),
`state/persistence.ts` (PersistedModuleState `module_state.cookies/ua`
boundary + InMemoryModuleStatePersistence; SQLite adapter is the db
story's), `state/antibot.ts` (checkAntiBot heuristic port, AntiBotInterceptor
= `WebsiteBypassRequest` port, BypassExecutor interface + StubBypassExecutor
known-broken default).

## Acceptance criteria → evidence

All in `server/test/engine/state/` — 43 tests, green across 6 consecutive
runs (`npx vitest run server/test/engine/state` → `43 passed (43)`); lint
clean, tsc clean for the state tree.

| Criterion | Evidence | Status |
|---|---|---|
| Concurrency: ≥8 parallel same-module events over the shared service, no deadlock, observe each other's cookie writes (ordering-agnostic) | `module-state.test.ts` "12 concurrent events share cookies/Storage without deadlock": 12 workers over ONE `ModuleStateService` module bundle — per-host limiter (limit 4, real queueing), RW-locked cookie merge of `w0…w11`, per-key `storage.transact('seq')` counter lands exactly `12`, each worker observes its own cookie mid-flight (ordering-agnostic: others' presence timing-dependent, all 12 asserted after join), whole run under a 5 s deadlock watchdog, `assertGloballyIdle` at quiescence. `antibot.test.ts` "≥8 parallel same-module image downloads" (AC1 integration): 8 loopback HTTP downloads over the mock 403-server with ONE single-flight bypass — deterministic phases (1 winner + 7 fallthroughs counted before gate release), all 8 succeed, final jar = clearance + `anon` seed + 8 worker markers (count 10), `hits` storage = exactly `8`, `executor.entries === 1` (exactly ONE bypass for all 8). | met |
| Interceptor tests: global check serialization, single-flight fallthrough (loser NOT delayed), cookie-clear-before-bypass, reload re-issue, AllowServerErrorResponse forced | `antibot.test.ts` interceptor-flow describe (12 tests): **global serialization** — two overlapping intercepts with a 10 ms instrumented heuristic → `maxInside === 1` and `interceptor.maxObservedCheckConcurrency === 1`; **single-flight fallthrough** — winner's bypass blocked on a test gate: loser resolves while `executor.released === false` (never waited), `path: 'fallthrough'`, exactly 2 executions (initial + plain re-issue, no reset), winner completes after release with `bypass.entries === 1`; terminated loser skips the re-issue (:198); **cookie-clear-before-bypass** — settings seeded `a=1; b=2`, executor's entry snapshot reads `''` (jar untouched — FMD2 clears `m.Settings.HTTP.Cookies` only); **reload re-issue** — `Storage['reload']='true'` → `reset()` called, 2 executions, the re-issue's Cookie header carries `cf_clearance=bypassed`, settings cookies+UA persisted (:181-183); without reload → 1 execution, no reset, result = bypass result (:178); **AllowServerErrorResponse forced** (:156) — caller set false, execution recorded true; plus heuristic matrix vs `checkantibot.lua` (403/429/503 × text/html × cloudflare/ddos-guard, case-insensitivity, negatives), failed/throwing bypass → `result=false` + settings stay cleared, stub/known-broken executor short-circuits plain (:149-153, heuristics never run), bypass-internal HTTP re-enters the interceptor without deadlock (global lock released before bypass execution, :94-115 vs :159). | met |
| Bypassed cookies+UA persist across a service restart (persistence round-trip) | `persistence.test.ts`: interceptor bypass persists `module_state` row (`{cookies: 'cf_clearance=bypassed', ua: 'BypassUA/1.0'}`) → NEW `ModuleStateService` over the SAME store rehydrates jar + settings.userAgent + options + storage; a pre-existing store seeds a fresh service (disk-like restart); **functional proof over the loopback mock server** — post-restart download succeeds on the PLAIN path with no bypass executor wired, because the rehydrated clearance cookie is in the jar (server only 200s with `cf_clearance=bypassed`). | met |
| No lock held across any injected user callback (lock-held-during-callback detector in tests) | `locks.ts` `LockHoldTracker`: every AsyncMutex/AsyncRWLock hold is tracked **per async context** (AsyncLocalStorage; enter always lands in the acquirer's context — waiter-side `.then` for queued grants), `assertIdle(where)` = the detector called at every injection point where control crosses into user code (bypass executor entry, per-download completion, event-user-callback wrappers); `module-state.test.ts` detector describe: holds visible inside lock scopes with labels, **negative control** (a deliberately broken `cookies.write` wrapper that spans a callback → `assertIdle` throws `/lock held across user callback/` — the detector is not vacuous), service paths pass; cross-worker semantics proven: a concurrent worker's legitimate hold never fails another worker's assertion (12-parallel test wraps each event in `tracker.inContext`), `assertGloballyIdle` catches leaks at quiescence (unbalanced enter/exit). | met |

## Implementation notes

- **Locking discipline (§5.3/D12)**: promise-queued locks model the
  cross-worker serialization (workers message the host-side service); sync
  facade-path reads/writes stay JS-atomic. The RW lock is write-preferring
  (a queued writer bars new readers — no starvation). Per-key mutexes are
  created lazily and persist per key — key A never waits behind key B.
- **Single-flight fallthrough** (`BypassGate.tryEnter` = TryEnterCriticalSection):
  the concurrent loser re-issues the plain request (:197-200) — download
  workers never serialize behind an in-progress bypass; the gate is held
  across the whole bypass INCLUDING the reload re-issue, exactly like FMD2's
  Guardian (:161-191).
- **Interceptor result semantics** mirror `WebsiteBypassRequest` exactly:
  result is overwritten by the bypass result (:178), settings cookies are
  cleared BEFORE the attempt and only restored by a successful bypass
  (:177/:182), `AllowServerErrorResponse` is forced once and left on (:156).
- **BypassExecutor** is the pluggable seam (§5.9 item: "stub/known-broken by
  default; sidecar adapter later"): `available=false` short-circuits to the
  plain request like FMD2 with the chunks absent (:149-153); executor
  exceptions degrade to a failed bypass (WebsiteBypassGetAnswer's catch,
  :135-138).
- **Detector contexts**: the "no lock across user callback" invariant is
  per-execution-path — a global "process is lock-free" assertion is invalid
  under D12, so the tracker uses AsyncLocalStorage and tests wrap each
  simulated event in `tracker.inContext`; `assertGloballyIdle` remains for
  quiescence leak detection.
- **Persistence boundary**: `PersistedModuleState` (`cookies` ';'-joined
  FMD2 form, `ua`, `enabled`, `options`, `storage`) + `InMemoryModuleStatePersistence`;
  the service seeds module bundles from `loadAll()` on first `forModule`
  and writes rows on bypass persistence / `flush()`. `settings.cookies` is
  the persisted mirror of the jar (the interceptor syncs it on bypass
  success, :182) — FMD2-faithful; the SQLite `module_state` adapter lands
  with the db stories.
- **Loopback tests vs DESIGN §13**: the mock 403-server runs on 127.0.0.1
  (loopback explicitly allowed by the zero-network guard; external network
  stays forbidden).

## Verification log

```
npx vitest run server/test/engine/state  → 3 files, 43 passed (43)  [×6 runs, stable]
npx eslint server/src/engine/state server/test/engine/state → clean
npx tsc -b tsconfig.json → zero errors under server/src/engine/state + server/test/engine/state
```

Pre-existing full-suite failures (crypto shims, ixqvalue, ComicK e2e,
init-pass golden) belong to parallel in-flight tasks — none of them imports
`engine/state` (grep-verified); the placeholder `module-state.ts` exports
(`ModuleStateSnapshot`, `emptySnapshot`) are kept for compatibility.
