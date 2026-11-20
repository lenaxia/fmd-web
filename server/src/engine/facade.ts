/**
 * THE ENGINE FACADE — the only door (engine-boundary story,
 * tsk-linear-varnish-restricts).
 *
 * App layers (api, jobs, runtime, sync, catalog, web, and the top-level
 * entry files) import ENGINE artifacts from THIS module (or
 * @fmd/contract for the cross-boundary domain types) and from NOWHERE
 * else under server/src/engine — the CI dependency gate
 * (scripts/engine-boundary-gate.sh) makes "deep" engine imports a build
 * failure, and the mutation test proves each rule can fire.
 *
 * SURFACE RULES (machine-checked, see docs/ENGINE-BOUNDARY.md):
 *  - DOMAIN-SHAPED ONLY: every export is named for the domain (modules,
 *    events, sites, catalogs, downloads, legacy data) — never for the
 *    mechanism. Lua/Wasmoon-named types stay inside the engine
 *    (server/src/engine/contract.ts) and cross only under domain aliases.
 *  - WASMOON-FREE: this module's transitive VALUE graph contains no
 *    wasmoon evaluation — the stub-substrate boot test relies on it.
 *    The wasmoon-backed default substrate is constructed lazily through
 *    the production door (server/src/engine/index.ts → createModuleRuntime).
 *
 * Swap playbook: a future substrate implements the interfaces below
 * (ModuleRuntime is the whole construction surface) — nothing outside
 * server/src/engine moves.
 */

// ── module host substrate (opaque; the mechanism types stay internal) ──────
export type {
  LuaHostFactory as ModuleHostFactory,
  LuaModuleDescriptor as ModuleDescriptor,
  ModuleOptionDescriptor,
  ModuleRegistry,
} from './contract.js';

// ── event dispatch (§5.2 domain shapes) ─────────────────────────────────────
export type {
  EventDispatcher,
  EventDispatchResult,
  EventContext,
  EventTaskSeed,
  EventGlobalValue,
  EventDeadlineController,
} from './contract.js';

// ── registry domain (module tree, capabilities, staged validation) ─────────
export type {
  RegistrationRecord,
  ModuleCapabilities,
  KnownBrokenFlagId,
} from './registry/capabilities.js';
export { KNOWN_BROKEN_FLAG_IDS } from './registry/capabilities.js';
export type { PersistedRegistry, ModuleRegistryPersistence } from './registry/persistence.js';
export { InMemoryModuleRegistryPersistence } from './registry/persistence.js';
export type { BootSource, BootResult } from './registry/startup.js';
// StartupRegistryService (class) stays behind the production door for the
// same wasmoon-free reason (startup.ts → module-sync.ts → install → shims):
// the assembly constructs it lazily; only its types cross here.
export type {
  ModuleSyncOptions,
  FileSweepResult,
  SweepFailure,
  SweepSummary,
  SweepResult,
  ModuleSyncService as ModuleTreeSweep,
  ModuleTreeSweepPort,
} from './registry/module-sync.js';
// NOTE (wasmoon-free rule): ModuleTreeSweep/sortRegistrations (classes in
// module-sync.ts) and validateStagedLuaTree/StagedInitError
// (staged-validation.ts) are deliberately NOT re-exported as VALUES —
// their modules transitively import the shim installer (→ pb/pcre2
// shims → wasmoon). The sweep/validation CONSTRUCTION happens through
// the substrate (engine/services/module-runtime.ts, behind the
// production door) or a lazy `await import('../engine/index.js')`;
// only their TYPES cross here (type-only re-exports never evaluate
// the source module).
export type {
  StagedFileFailure,
  StagedTreeValidation,
  StagedInventoryEntry,
  StagedValidationOptions,
} from './registry/staged-validation.js';

// ── module services (the host drivers; moved inside by this story) ─────────
// NOTE (wasmoon-free rule): the driver CLASSES (EngineInfoService,
// EngineDownloadHooks, EngineLoginSession, EngineDirectoryWalker) are
// substrate internals — constructing them transitively imports the shim
// installer (→ wasmoon), so they are NOT re-exported as values. The
// production substrate (createModuleRuntime, behind the production
// door engine/index.ts) constructs them; stub substrates implement the
// PORT types below. Type-only re-exports never evaluate the source
// modules, keeping this facade's runtime graph wasmoon-free.
export type {
  EngineInfoOptions,
  ModuleInfoPort,
} from './services/module-info.js';
export type {
  EngineDownloadOptions,
  ModuleDownloadHooks,
} from './services/download-hooks.js';
export type {
  ModuleAccountStatusOrdinal,
  ModuleLoginCredentials,
  ModuleLoginOutcome,
  ModuleLoginPort,
  EngineLoginDriverOptions as EngineLoginSessionOptions,
} from './services/account-session.js';
export type {
  DirectoryWalkPort,
  RawDirectoryEntry,
  EngineDirectoryWalkerOptions,
} from './services/directory-walk.js';
export type { ModuleRuntime } from './services/module-runtime.js';

// ── download-task domain (§7.1 ports + the chapter pipeline) ────────────────
export type {
  ChapterModuleHooks,
  TaskWriter,
  FetchedImage,
  ImageFetchResult,
  ImageDownloader,
  CancelToken,
} from './services/download-ports.js';
export { ChapterPipeline, NO_WORK, type PipelineWorkId } from './pipeline/chapter-pipeline.js';
export {
  PAGE_LINK_WAITING,
  PAGE_LINK_DONE,
  PAGE_LINK_DYNAMIC,
  CHAPTER_PENDING,
  CHAPTER_DONE,
  CHAPTER_FAILED,
  isWaitingMarker,
  isDoneMarker,
  isDynamicMarker,
  isReadyMarker,
} from './pipeline/markers.js';
export type { ModuleImageDownloaderOptions } from './services/image-fetch.js';
export { ModuleImageDownloader } from './services/image-fetch.js';

// ── shim-provider contracts (the ports the app satisfies/injects) ──────────
export { EgressPolicy } from './shims/http-egress.js';
export type { HttpTransportPort } from './shims/http-shim.js';
export type { ProxyConfig } from './shims/http-proxy.js';
export { normalizeProxyConfig } from './shims/http-proxy.js';
export { LoopbackHttpTransport } from './shims/http-transport.js';
export { SyncHostGate, type HostGatePort } from './shims/http-hostgate.js';
export { setDefaultRequestTimeoutMs } from './shims/http-pipeline.js';
// [inbox-bounce] app-layer constants that previously deep-imported the
// shims (the engine-boundary gate's facade-only rule) — surfaced
// through the domain door like every other app-facing engine value.
export { ACCEPT_IMAGE_VALUE } from './shims/http-headers.js';
export { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from './shims/http-pipeline.js';
// [inbox-bounce] the thread-offload surface + the availability
// classifier/probe the runtime layer consumes — same facade-only rule.
export { EngineThread, offloadEngineSubstrate, probeOnEngineThread } from './services/engine-thread.js';
export { runRootUrlProbe, classifyHttpOutcome } from './services/availability.js';
export type { AvailabilitySink, SiteAvailabilityOutcome } from './services/availability.js';
export type { BypassExecutorPort } from './sidecar/bypass-adapter.js';
export { FlareSolverrBypassExecutor } from './sidecar/bypass-adapter.js';
export type { ModuleSharedState } from './state/module-state.js';
export { ModuleStateService } from './state/module-state.js';
export type { SwallowSharedDeduper } from './shims/txquery-shim.js';
export { createMemoryLogger as createHostLogBuffer, type MemoryLogger as HostLogBuffer } from './lua/logger.js';

// ── shared state persistence ports (accounts/tools provide adapters) ───────
export type { PersistedModuleState, ModuleStatePersistence } from './state/persistence.js';
export { InMemoryModuleStatePersistence } from './state/persistence.js';

// ── legacy FMD2 data codecs (import tool + library merge) ──────────────────
export { decryptString, encryptString } from './shims/crypto-core.js';
export { PascalTStrings as LegacyStringTable, compareText as compareLegacyText } from './lua/tstrings.js';
export { pascalLowerCase as fmdLowerCase } from './normalize/fmdstrings.js';

// ── query-engine domain types (the §5.6 expression engine surface; the
//    implementations live engine-side, the corpus replays the same types) ──
export type { QueryEngine, QueryEngineResult } from '@fmd/contract';
