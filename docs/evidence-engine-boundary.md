# Evidence — hermetic engine boundary (tsk-linear-varnish-restricts)

Companion to `docs/ENGINE-BOUNDARY.md`. Everything below was produced by
commands re-runnable from the repo root at the state this story committed
(the exact command is noted per section). Zero user-visible behavior change:
the moved code is verbatim modulo import paths + the documented inversions.

## 1. App→engine import map — BEFORE (HEAD at story start)

Command:
`git grep -nE "from '[^']*engine/(lua|shims|events|state|registry|pipeline|normalize|sidecar)" HEAD -- 'server/src' ':!server/src/engine' | grep -v "\.test\.ts:"`

**89 deep (non-door) engine imports outside `server/src/engine`** —
condensed per consuming file:

| app file | deep engine imports (pre-story) |
|---|---|
| runtime/assembly.ts | http-egress, http-pipeline, http-proxy, http-transport, http-hostgate, state/module-state, registry/startup, registry/module-sync, registry/persistence, registry/capabilities, **lua/host (wasmoon composition)**, sidecar/bypass-adapter |
| runtime/engine-info.ts | lua/abort, lua/logger, **lua/host**, shims/install, shims/http-shim, shims/http-proxy, shims/txquery-shim, normalize/udata, registry/capabilities, state/module-state, sidecar/bypass-adapter |
| runtime/download-engine.ts | same driver set as engine-info |
| runtime/account-login.ts | same driver set (minus proxy/udata) |
| catalog/directory-walk.ts | same driver set + shims/http-hostgate |
| sync/modules/validate.ts | **lua/host, lua/chunk-cache**, lua/abort, shims/install, shims/http-shim |
| sync/modules/service.ts | lua/logger |
| api/services.ts | registry/capabilities |
| catalog/live-scrape-store.ts | registry/capabilities, normalize/fmdstrings |
| jobs/download/{types,download-runner,image-worker-pool}.ts | pipeline/chapter-pipeline, pipeline/markers |
| jobs/download/http-downloader.ts | shims/http-headers, shims/http-pipeline |
| jobs/library/merge.ts | **lua/tstrings** |
| accounts/account-service.ts | state/persistence |
| tools/import/{appdb,fmd2-modules,fmd2-crypto}.ts | state/persistence, shims/crypto-core |
| server/src/index.ts | **lua/worker-pool**, shims/index, state/module-state, events/bindings, events/supervisor, pipeline/{markers,chapter-pipeline,image-worker} |

Lua-named type imports outside engine (from `@fmd/contract`):
runtime/download-engine.ts, runtime/engine-info.ts, runtime/account-login.ts,
catalog/directory-walk.ts, sync/modules/service.ts, sync/modules/validate.ts
(`LuaHost`, `LuaEngine`, `LuaHostFactory`, `LuaModuleDescriptor`,
`EventDispatcher`, `HostLogger`, `LuaChunkCache` — the pre-decoupling shape
the contract carried).

## 2. App→engine import map — AFTER (this story)

Command:
`grep -rn "engine/facade.js\|engine/index.js" server/src --include="*.ts" | grep -v "^server/src/engine/" | grep -v "\.test\.ts"`

**Every app-layer engine import now goes through a door** — zero deep, zero
wasmoon, zero Lua-named (RULE `no-lua-outside`: green):

- static `engine/facade.js` (types + wasmoon-free provider values):
  api/services, catalog/live-scrape-store, jobs/download/{types,
  download-runner,image-worker-pool}, jobs/library/merge, runtime/assembly,
  runtime/download-lane, sync/modules/service, accounts/account-service,
  tools/import/{appdb,fmd2-modules,fmd2-crypto}, server/src/index.ts
- lazy `await import('engine/index.js')` (the four designed lazy sites —
  each inside an async construction path so a substituted substrate never
  evaluates wasmoon):
  - runtime/assembly.ts:342 — the default substrate fallback
    (`options.substrate ?? …createModuleRuntime()`)
  - runtime/assembly.ts:407 — `StartupRegistryService` inside `bootRegistry()`
  - runtime/download-lane.ts:713 — default download-hooks factory
  - sync/modules/service.ts:129 — `validateStagedLuaTree` inside `sync()`
- `engine/index.js` static: server/src/index.ts only (the package surface,
  which re-exports the doors for tools/tests)

## 3. CI dependency gates + negative mutation tests

`scripts/ci.sh` (after `typecheck`):

```
==> engine boundary gate (facade-only door; no Lua outside engine; engine-inward deps; domain-shaped facade)
bash scripts/engine-boundary-gate.sh        # exit 0 — clean tree

==> engine boundary mutation tests (each rule must fire on a planted violation)
bash scripts/engine-boundary-mutate.sh
mutation[app-deep-import]:  RULE facade-only   fired as expected   # runtime probe importing engine/shims/http-hostgate.js
mutation[wasmoon-outside]:  RULE no-lua-outside fired as expected   # catalog probe importing wasmoon
mutation[lua-named-type]:   RULE no-lua-outside fired as expected   # observability probe importing LuaHost
mutation[engine-app-import]:RULE engine-inward  fired as expected   # engine/services probe importing ../../api/errors.js
mutation[facade-lua-export]:RULE facade-hygiene fired as expected   # facade.ts appending `export type { LuaHost }`
engine-boundary mutation tests: all 5 rules proven to fire
```

Also green and unchanged: the eslint `no-restricted-imports` Lua-host
boundary (updated: the composition point moved from runtime/assembly.ts to
engine/services/module-runtime.ts), `scripts/design-gate.sh`, and
`npm run contract:check` (0 mismatches).

## 4. Domain-shape audit of the public surface

Every export of `server/src/engine/facade.ts`, with provenance. **Zero
Lua/Wasmoon-named exports (RULE `facade-hygiene`, machine-checked).**

| facade export | kind | provenance / rename |
|---|---|---|
| `ModuleHostFactory` | type | alias of engine-internal `LuaHostFactory` (engine/contract.ts) |
| `ModuleDescriptor` | type | alias of `LuaModuleDescriptor` |
| `ModuleOptionDescriptor`, `ModuleRegistry` | type | moved from @fmd/contract (engine/contract.ts), unchanged domain names |
| `EventDispatcher`, `EventDispatchResult`, `EventContext`, `EventTaskSeed`, `EventGlobalValue`, `EventDeadlineController` | type | the §5.2 event surface (moved from @fmd/contract; domain names unchanged) |
| `RegistrationRecord`, `ModuleCapabilities`, `KnownBrokenFlagId`, `KNOWN_BROKEN_FLAG_IDS` | type+const | registry/capabilities (domain) |
| `PersistedRegistry`, `ModuleRegistryPersistence`, `InMemoryModuleRegistryPersistence`, `BootSource`, `BootResult` | type+class | registry persistence/startup |
| `ModuleSyncOptions`, `FileSweepResult`, `SweepFailure`, `SweepSummary`, `SweepResult`, `ModuleTreeSweepPort` | type | registry/module-sync; the sweep CLASS crosses as type only |
| `StagedFileFailure`, `StagedTreeValidation`, `StagedInventoryEntry`, `StagedValidationOptions` | type | registry/staged-validation (moved in from sync/) |
| `EngineInfoOptions`, `ModuleInfoPort` | type | services/module-info (driver moved in from runtime/) |
| `EngineDownloadOptions`, `ModuleDownloadHooks` | type | services/download-hooks (driver moved in from runtime/) |
| `ModuleAccountStatusOrdinal`, `ModuleLoginCredentials`, `ModuleLoginOutcome`, `ModuleLoginPort`, `EngineLoginSessionOptions` | type | services/account-session (moved in from runtime/; the accounts-layer port is satisfied structurally) |
| `DirectoryWalkPort`, `RawDirectoryEntry`, `EngineDirectoryWalkerOptions` | type | services/directory-walk (moved in from catalog/) |
| `ModuleRuntime` | type | **the substrate swap surface** (services/module-runtime.ts) |
| `ChapterModuleHooks`, `TaskWriter`, `FetchedImage`, `ImageFetchResult`, `ImageDownloader`, `CancelToken` | type | services/download-ports (moved in from jobs/download/types.ts — the §7.1 module seam the engine implements) |
| `ChapterPipeline`, `NO_WORK`, `PipelineWorkId`, `PAGE_LINK_*`, `CHAPTER_*`, `is*Marker` | class+const+type | engine/pipeline (the download-task resume contract) |
| `ModuleImageDownloaderOptions`, `ModuleImageDownloader` | type+class | services/image-fetch — **rename: `HttpImageDownloader` → `ModuleImageDownloader`** (moved in from jobs/download/http-downloader.ts) |
| `EgressPolicy` | class | shims/http-egress (provider default; domain name kept) |
| `HttpTransportPort`, `ProxyConfig`, `normalizeProxyConfig`, `LoopbackHttpTransport`, `SyncHostGate`, `HostGatePort`, `setDefaultRequestTimeoutMs`, `BypassExecutorPort`, `FlareSolverrBypassExecutor` | type+class+fn | the shim-provider contracts the app satisfies/injects |
| `ModuleSharedState`, `ModuleStateService`, `SwallowSharedDeduper`, `createHostLogBuffer`, `HostLogBuffer` | type+class+fn | state/txquery/logging providers — **rename: `createMemoryLogger` → `createHostLogBuffer`** (sync-layer consumer) |
| `PersistedModuleState`, `ModuleStatePersistence`, `InMemoryModuleStatePersistence` | type+class | state/persistence ports (accounts/tools adapters) |
| `decryptString`, `encryptString` | fn | shims/crypto-core (legacy FMD2 appdb codec; domain names unchanged) |
| `LegacyStringTable`, `compareLegacyText` | class+fn | **renames: `PascalTStrings` → `LegacyStringTable`, `compareText` → `compareLegacyText`** (lua/tstrings — the FMD2 string-table codec; consumer: jobs/library/merge) |
| `fmdLowerCase` | fn | **rename: `pascalLowerCase` → `fmdLowerCase`** (normalize/fmdstrings; consumer: catalog/live-scrape-store) |
| `QueryEngine`, `QueryEngineResult` | type | re-export from @fmd/contract (the §5.6 expression-engine surface the corpus replays) |

Production door (`engine/index.ts`) additions — deliberately NOT on the
wasmoon-free facade, consumed lazily: `createModuleRuntime`,
`ModuleTreeSweep` (rename of `ModuleSyncService`) + `sortRegistrations`,
`validateStagedLuaTree` + `StagedInitError`, `StartupRegistryService`, the
service classes (`EngineInfoService`, `EngineDownloadHooks`,
`EngineLoginSession`, `EngineDirectoryWalker`), `moduleAccountStatusOrdinal`,
`normalizeDirectoryEntries`, `MAX_DIRECTORY_PAGES`, and the engine extras
(worker-pool, shims/index, events/bindings+supervisor) the package surface
re-exports.

**Renames ledger (mechanism → domain):** `LuaHostFactory`→`ModuleHostFactory`,
`LuaModuleDescriptor`→`ModuleDescriptor`, `ModuleSyncService`→`ModuleTreeSweep`,
`HttpImageDownloader`→`ModuleImageDownloader`, `PascalTStrings`→`LegacyStringTable`,
`compareText`→`compareLegacyText`, `pascalLowerCase`→`fmdLowerCase`,
`createMemoryLogger`→`createHostLogBuffer`. The Lua-named originals remain
engine-internal (`engine/contract.ts`, `engine/lua/tstrings.ts`, …) where
they are the substrate's own vocabulary.

**Moved inside the engine** (mechanism, app files deleted):
`runtime/engine-info.ts`→`engine/services/module-info.ts`,
`runtime/download-engine.ts`→`engine/services/download-hooks.ts`,
`runtime/account-login.ts`→`engine/services/account-session.ts`,
`catalog/directory-walk.ts`→`engine/services/directory-walk.ts`,
`jobs/download/http-downloader.ts`→`engine/services/image-fetch.ts`,
`sync/modules/validate.ts`→`engine/registry/staged-validation.ts`.
Inversions introduced: engine services throw the contract's `ApiError`
(moved INTO @fmd/contract — the typed §10 envelope is a cross-boundary
domain shape) and return contract's `NormalizedInfo` (also moved in);
`ChapterModuleHooks`/`TaskWriter` and the image-fetch view types moved
engine-side (the engine implements them; jobs re-exports from the facade);
the account-status ordinal clamp lives engine-side
(`moduleAccountStatusOrdinal`) and satisfies the accounts port structurally.

## 5. API-response hygiene (verified — no change)

- Error envelope: engine services + api handlers throw the same contract
  `ApiError` (`{status, code: ApiErrorCode, message, details?}`); the
  fastify error handler renders the §10 envelope unchanged. Spot-verified
  by the full api test suite (jobs/info/accounts/modules) passing byte-for-
  byte behavior (2022 server tests green).
- Result envelopes: `/api/info` returns `NormalizedInfo` (contract);
  job failures carry the `JobFailureKind` taxonomy; dispatch results are
  `EventDispatchResult` — all typed domain reasons.
- Documented in `docs/ENGINE-BOUNDARY.md` §"API-response hygiene":
  engine-log tails inside failure messages are log TEXT (HostLogRecord
  lines), never Lua values.

## 6. Stub-substrate swap proof — test transcript

`npx vitest run server/test/runtime/stub-substrate.test.ts --reporter=verbose`:

```
✓ stub-substrate swap proof (engine boundary: no Lua gets in) > the substrate never constructed a module host (opaque factory untouched) 1ms
✓ … > /healthz + /readyz pass on the stub boot 62ms
✓ … > /api/modules serves the STUB registry rows 5ms
✓ … > /api/info round-trips the SCRIPTED result (no Lua anywhere) 5ms
✓ … > a job enqueue/cancel round-trips through the stub boot 8ms
✓ … > the stub info service was disposed on drain (substrate lifecycle respected) 68ms
Test Files  1 passed (1) — Tests  6 passed (6)
```

Canary validation (throwaway probe, not committed): under the same
`vi.mock('wasmoon', …throw…)` a dynamic import of `engine/index.js` (the
production door) fails with `CANARY FIRED` — the mock provably intercepts,
so the green stub boot means wasmoon was never evaluated on its path.

## 7. Full gate status at story completion

| gate | result |
|---|---|
| `npm run contract:check` | 0 mismatches |
| `npm run lint` | green |
| `npm run typecheck` | green |
| `npm test` (server) | 2022 passed — incl. the new stub proof + the re-seamed lane/registry suites |
| `npm test` (web) | pre-existing in-flight v0.3.0 UX WIP failures (web/test/pagination, downloads-feed, browse-list-polish) — proven pre-existing: they fail identically with the web/ WIP stashed; this story touches zero web files |
| `bash scripts/engine-boundary-gate.sh` | green (4 rules) |
| `bash scripts/engine-boundary-mutate.sh` | all 5 mutations fire |
| `bash scripts/design-gate.sh` | green |
| `npm run corpus` + artifact diff | 912/912 = 100.00%, `git diff --exit-code -- docs/COMPAT.md docs/corpus-report.json` clean (byte-stable) |
