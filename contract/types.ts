/**
 * fmd-web boundary contract — DESIGN.md §5 (FMD2 compatibility contract).
 *
 * NON-NEGOTIABLE: every cross-boundary type in the whole repository is
 * defined (or re-exported) here. Later workspaces import from
 * `@fmd/contract`; nothing may redefine a boundary locally.
 *
 * The §5.2 event-binding table lives as DATA in `contract.json`
 * (validated by `schema/contract.schema.json`); the types below describe
 * that document and the core domain boundaries (jobs, lanes, health).
 */

/** 32-hex module ID — the join key across modules, catalogs and DB rows. */
export type ModuleId = string;

/** Job identifier (SQLite `job.id`). */
export type JobId = string;

/** Job lanes with independent concurrency (DESIGN.md §4). */
export type LaneId = 'info' | 'download' | 'update' | 'sync';

/**
 * Persisted job state machine (DESIGN.md §7.1):
 * `queued → running → retry → done | failed(...) | cancelled`.
 */
export type JobTerminalState = 'done' | 'failed' | 'cancelled';

export type JobState = 'queued' | 'running' | 'retry' | JobTerminalState;

/** Failure kinds carried by `state = failed` (DESIGN.md §4, §7.3). */
export type JobFailureKind = 'worker_stalled' | 'engine_oom' | 'net' | 'pack';

/** FMD2 net-status constants bound for code-returning events (§5.2). */
export type NetStatusCode = 0 | 1 | 2;

/** How an event's Lua return value is interpreted (§5.2 return protocol). */
export type EventReturnKind = 'code' | 'boolean' | 'string';

/**
 * Which status-constant table a dispatcher binds before the call (§5.2):
 * `net-status` (no_error/net_problem/information_not_found via
 * `LuaPushNetStatus`), `account-status` (asUnknown/asChecking/asValid/
 * asInvalid via `LuaPushAccountStatus`), or `none`.
 */
export type ConstantBinding = 'net-status' | 'account-status' | 'none';

/** HTTP methods the API surface uses (§10); `WS` is the websocket hub. */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'WS';

/** One row of the §5.2 event-binding table. */
export interface EventBinding {
  /** Dispatcher name, e.g. `GetDirectoryPageNumber` (the `Do*` method). */
  readonly event: string;
  /** Return protocol for this event. */
  readonly returns: EventReturnKind;
  /**
   * Exact globals bound for the call, in binding order. `MODULE` is
   * always first — bound for every event by the module handler
   * (LuaWebsiteModuleHandler.pas:47–49). There is no `ACCOUNT` anywhere.
   */
  readonly globals: readonly string[];
  /**
   * Globals the host READS BACK after the call. Only `PAGENUMBER` is
   * ever read back (§5.2); `URL` is never read back.
   */
  readonly readBack: readonly string[];
  /** Globals that are push-only (never read back) — e.g. `BeforeDownloadImage`. */
  readonly pushOnly?: boolean;
  /** Which status-constant table the dispatcher binds (§5.2). */
  readonly constants: ConstantBinding;
}

/** Access mode of a `TASK` field in the image pipeline (§5.2, LuaDownloadTask.pas). */
export type TaskFieldAccess = 'read-write' | 'read-only';

/** Value kind of a `TASK` field. */
export type TaskFieldKind = 'list' | 'int' | 'string';

/** One `TASK` field spec (in/out contract of the image pipeline). */
export interface TaskField {
  readonly name: string;
  readonly access: TaskFieldAccess;
  readonly kind: TaskFieldKind;
}

/** Status of a require-able shim implementation (§5.7 table). */
export type ShimStatus = 'planned' | 'partial' | 'stub';

/** One row of the §5.7 require table. */
export interface RequireShim {
  /** Lua-side require name, e.g. `fmd.crypto` or `pb`. */
  readonly require: string;
  /** The FMD2 Pascal unit this shim replaces. */
  readonly fmd2Unit: string;
  /** fmd-web implementation note. */
  readonly implementation: string;
  readonly status: ShimStatus;
}

/** Per-module capability flag (§5.10, published via /api/modules). */
export interface CapabilityFlag {
  readonly id: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
}

/** Read/write mode of a facade property (§5.1, §5.4–§5.7). */
export type PropertyAccess = 'read-only' | 'read-write';

/** How Lua reaches a facade object (§5.3–§5.7). */
export type FacadeAccess =
  | 'global-constructor'
  | 'event-global'
  | 'module-property'
  | 'require-lib'
  | 'derived-object';

/** One named entry of a facade's method/constructor surface. */
export interface FacadeMethod {
  readonly name: string;
  readonly notes?: string;
}

/** One property (plain or bracket/array-indexed) of a facade. */
export interface FacadeProperty {
  readonly name: string;
  readonly access: PropertyAccess;
  readonly notes?: string;
}

/** A named default header set installed by an HTTP reset method (§5.4). */
export interface FacadeHeaderSet {
  readonly name: string;
  readonly headers: readonly string[];
  readonly notes?: string;
}

/**
 * One object surface of the compatibility contract (§5.3–§5.7):
 * TXQuery, IXQValue, TStrings, MangaInfo, Storage, HTTP, Crypto,
 * ImagePuzzle, Duktape.
 */
export interface FacadeTable {
  /** Lua-side surface name, e.g. `TXQuery` or `Crypto`. */
  readonly name: string;
  /** The FMD2 Pascal unit implementing the surface. */
  readonly fmd2Unit: string;
  /** Source citation, e.g. `LuaXQuery.pas:192-201`. */
  readonly source: string;
  /** How Lua reaches the facade. */
  readonly access: FacadeAccess;
  /** Exact method names (registration-table order where extractable). */
  readonly methods: readonly FacadeMethod[];
  /** Plain properties. */
  readonly properties: readonly FacadeProperty[];
  /** Bracket-indexed/array properties. */
  readonly arrayProperties?: readonly FacadeProperty[];
  /** The default bracket property (`obj['key']`) when one exists. */
  readonly defaultArrayProperty?: {
    readonly access: PropertyAccess;
    readonly notes?: string;
  };
  /** Constructor entry points (class-level `New`/`Create`/global function). */
  readonly constructors?: readonly FacadeMethod[];
  /** Named default header sets (HTTP only, §5.4). */
  readonly headerSets?: readonly FacadeHeaderSet[];
  /** Fixed defaults the shim must reproduce (HTTP: RetryCount=0, MaxRedirect=5). */
  readonly defaults?: Readonly<Record<string, string | number | boolean>>;
  /** Behavioral notes (error semantics, jail rules, dialect constraints). */
  readonly notes?: string;
}

/** One ordered step of the §5.8 GetInfo post-processing pipeline. */
export interface PipelineStep {
  readonly order: number;
  readonly name: string;
  readonly description: string;
  /** Source citation, e.g. `uData.pas:154-173`. */
  readonly source?: string;
}

/** §5.8 GetInfo post-processing pipeline (applied after `OnGetInfo` = no_error). */
export interface GetInfoPipeline {
  /** Source citation for the whole pipeline. */
  readonly source: string;
  /** Duplicate-chapter rule; always `last-occurrence-wins` (§5.8 step 4). */
  readonly dedup: 'last-occurrence-wins';
  /** The ordered steps; `order` is 1-based and strictly increasing. */
  readonly steps: readonly PipelineStep[];
}

/** Machine-readable metadata about the contract document itself. */
export interface ContractMeta {
  readonly designVersion: string;
  readonly source: string;
  readonly groundTruth: string;
  readonly schema: string;
}

/** FMD2 status constant tables (§5.2). */
export interface StatusConstants {
  readonly netStatus: Readonly<Record<'no_error' | 'net_problem' | 'information_not_found', NetStatusCode>>;
  readonly accountStatus: readonly ['asUnknown', 'asChecking', 'asValid', 'asInvalid'];
}

/** The whole machine-readable §5 contract document (contract/contract.json). */
export interface ContractDocument {
  readonly $schema: string;
  readonly meta: ContractMeta;
  readonly statusConstants: StatusConstants;
  /** Exactly the 15 §5.2 dispatchers, verified against LuaWebsiteModules.pas. */
  readonly events: readonly EventBinding[];
  /** Module object surface from §5.1 (LuaWebsiteModules.pas:991–1039). */
  readonly moduleSurface: readonly string[];
  /** `TASK` in/out contract fields (§5.2, LuaDownloadTask.pas:21–32). */
  readonly taskFields: readonly TaskField[];
  /** `MANGAINFO` fields (§5.2). */
  readonly mangaInfoFields: readonly string[];
  /** Object surfaces §5.3–§5.7 (TXQuery … Duktape). */
  readonly facades: readonly FacadeTable[];
  /** §5.8 GetInfo post-processing pipeline (last-occurrence-wins dedup). */
  readonly getInfoPipeline: GetInfoPipeline;
  /** §5.7 require-able shim table. */
  readonly requireShims: readonly RequireShim[];
  /** §5.10 capability flags (known-broken classes in v1). */
  readonly capabilities: readonly CapabilityFlag[];
  /** Behavioral invariants CI checks against the parsed Pascal dispatchers (§13.5). */
  readonly invariants: readonly string[];
}

/** `/healthz` response boundary (§10). */
export interface HealthStatus {
  readonly status: 'ok';
  readonly version: string;
}

/** `/readyz` response boundary (§10). */
export interface ReadinessStatus {
  readonly ready: boolean;
  readonly reason?: string;
}

/** One API route spec (§10) — placeholder route table in server/src/api. */
export interface RouteSpec {
  readonly method: ApiMethod;
  readonly path: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Lua host boundary (DESIGN.md §5.1, §5.2, §5.12, §11 engine/lua + events)
// ---------------------------------------------------------------------------

/** One structured log record emitted by `print` (§5.1, LuaBase.pas:60-77). */
export interface HostLogRecord {
  readonly level: 'log' | 'warn' | 'error';
  /** Module id the record is attributed to (`''` outside module scope). */
  readonly moduleId: ModuleId;
  readonly message: string;
}

/** Structured logger sink for the Lua host (print/error routing). */
export interface HostLogger {
  readonly records: readonly HostLogRecord[];
  write(record: HostLogRecord): void;
}

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
  loadFile(fileName: string, source: string): Promise<readonly LuaModuleDescriptor[]>;
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
}

/** One per-worker wasmoon engine (§5.12 topology). */
export interface LuaEngine {
  /**
   * Load a module file's cached chunk into a fresh state and run its top
   * level (module switch semantics, `LuaWebsiteModuleHandler.pas:33-54`).
   */
  loadModule(fileName: string): Promise<void>;
  /** Full GC collection (stepped by the dispatcher every N calls). */
  gcCollect(): void;
  /** Dispatch-call counter since the last GC step. */
  readonly callsSinceGc: number;
  dispose(): Promise<void>;
}

/** The typed Lua host: chunk cache + registry + engines + dispatchers. */
export interface LuaHost {
  readonly chunkCache: LuaChunkCache;
  readonly registry: ModuleRegistry;
  /** Create one per-worker engine (fresh Lua state). */
  createEngine(logger?: HostLogger): Promise<LuaEngine>;
  /**
   * Attach the dispatcher to an engine: `abort` receives deadline expiry,
   * `sleep(ms)` blocks the caller's thread and is interruptible.
   */
  createDispatcher(engine: LuaEngine, abort: HttpAbortHandle, deadline?: EventDeadlineController): EventDispatcher;
}
