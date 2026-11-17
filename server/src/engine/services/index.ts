/**
 * Service-class re-export barrel (engine PRODUCTION door only): these
 * constructions transitively import the shim installer (→ wasmoon), so
 * the wasmoon-free facade re-exports only their PORT types. Consumers
 * that need the concrete classes reach them through
 * server/src/engine/index.js (lazily) — never the facade.
 */
export { EngineInfoService } from './module-info.js';
export { EngineDownloadHooks } from './download-hooks.js';
export { EngineLoginSession, moduleAccountStatusOrdinal } from './account-session.js';
export {
  EngineDirectoryWalker,
  normalizeDirectoryEntries,
  MAX_DIRECTORY_PAGES,
} from './directory-walk.js';
