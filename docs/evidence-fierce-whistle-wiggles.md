# Evidence — tsk-fierce-whistle-wiggles (Lua host: chunk cache, Init pass, typed event dispatcher, deadlines)

Date: 2026-11-13T01:40Z · Environment: node v24.20.0, wasmoon 1.16.0, linux

## Scope

`server/src/engine/lua` + `server/src/engine/events` — the typed Lua host per
DESIGN §5.1, §5.2, §5.12, with boundary types in `contract/types.ts`
(`LuaHost`, `LuaEngine`, `LuaChunkCache`, `ModuleRegistry`,
`EventDispatcher`, `EventDeadlineController`, `HttpAbortHandle`, plus the
descriptor/result types).

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Init pass on ≥10 seed modules produces typed descriptors matching a committed golden JSON | `server/test/engine/golden/init-pass.golden.json` (committed): **20 modules over 19 files** — 16 real FMD2 modules (`11Toon.lua` … `YoungAceUp.lua`, require-free, diverse Init bodies incl. Desu limits, DynastyScans `TotalDirectory`, Comicaso/Manta `AddOptionEdit`) + 3 fixtures (`options-showcase.lua` — all four option kinds incl. combobox INDEX default 2 + AccountSupport; `multi-module.lua` — 2 registrations from one file; `dropped-modules.lua` — missing-ID/Name registrations dropped, valid one survives). IDs verified against the real `.lua` sources (e.g. `11Toon` = `c7b742a4dc8a451fa95baec1aa183b39`). Regenerate: `UPDATE_GOLDEN=1`. `init-pass.test.ts` also proves case-sensitivity + unknown-property silent no-ops (§5.1 LuaClass semantics), `print` attribution, and the `no function name "Init()"` error path. | met |
| Dispatcher unit tests: 3 code events, 11 boolean events, SaveImage string, PAGENUMBER read-back, URL not read back, constant sets per row from contract.json | `dispatcher.test.ts` (20 tests): binding-table shape asserted FROM `contract.json` (15 rows; code rows = GetDirectoryPageNumber/GetNameAndLink/GetInfo; 11 booleans; string rows = SaveImage; readBack ⊆ {PAGENUMBER} only; no ACCOUNT global anywhere). Per-row dispatch proves: codes (0/2 + constant arithmetic `no_error+net_problem+information_not_found=3`), all 11 booleans incl. nil→false, SaveImage string return, `PAGENUMBER` read-back (changed value, and nil→null), URL push-only (module mutation not read back, no readBack key), net-status constants bound on exactly the 3 code rows, account-status (`asUnknown=0…asInvalid=3`) on exactly Login/AccountState/CheckSite, none on the other 9. UPDATELIST/TASK/MANGAINFO facade shapes driven from Lua incl. `MANGAINFO.Artist` typo no-op. `EventNotBoundError` for unknown events / unbound modules. Lua-error → `failed` (timedOut=false). GC stepping across 20 calls. | met |
| Deadline test: event exceeding the deadline is failed and the injected abort handle was called; a blocking sleep is interruptible via the same path | `dispatcher.test.ts` §4 describe-block: handler `sleep(10000)` under a 150 ms deadline → result `failed(timedOut=true)`, elapsed < 5 s (sleep **interrupted**, watchdog thread → `Atomics.notify` on the shared cells → `blockingSleep` throws → Lua error → failed); the injected `TrackingAbortHandle` recorded **exactly 1** `abort()` call and `terminated=true`. A within-deadline event completes with **0** abort calls (watchdog cancelled cleanly). `sleep(120)` blocks the thread ≥110 ms (truly blocking, `Atomics.wait`). | met |
| Chunk cache: same SHA reuses compiled chunk; changed file invalidates | `chunk-cache.test.ts` (6 tests): `compileCount` proves one compile per (file, SHA) — same source → cached chunk identity (`toBe`), distinct files independent, changed content → new SHA + recompile, explicit `invalidate` recompiles, and bytecode round-trips into two fresh engine states (`lua_dump` → `luaL_loadbufferx(mode 'b')`, Lua 5.4 signature `\1bLua`). | met |

## Implementation notes

- **Chunk cache** (`chunk-cache.ts`): FMD2 parity with
  `LuaWebsiteModules.pas:713-733` — bytecode dumped once per module file
  (`lua_dump` with a wasm writer callback), cached by (fileName, sha256);
  states load it via `luaL_loadbufferx(..., 'b')`
  (`LuaWebsiteModuleHandler.pas:33-54` fresh state on module switch).
- **lua_gc stepping**: wasmoon's wasm build does not export `lua_gc`;
  `gcCollect()` runs `collectgarbage("collect")` twice after >15 dispatches
  — the same LUA_GCCOLLECT entry point (`LuaHandler.pas:136-141`).
- **Init pass** (`init-pass.ts` + `module-facade.ts`): fresh state per file,
  §5.1 base globals (`print`/`sleep`/`CreateTXQuery`(stub)/`Trim`/
  `MaybeFillHost`/`MangaInfoStatusIfPos`/`GetBetween`/`SeparateLeft`/
  `SeparateRight`), `NewWebsiteModule` only while `Init()` runs (state is
  discarded + global nil'd), multi-module files, missing-ID/Name dropped.
  Facades are metatable-driven with JS get/set per facade id — unknown keys
  silently no-op, keys case-sensitive (LuaClass.pas:94-169). Options API
  with combobox INDEX semantics; Storage KV; Account only when
  `AccountSupport=true`.
- **Event dispatcher** (`dispatcher.ts`): binds from `contract.json`
  (loaded via package export, cast to `ContractDocument`) — never
  hand-coded. `MODULE` bound every event (same facade object per module per
  engine state, FMD2 `LuaPushMe`); row globals bound exactly; constants per
  row kind; return protocol by row `returns`; read-back only for
  `readBack: ['PAGENUMBER']`; URL push-only.
- **Deadline** (`deadline.ts` + `abort.ts`): a watchdog `worker_threads`
  thread arms a chunked `Atomics.wait` timer per dispatch; on expiry it
  writes the expired token + Terminated flag into a SharedArrayBuffer and
  notifies the sleeper cell — this is the only way to reach a Lua thread
  blocked in `sleep` (postMessage cannot run while the thread is blocked).
  The controller then invokes the injected `HttpAbortHandle`
  (`HTTP.Terminated` semantics) and the event fails `timedOut`.
- **Pascal-parity helpers** (`pascal-strings.ts`): ports of synautil
  `SeparateLeft/Right`, `GetBetween` (nesting-aware incl. fallback
  branches), `Trim` (+ char set), uBaseUnit `MaybeFillHost` over the full
  `SplitURL` port (proto/port/cleanuri steps, 1-based poschar semantics —
  unit-tested against Pascal edge cases incl. bare-host and
  protocol-relative behavior), `MangaInfoStatusIfPos` with exact output
  constants ('1'/'0'/'2'/'3'/'Unknown') and `|-alternatives`.

## Gate outputs

```
==> typecheck  (tsc -b)         exit 0
==> lint      (eslint .)        exit 0
==> test      (vitest run)      10 files, 147 tests, all passing, offline
npm run test:coverage           lines 83.93% / branches 79.01% / functions 84.54%
                                (thresholds 75/65/80 — enforced, no errors)
```

New test files: `server/test/engine/lua/{chunk-cache,init-pass,pascal-strings,facades}.test.ts`,
`server/test/engine/events/dispatcher.test.ts` (dispatcher + deadline).

## Boundary notes

- `contract/types.ts` gained the Lua-host boundary block (appended);
  the working tree also carries a parallel session's additive type work
  (facades/ConstantBinding) which my code compiles against — both are in
  the committed types.ts; their contract.json/tools corpus changesets
  belong to the contract story and are left uncommitted by this story.
- The init-pass test resolves the seed set via `FMD2_LUA_DIR` with a
  findUp fallback (`FMD2/lua`), matching the drift-check convention.
