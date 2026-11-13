# Evidence — tsk-ethereal-flatboat-waits (Generated event runtime: binding tables from contract.json, watchdog, engine recycling)

Date: 2026-11-13T05:50Z (review-bounce fixes 06:10Z) · Environment: node v24, wasmoon 1.16.0, linux · TDD throughout

## Review-bounce fixes (quixotic-windmill-remembers verdict, all 4 blockers addressed)

1. `supervisor.test.ts:119/:255` — `expect()` does not narrow `SupervisedExecution`;
   replaced both bare `expect(outcome.failureKind)` accesses with a typed narrowing
   helper `assertFailed(outcome)` (`Extract<SupervisedExecution, {status:'failed'}>`
   that throws on non-failed outcomes). TS2339 gone; test semantics unchanged.
2. `bindings-golden.test.ts:92` — the corruption-test `mutate` helper now builds the
   mutated row **field-by-field** with `patch.x ?? src.x` over a `RowPatch` type whose
   keys carry no `undefined` (exactOptionalPropertyTypes-safe); no more
   Partial-spread `T | undefined` props. `SanityRow` imported explicitly.
3. `bindings-golden.test.ts:104` — the duplicate-row test extracts `rows[0]` with an
   explicit `undefined` guard (noUncheckedIndexedAccess-safe) before spreading.
4. Repo CI gate — `tsc -b server` now reports **zero errors in story-owned files**
   (bindings-golden, supervisor.test, chapter-pipeline, tools/, smoke). The one
   remaining `dispatcher.ts(267)` `ModuleStateService.get` error belongs to the
   in-flight state-service story (their §5.3 merge wiring, uncommitted);
   `dispatcher.test.ts` runs green against their merged code (32/32).

Verification after fixes: `vitest run server/test/engine/events server/test/engine/pipeline
server/test/smoke.test.ts` → **92/92 green**; scoped `eslint` → clean; `contract:check` →
`OK — 0 mismatches`.

## Scope

`server/src/engine/events` (generated bindings, supervisor), `server/src/engine/pipeline`
(ChapterPipeline/ImageWorker/markers), `server/tools` (codegen), plus the CI wiring
(`scripts/ci.sh`, `server/tsconfig.json`, `server/package.json`).

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Generated binding table equals contract.json (build-time assertion + golden test); CI contract:check green | `server/tools/render-bindings.ts` (pure renderer: SHA-256 fingerprint header, sorted `EventGlobalName` literal union, typed rows, inline sanity assertion) + `server/tools/generate-bindings.ts` CLI (`npm run gen:bindings -w @fmd/server`) — the CLI runs `assertEventRowsSanity` **before** writing, so a corrupt contract document fails the build step loud. The committed `server/src/engine/events/bindings.generated.ts` is regenerated output (15 rows). `bindings-golden.test.ts` (13 tests): deep-equal to contract.json rows, **byte-identical** renderer-drift check against the committed file, dispatcher default table `toBe` the generated table, global-union coverage (13 names, PAGENUMBER-only readBack row pinned, BeforeDownloadImage the pushOnly row), and 7 corruption cases the sanity assertion rejects (MODULE-first, duplicate rows, unbound/URL readBack, pushOnly+readBack, bad constants). The dispatcher consumes the generated table with a compile-time drift guard: the `bindGlobals` switch ends in `const unhandled: never = name` — a new global in contract.json widens the union and **fails the build** until handled (dispatcher.ts:216-224). The runtime `require.resolve`+`readFileSync` contract.json load was **removed** from dispatcher.ts. `npm run contract:check` → `contract drift-check: OK — 0 mismatches`; also wired into `scripts/ci.sh` as a gate step. | met |
| Fault-injection tests: hang→deadline→abort→job fail; double-hang→worker recycle; LUA_ERRMEM→quarantine+retry-once→engine_oom | `supervisor.test.ts` (10 tests) with scripted FAKE engines (`AttemptOutcome` scripts per engine, dispose/create recorded): interrupted (HTTP-aborted) deadline miss → `failed(net)`, **0 strikes**, worker survives, no dispose; first wedged (non-HTTP) miss → strike 1, still no recycle; **double wedged miss → engine disposed + rebuilt, job fails `worker_stalled`, strikes reset** (lifecycle `['disposed']`, `engine-2` installed, log = 2×deadline-missed → worker-recycled → engine-rebuilt); **LUA_ERRMEM → quarantine + rebuild, retry completes → `done(attempts:2)`** (engine 1 disposed, engine 2 live); **retry OOMs again → `failed(engine_oom)` after exactly 1 retry** (2 engines both disposed; supervisor stays lazy, rebuilds only on next use); hang→deadline→abort→job-fail proven end-to-end by the real-engine tests in `dispatcher.test.ts` §4 block (`TrackingAbortHandle`: exactly 1 `abort()` call, `terminated=true`, blocking `sleep(10000)` interrupted under a 150 ms deadline). RSS budget (§5.12): `rssRecycleThresholdBytes` = budget × 1.25; probe over threshold → `rss-recycle` + rebuild **before** the attempt; at threshold → no recycle; 2 GB default asserted. Strike ledger resets on a completed event. | met |
| 'W'/'D' marker semantics unit-tested on the ChapterPipeline abstraction (skip/resume/recount cases) | `server/src/engine/pipeline/markers.ts` (constants + classification; `'' ≡ 'W'` per :994) + `chapter-pipeline.ts` (TTaskThread/TTaskContainer equivalent) + `image-worker.ts` (DownloadImage :350-407 contract with injected hooks) + `chapter-pipeline.test.ts` (24 tests): **skip** — ImageWorker short-circuits `'' → mark 'W' + skip` (:352-355), `'W' → skip` (:356-357), `'D' → skip success` (:358-359), no download calls recorded; **resume** — padding to PageNumber with 'W' (:849-856), fresh-chapter 'W' placeholder (:1205-1211), empty pagelink re-resolution back to 'W' (:1236-1243), CheckForExists reconcile (file → 'D', 'D'-without-file → 'W', dynamic → 'G', non-dynamic 'G' → 'W') (:1040-1063), chapter-level skip of 'D' chapters (:1133-1136) with 'P'/'F' upkeep (:1119-1318), and two full restart scenarios (killed run resumes with only non-'D' slots downloading; deleted file → 'W' → **page-link phase re-resolution → re-download**); **recount** — resolved-'D' slots skipped by both scans count toward progress (:933-949, :951-968), `newlyDone` recount from reconcile, `missingCount`/`isFinished` = CheckForFinish (:1067+), per-phase counter reset (:1181-1182, :1224-1225). Also: container-link override (:375-379), BeforeDownloadImage result discarded per FMD2 (:370-378), AfterImageSaved result is the final Result (:408-410), hook exceptions surface as `failed` not throws, Terminated checks (:403-404). | met |
| Wrong-return-type coercion covered (boolean coerced per lua_toboolean semantics etc.) | `dispatcher.test.ts` "return-kind coercion" describe (12 tests) against the **real** wasmoon engine: code row (lua_tointeger per `LuaWebsiteModules.pas:209/238/260`) — boolean `true`/`false` → **0** (not convertible), numeric string `'2'` → **2** (string conversion), non-numeric string → 0, nothing/nil → 0; boolean row (lua_toboolean per :165/183/…) — string `'yes'` → **true**, number **0** → true (0 is truthy in Lua), empty string → true, table `{}` → true, nil/nothing → false; string row SaveImage (luaToString = lua_tolstring, `LuaUtils.pas:206-210`) — number `123` → `'123'`, boolean → `''` (NULL → empty), nothing → `''`. | met |

## Implementation notes

- **Generation, not hand-coding (§5 implementation rule)**: contract.json remains the
  single source of truth. Chain of enforcement: Pascal extractor ↔ contract.json
  (`contract/tools/drift-check.ts`, CI `contract:check`) and contract.json ↔ generated TS
  (`bindings-golden.test.ts` byte-identity + `assertGeneratedBindingsSanity` at module
  load in `bindings.ts`). The generated file is committed so fresh clones build without a
  pre-pass; regeneration is `npm run gen:bindings -w @fmd/server`.
- **EngineSupervisor** (`supervisor.ts`): the §4 wedged-worker watchdog policy and the D6
  OOM policy as an engine-agnostic state machine (`SupervisorEngine` is the seam for both
  the real worker adapter and the fault-injection fakes). Distinguishes **interrupted**
  deadline misses (HTTP-abort unblocked the worker → `net` failure, worker survives) from
  **wedged** ones (non-HTTP hang → strike; `WORKER_STALL_TOLERANCE=2` → recycle +
  `worker_stalled`). OOM: quarantine → rebuild → retry-once → `engine_oom`; the supervisor
  is pool-safe (lazy rebuild after a terminal quarantine, `dispose()` idempotent).
  RSS budget default 2 GB, recycle at floor(budget×1.25), probe injectable — the
  worker_threads pool wiring (Phase 3) passes its live RSS.
- **Queued-request fail-fast**: the deadline expiry path invokes the injected
  `HttpAbortHandle` (§4) — the same handle the HTTP client checks before starting a queued
  request; the full HTTP queue integration lands with the §5.4 HTTP shim story.
- **Test counts (this story)**: 92 scoped tests green (`dispatcher` 32, `bindings-golden` 13,
  `supervisor` 10, `chapter-pipeline` 24, `smoke` 15 …) plus the previously-existing
  engine/facade suites unaffected.

## Workspace state notes

- Two failures in the full-suite run at evidence time are **sibling stories' in-flight
  work**, not this task: `server/test/engine/lua/init-pass.test.ts` golden mismatch
  (`init-pass.ts` has uncommitted sibling edits adding `totalDirectory`; their golden file
  is not updated yet) and `server/test/engine/e2e/*` (untracked sibling files,
  tsk-retro-cyclone-kicks). Excluding those, the suite is green (295/296 → the 296th is the
  sibling golden). Sibling lint/typecheck errors (`shims/*`, `normalize/udata.ts`) are
  likewise outside this task; **all files touched by this task are eslint- and
  tsc-clean**.
