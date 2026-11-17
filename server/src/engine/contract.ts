/**
 * ENGINE-INTERNAL host substrate contract (DESIGN.md §5.1/§5.2/§5.12) —
 * moved out of @fmd/contract by the engine-boundary story
 * (tsk-linear-varnish-restricts): these are the MECHANISM types of the
 * Lua substrate (chunks, facades, hosts, engines, dispatch wiring).
 * They never cross to app layers; the domain-shaped surface app code
 * may import lives in server/src/engine/facade.ts (aliased to
 * domain names). The cross-boundary observability types
 * (HostLogger/HostLogRecord) and the §5.2 wire constants
 * (NetStatusCode, ModuleId) stay in @fmd/contract and are imported
 * here — the one outward dependency engine code is allowed.
 */
import type { HostLogger, ModuleId, NetStatusCode } from '@fmd/contract';

/**
 * Compiled Lua chunk — FMD2 parity: bytecode dumped once per module file
 * and shared by every Lua state that runs it
 * (`LuaWebsiteModules.pas:713-733`).
 */
export interface LuaChunk {
  readonly fileName: string;
  /** SHA-256 (hex) of the source the bytecode was compiled from. */
  readonly sha256: string;
  /** The source the bytecode was compiled from (chunkname/error context). */
  readonly source: string;
  /** Lua 5.4 dumped bytecode, loadable with `luaL_loadbufferx(..., 'b')`. */
  readonly bytecode: Uint8Array;
}

/** Compile-once chunk cache keyed by file name + content SHA (§5.12). */
export interface LuaChunkCache {
  /**
   * Compile `source` once per (fileName, sha256); later calls with an
   * unchanged SHA return the cached bytecode without recompiling. A changed
   * source invalidates the entry and recompiles.
   */
  get(fileName: string, source: string): Promise<LuaChunk>;
  /** Compiled chunk for a file that already went through `get`, if any. */
  peek(fileName: string): LuaChunk | undefined;
  /** Drop one file's cached chunk (next `get` recompiles). */
  invalidate(fileName: string): void;
  /** Number of cached chunks. */
  readonly size: number;
  /** How many real compilations happened (observability for tests). */
  readonly compileCount: number;
}

// ─────────────────────────────────────────────────────────────────
// Lua facade bridge surface (§5.1 LuaClass.pas:94-169). The concrete
// FacadeBridge lives in the host implementation; these structural
// types are the contract-visible slice the shim hooks consume, so
// runtime code never imports host-internal (wasmoon-adjacent) types.
// ─────────────────────────────────────────────────────────────────

/** Facade table key (property name or bracket index). */
export type LuaFacadeKey = string | number;

/** Plain value crossing the facade bridge. */
export type LuaFacadeValue = string | number | boolean | null | undefined;

/** `get()` result: a plain value OR a method (JS functions become Lua functions). */
export type LuaFacadeGetResult = LuaFacadeValue | ((...args: never[]) => unknown);

/** Per-id get/set/len behavior supplied by a facade owner. */
export interface LuaFacadeSpec {
  get(key: LuaFacadeKey): LuaFacadeGetResult;
  set(key: LuaFacadeKey, value: LuaFacadeValue): void;
  len?(): number;
  /** Child facade id for a sub-object property, if this key is one. */
  sub?(key: LuaFacadeKey): number | undefined;
}

/**
 * Structural slice of the facade bridge: create/register facade specs.
 * The host's concrete bridge satisfies this structurally; shims and
 * other host-side code depend on this narrow interface only.
 */
export interface LuaFacadeBridge {
  /** Create a facade table (assigning the Lua global `target`; '' = unassigned). */
  create(target: string, spec: LuaFacadeSpec): number;
  /** Register a spec under an id whose table is created Lua-side. */
  register(id: number, spec: LuaFacadeSpec): void;
}

/**
 * Structural slice of a live Lua state the shim installer needs
 * (wasmoon's engine satisfies this structurally; test doubles only
 * implement these two members).
 */
export interface LuaStateSurface {
  global: { set(name: string, value: unknown): void };
  doStringSync(code: string): unknown;
}

/**
 * Hook run on a fresh state BEFORE a module chunk executes (§5.7 shim
 * wiring — modules `require` templates/utils at top level, so loaders
 * must be registered first, LuaPackage.pas order).
 */
export type LuaChunkSetup = (engine: LuaStateSurface, bridge: LuaFacadeBridge) => void;

/** One registered option (§5.1 options API; combobox stores the INDEX). */
export interface ModuleOptionDescriptor {
  readonly name: string;
  readonly kind: 'checkbox' | 'edit' | 'spinedit' | 'combobox';
  readonly defaultValue: boolean | string | number;
  /** Combobox items (comma-split from the items string); other kinds omit. */
  readonly items?: readonly string[];
}

/**
 * One module registration produced by the Init() pass (§5.1):
 * the typed projection of `NewWebsiteModule()` state, with registrations
 * missing `ID` or `Name` already dropped.
 */
export interface LuaModuleDescriptor {
  /** 32-hex module ID — the join key across modules, catalogs, DB rows. */
  readonly id: ModuleId;
  readonly name: string;
  readonly rootURL: string;
  readonly category: string;
  readonly accountSupport: boolean;
  /**
   * `MODULE.TotalDirectory` (§5.1 module surface): the static directory
   * page/category count for modules without OnGetDirectoryPageNumber.
   */
  readonly totalDirectory?: number;
  readonly options: readonly ModuleOptionDescriptor[];
  /** Event name (§5.2 rows) → Lua handler global the module assigned. */
  readonly eventHandlers: Readonly<Record<string, string>>;
  /** The module file this registration came from. */
  readonly sourceFile: string;
}

/** Module discovery + lookup (§5.1 Init phase). */
export interface ModuleRegistry {
  /**
   * Init pass for one module file: fresh Lua state, base globals, chunk
   * from the cache, `NewWebsiteModule()` available only during `Init()`,
   * multi-module files supported, missing-ID/Name dropped.
   */
  loadFile(fileName: string, source: string, extraSetup?: LuaChunkSetup): Promise<readonly LuaModuleDescriptor[]>;
  /** All successfully registered descriptors, in file-then-registration order. */
  readonly modules: readonly LuaModuleDescriptor[];
  byId(id: ModuleId): LuaModuleDescriptor | undefined;
}

/**
 * Cooperative cancellation handle (§4): `abort()` sets `HTTP.Terminated`
 * semantics and fails queued-but-not-started requests fast.
 */
export interface HttpAbortHandle {
  abort(reason?: string): void;
  readonly terminated: boolean;
  readonly reason: string | undefined;
}

/**
 * Values the dispatcher pushes as event globals and/or reads back
 * (§5.2). Only `PAGENUMBER` is ever read back; `URL` is push-only.
 */
export type EventGlobalValue = number | string | boolean | null;

export interface EventContext {
  /** `URL` global (page number for GetNameAndLink, chapter URL elsewhere). */
  readonly url?: string;
  /** Initial `PAGENUMBER` (read back after GetDirectoryPageNumber). */
  readonly pageNumber?: number;
  readonly workPtr?: number;
  readonly workId?: number;
  /** `PATH` global (SaveImage). */
  readonly path?: string;
  /** `FILENAME` global (SaveImage, AfterImageSaved). */
  readonly fileName?: string;
  /**
   * Host-provided TASK seed (§5.2 download events): FMD2's TASK object
   * is the persistent download task — PageLinks carry the previous
   * state into GetImageURL (the module reads the container URL at
   * [WORKID-1] and writes the resolved image URL back). The host
   * pre-seeds the facade from the pipeline state and reads the backing
   * after the call (the dispatcher's readTask accessor).
   */
  readonly task?: EventTaskSeed;
}

/** Host-side TASK seed/readback snapshot (dispatcher-managed backing). */
export interface EventTaskSeed {
  readonly pageLinks?: readonly string[];
  readonly pageContainerLinks?: readonly string[];
  readonly fileNames?: readonly string[];
  readonly pageNumber?: number;
  readonly link?: string;
}

/** Outcome of one dispatched event (§5.2 return protocol). */
export type EventDispatchResult =
  | {
      readonly kind: 'code';
      readonly value: NetStatusCode;
      /** Globals read back after the call (contract.json `readBack`). */
      readonly readBack: Readonly<Record<string, EventGlobalValue>>;
    }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      /** True when the wall-clock deadline expired (§4). */
      readonly timedOut: boolean;
    };

/**
 * Per-event wall-clock deadline controller (§4, §5.12): runs `fn` under a
 * deadline enforced by a watchdog thread; expiry calls the injected
 * abort handle (Terminated semantics) and interrupts blocking `sleep`
 * calls so the event fails.
 */
export interface EventDeadlineController {
  /**
   * Shared interrupt cells (sleep waits on them; the watchdog notifies at
   * expiry — synchronous signaling across the thread boundary).
   */
  readonly cells: Int32Array;
  /**
   * Run `fn` (synchronous, may block in `sleep`) under `deadlineMs`.
   * On expiry the watchdog sets Terminated semantics in shared memory,
   * wakes the sleeper, and the outcome reports `timedOut`; the injected
   * abort handle is invoked on detection.
   */
  run<T>(deadlineMs: number, abort: HttpAbortHandle, fn: () => T): {
    readonly value: T | undefined;
    readonly threw: boolean;
    readonly error: unknown;
    readonly timedOut: boolean;
  };
  /** Stop the watchdog thread. */
  dispose(): void;
}

/** Event dispatch (§5.2): binding table from contract.json, never hand-coded. */
export interface EventDispatcher {
  /**
   * Dispatch one §5.2 event row for a module descriptor: binds `MODULE`
   * plus the row's exact globals, the row's status constants, calls the
   * handler assigned in the descriptor, and interprets the return value
   * by the row's `returns` kind (codes / booleans / SaveImage string,
   * PAGENUMBER read back, URL never).
   */
  dispatch(
    descriptor: LuaModuleDescriptor,
    event: string,
    context?: EventContext,
  ): EventDispatchResult;
  /**
   * Host-side TASK read-back (§5.2 download events): the module-writable
   * backing of the LAST dispatched event — the GetPageNumber/GetImageURL
   * flow reads PageLinks + PageNumber out of it. Empty seed when the
   * last event bound no TASK.
   */
  readTask(): Required<EventTaskSeed>;
}

/** One per-worker wasmoon engine (§5.12 topology). */
export interface LuaEngine {
  /**
   * Load a module file's cached chunk into a fresh state and run its top
   * level (module switch semantics, `LuaWebsiteModuleHandler.pas:33-54`).
   * `preChunkSetup` runs on the fresh state BEFORE the chunk (§5.7 shim
   * wiring — see {@link LuaChunkSetup}).
   */
  loadModule(fileName: string, preChunkSetup?: LuaChunkSetup): Promise<void>;
  /**
   * Evaluate a Lua snippet in the live module state (synchronous,
   * host-side read-backs — MANGAINFO/NAMES/LINKS field reads, the same
   * access the e2e golden harness uses). Throws when no module is
   * loaded.
   */
  doStringSync(code: string): unknown;
  /** Full GC collection (stepped by the dispatcher every N calls). */
  gcCollect(): void;
  /** Dispatch-call counter since the last GC step. */
  readonly callsSinceGc: number;
  dispose(): Promise<void>;
}

/** §5.2 MODULE.Account seed (login dispatch; modules.json Account state). */
export interface LuaAccountSeed {
  readonly enabled: boolean;
  readonly username: string;
  readonly password: string;
  /** Prior-session cookie text (seeded, handler may rewrite). */
  readonly cookies?: string;
  /** Prior-session status ordinal (asUnknown…asInvalid). */
  readonly status?: number;
}

/**
 * Structural cookie-jar port (§5.3/§5.4 shared cookie state): the
 * module-state service's SharedCookieJar satisfies this structurally;
 * the shims and the dispatcher's MODULE cookie methods depend on the
 * narrow interface, never on the concrete service.
 */
export interface LuaCookieJarPort {
  get(name: string): string;
  set(name: string, value: string): void;
  remove(name: string): void;
  clear(): void;
  addServerCookie(setCookie: string): void;
  readonly size: number;
}

/** Optional shim hooks the dispatcher binds (§5.4/§5.2). */
export interface LuaDispatcherShims {
  /** Fresh request-scoped HTTP facade per event call (FMD2 LoadObject). */
  readonly makeHTTP?: (bridge: LuaFacadeBridge) => LuaFacadeSpec;
  /** Host-level account credentials reached as MODULE.Account (§5.2). */
  readonly account?: LuaAccountSeed;
  /**
   * The §5.3 per-module cookie store resolver (audit F-2): the MODULE
   * cookie methods run over the jar this returns — the same shared jar
   * the HTTP shims back request cookie injection with. Undefined → a
   * private per-engine jar.
   */
  readonly moduleCookies?: (moduleId: string) => LuaCookieJarPort | undefined;
}

/**
 * Constructs Lua hosts (and isolated compile-only chunk caches). The
 * composition root (server/src/runtime/assembly.ts) builds the one
 * concrete wasmoon-backed factory and injects it wherever hosts are
 * needed; runtime/engine code depends on this interface only, so test
 * doubles substitute without touching the runtime.
 */
export interface LuaHostFactory {
  /** Create a Lua host bound to a logger (per call/sweep/run). */
  createHost(logger: HostLogger): LuaHost;
  /** Isolated compile-only cache (staged-tree parse checks, §5.1). */
  createChunkCache(): LuaChunkCache;
}

/** The typed Lua host: chunk cache + registry + engines + dispatchers. */
export interface LuaHost {
  readonly chunkCache: LuaChunkCache;
  readonly registry: ModuleRegistry;
  /** Create one per-worker engine (fresh Lua state). */
  createEngine(logger?: HostLogger): Promise<LuaEngine>;
  /**
   * Attach the dispatcher to an engine: `abort` receives deadline expiry,
   * `sleep(ms)` blocks the caller's thread and is interruptible. `shims`
   * carries the optional §5.4/§5.2 hooks (request-scoped HTTP objects,
   * MODULE.Account seed, the §5.3 shared cookie jar).
   */
  createDispatcher(
    engine: LuaEngine,
    abort: HttpAbortHandle,
    deadline?: EventDeadlineController,
    shims?: LuaDispatcherShims,
  ): EventDispatcher;
  /** Release host-held resources (SIGTERM drain). */
  dispose(): Promise<void>;
}
