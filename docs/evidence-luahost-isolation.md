# Evidence — LuaHost/LuaEngine contract isolation (tsk-able-steeple-tints)

**Refactor:** runtime/engine code depends exclusively on the
`LuaHost`/`LuaEngine` (and facade/dispatcher-shim) interfaces declared in
`contract/types.ts`. The concrete `WasmoonLuaHost` is constructed only at
the composition/wiring layer (`server/src/runtime/assembly.ts` via
`WasmoonLuaHostFactory`) and injected as the contract `LuaHostFactory`.

## Criterion 1 — imports only from contract; no WasmoonLuaHost/wasmoon outside host impl + wiring

Grep sweep over `server/src` for `from 'wasmoon' | WasmoonLuaHost |
lua/host.js | lua/engine.js` — matches ONLY in:

- `server/src/engine/lua/**` (host implementation)
- `server/src/engine/events/dispatcher.ts` (host implementation)
- `server/src/engine/shims/{crypto,gzip,imagepuzzle,pb,pcre2}-shim.ts` (host implementation)
- `server/src/engine/sidecar/subprocess-stub.ts` (host implementation)
- `server/src/runtime/assembly.ts` (composition root)

Runtime/engine modules import Lua types only from `@fmd/contract`:
`runtime/engine-info.ts`, `runtime/account-login.ts`,
`runtime/download-engine.ts`, `catalog/directory-walk.ts`,
`engine/registry/module-sync.ts`, `sync/modules/validate.ts`.

Enforced by a new eslint `no-restricted-imports` boundary block
(`eslint.config.js`, scoped to `server/src/**` with the host-impl +
assembly allowlist). Negative probe verified: a scratch file importing
`wasmoon` + `engine/lua/host.js` outside the allowlist produced both
errors; the probe was removed afterwards.

## Criterion 2 — constructed only in composition root; test double substitutable

- `WasmoonLuaHostFactory implements LuaHostFactory` (contract) lives in
  `engine/lua/host.ts`; `assembly.ts` builds it once
  (`createLuaHostFactory()`) and injects it at all six consumption sites:
  RegistrySweep, module sync service (staged-tree validation),
  EngineInfoService, EngineDirectoryWalker, download-lane engine deps,
  EngineLoginDriver.
- Runtime services take a REQUIRED `hostFactory` option typed
  `LuaHostFactory` — no default, no direct construction.
- NEW `server/test/runtime/lua-host-injection.test.ts`: a fully scripted
  `FakeLuaHost`/`FakeLuaEngine`/`FakeDispatcher` (implementing only the
  contract interfaces) substituted through the same injection seam —
  EngineInfoService GetInfo + §5.8 MANGAINFO reads, EngineLoginDriver
  OnLogin + MODULE.Account read-back, ModuleSyncService sweep isolation —
  **3/3 passing, zero engine code modified**.

Contract surface extended additively in `contract/types.ts`:
`LuaFacadeKey/Value/GetResult/Spec`, `LuaFacadeBridge`,
`LuaStateSurface`, `LuaChunkSetup`, `LuaAccountSeed`, `LuaCookieJarPort`,
`LuaDispatcherShims`, `LuaHostFactory`; `LuaEngine.loadModule(preChunkSetup?)`,
`LuaEngine.doStringSync`, `LuaHost.createDispatcher(shims?)`,
`LuaHost.dispose()`, `ModuleRegistry.loadFile(extraSetup?)`,
`EventDispatcher.readTask()`.

## Criterion 3 — typecheck, lint, tests pass with the new dependency direction

- `npx tsc -b tsconfig.json`: zero errors in every file this refactor
  touched (src + tests). Pre-existing errors remain in OTHER in-flight
  sessions' uncommitted files (`server/test/api/auth-token.test.ts`,
  `favorites-batch-transfer.test.ts`, `runtime.test.ts`, `web/*`) —
  verified absent at a pristine HEAD worktree and unrelated to the Lua
  boundary.
- `npm run lint`: all refactored files + the new boundary rule clean; the
  single repo error is in `web/e2e/arrival-experience.spec.ts` (an
  untracked other-session file).
- `npx vitest run server/test`: **157 files / 1684 tests passed, 0
  failed** (3 live tests skipped by design) — includes the 417-module
  registry sweep, e2e golden suites, shims, dispatcher, sync validation,
  and the new injection suite.
- `npm run contract:check`: `contract drift-check: OK — 0 mismatches`.

## Criterion 4 — no behavior change

- `git diff` over every characterization dir
  (`server/test/engine/{lua,shims,e2e,events,golden,normalize,pipeline}`):
  **zero modifications** — all passed unmodified in the run above.
- Semantics preserved mechanically: `WasmoonLuaHost.createDispatcher(
  engine, abort, deadline?, shims?)` delegates to the same
  `createContractDispatcher` with the host's logger (the exact per-call
  instance callers used to pass — each service builds its host with its
  own logger); `WasmoonLuaEngine.doStringSync` delegates to
  `innerEngine.doStringSync` (identical throw-when-unloaded); hooks and
  shim installers are retyped to structurally-identical contract types
  (`LuaStateSurface`/`LuaFacadeBridge`) with no runtime change.

## Files (this change)

- Contract: `contract/types.ts`
- Host impl: `engine/lua/{host,engine,facade,init-pass}.ts`,
  `engine/events/dispatcher.ts`,
  `engine/shims/{install,http-shim,http-cookies,txquery-facade}.ts`
- Runtime/engine: `runtime/{engine-info,account-login,download-engine,assembly}.ts`,
  `catalog/directory-walk.ts`, `engine/registry/module-sync.ts`,
  `sync/modules/{service,validate}.ts`, `tools/smoke/smoke.ts`
- Guard: `eslint.config.js`
- Tests: NEW `server/test/runtime/lua-host-injection.test.ts`; wiring-only
  edits (factory argument) in `accounts/account-login-engine.test.ts`,
  `catalog/directory-walk.test.ts`,
  `engine/registry/{sweep,isolation,persistence}.test.ts`,
  `sync/modules/{fetch-fallback,staged-tolerance,module-sync-config,module-sync.integration}.test.ts`
