/**
 * THE ENGINE PRODUCTION DOOR (engine-boundary story,
 * tsk-linear-varnish-restricts) — facade + the wasmoon-backed DEFAULT
 * substrate + the engine extras the package surface (server/src/index.ts)
 * re-exports for tools/tests (worker pool, shim table, event bindings,
 * supervisor).
 *
 * Doors into the engine (the only two the CI dependency gate allows):
 *  - server/src/engine/facade.js — the wasmoon-FREE domain surface (the
 *    stub-substrate boot test imports this statically; no wasmoon module
 *    is ever evaluated on a substituted path).
 *  - server/src/engine/index.js — THIS module: everything above PLUS the
 *    concrete substrate constructors. Production code loads the default
 *    substrate LAZILY (`await import('../engine/index.js')`) so a
 *    substituted runtime keeps wasmoon off its path.
 */
export * from './facade.js';
export { createModuleRuntime } from './services/module-runtime.js';
// Lazily-consumed constructions (wasmoon-pulling; the facade re-exports
// only their types): the registry sweep/validation/boot classes the
// assembly + sync layer import on demand.
export { ModuleSyncService as ModuleTreeSweep, sortRegistrations } from './registry/module-sync.js';
export { validateStagedLuaTree, StagedInitError } from './registry/staged-validation.js';
export { StartupRegistryService } from './registry/startup.js';
export {
  EngineInfoService,
  EngineDownloadHooks,
  EngineLoginSession,
  EngineDirectoryWalker,
  moduleAccountStatusOrdinal,
  normalizeDirectoryEntries,
  MAX_DIRECTORY_PAGES,
} from './services/index.js';

// Engine extras on the package surface (tests/tools; wasmoon-carrying —
// they are NOT part of the domain facade and never cross to app layers).
export * from './lua/worker-pool.js';
export * from './shims/index.js';
export * from './events/bindings.js';
export * from './events/supervisor.js';
