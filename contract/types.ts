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
 *
 * The zod wire schemas (`./schemas.js`) are the shared REST/WS source —
 * §10 job payloads and the `/ws` protocol (D19/D21) — re-exported here
 * so every workspace imports the whole boundary from `@fmd/contract`.
 */
export * from './schemas.js';
export * from './tolerance.js';

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
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'WS';

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
export type ShimStatus = 'planned' | 'partial' | 'stub' | 'implemented';

/**
 * How the shim loader (server/src/engine/shims/lua-require.ts) serves a
 * §5.7 require name:
 * - `host-lib` — a registered host lib table (`libs` map, `AddLib` parity)
 * - `package-preload` — installed through `package.preload`
 * - `file-chunk` — resolved from the synced lua/ tree by the file searcher
 * - `none` — not served at all (the require errors)
 */
export type RequireShimServedBy = 'host-lib' | 'package-preload' | 'file-chunk' | 'none';

/**
 * One row of the shim loader registry (§5.7) — the machine-readable
 * projection of what `installRequireShim` actually registers. This is
 * the single source of truth for `requireShims[].status` in
 * contract.json: the CI drift check fails on any divergence, so the
 * contract statuses are derived, never hand-edited.
 */
export interface RequireShimRegistryEntry {
  /** Lua-side require name (the contract.json row key). */
  readonly require: string;
  /** Key the loader registers under (null = not registered). */
  readonly loaderKey: string | null;
  readonly servedBy: RequireShimServedBy;
  readonly status: ShimStatus;
  /** Required exactly when status is `partial`: the uncovered surface. */
  readonly gap?: string;
}

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

// ─────────────────────────────────────────────────────────────────
// D5 filename policy (DESIGN.md §14 D5) — the single choke point both
// filename resolvers share (server/src/jobs/library/filenames.ts,
// server/src/jobs/download/filenames.ts).
//
// DEFAULT (flags unset): deliberate Windows-desktop parity — the D5
// semantics FMD2 ships on the Windows desktop (tail-truncation over
// `CurrentMaxFileNameLength`; 0 = no limit) are reproduced byte-for-byte.
//
// OPT-OUT (`FMD_NORMALIZE_PATHS=1` or the CLI alias `--normalize-paths`):
// sanitized Linux-normalized paths — the same symbol sanitization
// upstream, then control units (C0 + DEL) are deleted (a Linux filename
// may hold any byte except `/` and NUL; the control sweep is the
// Linux-native hygiene FMD2's Windows path never does) and the
// Windows-desktop tail truncation is NOT applied.
// ─────────────────────────────────────────────────────────────────

/** Which D5 semantics a filename resolution applies. */
export type FileNamePolicyMode = 'windows-parity' | 'linux-normalized';

/** The env switch (exactly `1` enables; every other value keeps parity). */
export const FMD_NORMALIZE_PATHS_ENV = 'FMD_NORMALIZE_PATHS';

/** The CLI alias (presence anywhere on the command line enables). */
export const FMD_NORMALIZE_PATHS_FLAG = '--normalize-paths';

/**
 * True when the D5 Linux-normalized opt-out was requested via env
 * (`FMD_NORMALIZE_PATHS=1`) or the `--normalize-paths` CLI alias.
 */
export function normalizePathsRequested(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (env[FMD_NORMALIZE_PATHS_ENV] === '1') {
    return true;
  }
  return argv.some((entry) => entry === FMD_NORMALIZE_PATHS_FLAG);
}

/** The effective D5 mode for the current process (or explicit inputs). */
export function fileNamePolicyMode(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): FileNamePolicyMode {
  return normalizePathsRequested(env, argv) ? 'linux-normalized' : 'windows-parity';
}

export interface FileNamePolicyRequest {
  /** Explicit mode override; omitted = resolve from env/argv. */
  readonly mode?: FileNamePolicyMode | undefined;
  /** `CurrentMaxFileNameLength` analog; 0/absent = no limit (parity only). */
  readonly maxLength?: number | undefined;
}

/**
 * Delete the C0 control units (#0–#31) and DEL (#127) — the
 * Linux-normalized hygiene step. Everything else (including Unicode
 * whitespace and astral characters) is kept: Linux filenames may hold
 * any byte except `/` (already deleted by the shared sanitization
 * upstream) and NUL (deleted here).
 */
export function linuxNormalizeFileName(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * THE D5 CHOKE POINT. Both filename resolvers hand their (sanitized)
 * candidate here as the final step; neither re-implements mode logic.
 *
 * - `windows-parity` (default, flags unset): exact
 *   uDownloadsManager.pas:543-550 tail truncation — over a positive
 *   `maxLength` the HEAD is deleted, the TAIL survives; 0 = no limit.
 *   Byte-identical to the pre-switch behavior.
 * - `linux-normalized` (opt-out): control units deleted, `maxLength`
 *   IGNORED — tail truncation is the Windows-desktop quirk the opt-out
 *   exists to turn off.
 */
export function applyFileNamePolicy(name: string, request: FileNamePolicyRequest = {}): string {
  const mode = request.mode ?? fileNamePolicyMode();
  if (mode === 'linux-normalized') {
    return linuxNormalizeFileName(name);
  }
  const max = Math.trunc(request.maxLength ?? 0);
  if (!(max > 0) || name.length <= max) {
    return name;
  }
  return name.slice(name.length - max);
}

// ---------------------------------------------------------------------------
// §13.1 — Ground-truth corpus replay (pluggable QueryEngine boundary)
// ---------------------------------------------------------------------------

/** Document kind a corpus fixture records (the HTTP response body). */
export type QueryDocumentKind = 'html' | 'xml' | 'json';

/**
 * Query dialects harvested from FMD2's Lua ecosystem (§13.1): plain
 * XPath/XQuery, `json(...)` node-tree forms, and `css()` selectors —
 * all evaluated by FMD2's single TXQuery surface (InternetTools).
 */
export type QueryLanguage = 'xpath' | 'xquery' | 'css' | 'json';

/**
 * How the Lua side consumes a TXQuery result — the method shape decides
 * it (`XPath` → node iteration, `XPathString` → scalar, `*All(expr, list)`
 * → list fill, `XPathCount` → count).
 */
export type QueryOutputMode = 'scalar' | 'list' | 'count' | 'all';

/** One statically harvested (or captured) query expression. */
export interface QueryExpression {
  /** Stable id within its fixture/module scope. */
  readonly id: string;
  /** The expression text as FMD2 passes it to TXQuery. */
  readonly expression: string;
  readonly language: QueryLanguage;
  readonly output: QueryOutputMode;
}

/**
 * An opaque parsed document handed out by {@link QueryEngine.parse}.
 * Engines own their representation; the runner only carries it back.
 */
export interface ParsedQueryDocument {
  readonly kind: QueryDocumentKind;
  /** Engine-private handle. */
  readonly handle: unknown;
}

/**
 * Result of one evaluated expression with FMD2 swallow semantics
 * (XQueryEngineHTML.pas: try/except → empty): engines report
 * expression-level failures as `ok: false`, they do not throw.
 * `scalar` is the string() projection, `list` the string sequence,
 * `count` the XPathCount projection (0 when empty).
 */
export type QueryEngineResult =
  | {
      readonly ok: true;
      readonly scalar: string;
      readonly list: readonly string[];
      readonly count: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Pluggable query engine for offline corpus replay (§13.1): the live
 * implementation backs onto FontoXPath + linkedom behind the §5.7
 * dialect shim; tests use a deterministic mock. Only this boundary is
 * visible to the corpus runner.
 */
export interface QueryEngine {
  /** Engine identity, recorded verbatim in replay reports. */
  readonly name: string;
  /** Parse a recorded response body. Throws only on engine bugs —
   * document-level parse failures are corpus cases, not exceptions. */
  parse(kind: QueryDocumentKind, content: string): ParsedQueryDocument;
  /** Evaluate one expression against a parsed document. */
  evaluate(
    document: ParsedQueryDocument,
    expression: QueryExpression,
  ): QueryEngineResult;
  /** Free engine resources for a parsed document. */
  release(document: ParsedQueryDocument): void;
}

/**
 * Pluggable GetInfo normalization pipeline (§5.8, uData.pas:85-207):
 * raw module output in, post-processed MangaInfo fields out. The corpus
 * runner replays captured rawModuleOutput→normalized triples through
 * this boundary; the live implementation is the host engine's §5.8
 * pipeline, tests use a deterministic mock.
 */
export interface NormalizationEngine {
  /** Engine identity, recorded verbatim in replay reports. */
  readonly name: string;
  /** Normalize one raw module output. Never throws on data shape —
   * normalization is total (FMD2 tolerates empty/partial fields).
   * `flags` carries the uData steering globals the oracle capture ran
   * with (capture flag names, e.g. `optionRemoveMangaNameFromChapter`,
   * `removeHostFromChapterLinks`); engines honoring uData defaults must
   * map them onto their flag names — absent keys keep the engine's
   * defaults (uData.pas:85-207 gate flags). */
  normalize(
    input: Readonly<Record<string, unknown>>,
    flags?: Readonly<Record<string, boolean>>,
  ): Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Catalog pipeline (DESIGN.md §6, FMD2-DB parity).
//
// `CatalogSyncService` is the write side (fetch/extract/install, §6.1–
// §6.3); `CatalogStore` is the read side (read-only attach + FTS
// sidecar, §6.4–§6.6). Catalog files are NEVER written after install —
// they are rollback-journal SQLite opened with SQLITE_OPEN_READONLY.
// ─────────────────────────────────────────────────────────────────

/** One FMD2-DB catalog row (`DBDataProcess.pas:137-153`, §6). */
export interface CatalogEntry {
  readonly link: string;
  readonly title: string;
  readonly alttitles: string;
  readonly authors: string;
  readonly artists: string;
  readonly genres: string;
  readonly status: string;
  readonly summary: string;
  readonly numChapter: number;
  /** Julian day number of the last-update date (Pascal `DateToJDN`,
   * uBaseUnit.pas:2740 — epoch-independent Gregorian JDN integer). */
  readonly jdn: number;
}

/** Cursor/offset-paginated page of catalog rows (§6.6). */
export interface CatalogPage {
  readonly entries: readonly CatalogEntry[];
  /**
   * Opaque cursor for the next page; absent on the last page. FTS
   * search is cursor-paginated (offset-carrying, query-bound);
   * `latest`/`title` accept `page` numbers directly.
   */
  readonly nextCursor?: string;
  /** Total matching rows (absent when unknown, e.g. rank-ordered FTS
   * counts are skipped for cheap pages). */
  readonly total?: number;
}

/** Browsing query for the ordered non-FTS endpoints (§6.6). */
export interface CatalogBrowseQuery {
  /** 1-based page number (default 1). */
  readonly page?: number;
  /** Page size (default 20, clamped to a bounded maximum). */
  readonly limit?: number;
}

/** FTS5 search query (§10 `GET /api/catalog/:id/search`). */
export interface CatalogSearchQuery {
  /**
   * FTS5 MATCH expression (raw user query, sanitized by the store).
   * Optional when any of the row filters below is present (FMD2 Filter
   * panel parity — frmMain.pas:3400 filters the list with empty title
   * text); at least one of `query`/`status`/`authors`/`genres`/
   * `newDays` must be set.
   */
  readonly query?: string;
  /** Opaque cursor from a previous page; takes priority over `page`. */
  readonly cursor?: string;
  /** 1-based page number used when no cursor is given (default 1). */
  readonly page?: number;
  /** Page size (default 20, clamped to a bounded maximum). */
  readonly limit?: number;
  /** Filter on the exact `status` column value (§10 search params). */
  readonly status?: string;
  /** Filter: `genres` must contain this token (FTS secondary match). */
  readonly genre?: string;
  /**
   * Filter (FMD2 Filter panel parity, additive): each genre must appear
   * in the `genres` column (LIKE contains). Composed per `genresMode`:
   * `'all'` (FMD2 `rbAll` default) ANDs the LIKE clauses, `'any'`
   * (`rbAny`) ORs them — DBDataProcess.pas:1416-1427 parity.
   */
  readonly genres?: readonly string[];
  /** How `genres` clauses join: `'all'` (default, FMD2 rbAll) | `'any'`. */
  readonly genresMode?: 'all' | 'any';
  /**
   * Filter (FMD2 parity, audit (b)2 fix): `!`/`-` prefixed custom
   * genres — each composes as a `NOT LIKE` exclude (AND among
   * excludes; `genresMode` joins `genres` only). A genre in both
   * lists resolves to exclude-only.
   */
  readonly genresExclude?: readonly string[];
  /**
   * Filter (FMD2 parity): `authors` column LIKE contains. FMD2's
   * `AddSQLSimpleFilter('authors', …)` (DBDataProcess.pas:1394).
   */
  readonly authors?: string;
  /**
   * Filter (FMD2 parity): `artists` column LIKE contains — FMD2's
   * `edFilterArtists` (frmMain.lfm:1569) via the same
   * `AddSQLSimpleFilter` path as `authors` (additive).
   */
  readonly artists?: string;
  /**
   * Filter (FMD2 parity): `summary` column LIKE contains — FMD2's
   * `edFilterSummary` (frmMain.lfm:1606) via the same
   * `AddSQLSimpleFilter` path (additive).
   */
  readonly summary?: string;
  /**
   * Only-new window (FMD2 `cbOnlyNew` parity, jdn-based):
   * `jdn > DateToJDN(today) - newDays` — DBDataProcess.pas:1382-1385.
   */
  readonly newDays?: number;
}

/** Install state of one catalog (§9 `catalog_meta`). */
export interface CatalogMeta {
  readonly id: ModuleId;
  /** Content hash of the installed db file (sha256 hex). */
  readonly dbSha: string;
  /** RFC 3339 timestamp of the successful install. */
  readonly fetchedAt: string;
  /** Installed db size in bytes. */
  readonly bytes: number;
}

/** Result of the §6.1 update check (1 GitHub commits-API call). */
export interface CatalogUpdateCheck {
  /** Repo pin, e.g. `dazedcat19/FMD2-DB`. */
  readonly repo: string;
  /** Latest commit SHA from the commits API (empty when unreachable). */
  readonly headSha: string;
  /** True when `headSha` differs from the stored batch pin. */
  readonly changed: boolean;
  /** Catalog IDs the sync will fetch (pending carry-over + all known
   * catalog ids when the pin moved; per-file ETag 304s still filter). */
  readonly changedIds: readonly string[];
}

/** Outcome of one catalog fetch/install attempt (§6.2–§6.3). */
export interface CatalogSyncResult {
  readonly id: ModuleId;
  /** `unchanged`: blob 304 (ETag match). `updated`: new db installed.
   * `failed`: fetch/extract error (id stays pending for resume). */
  readonly state: 'unchanged' | 'updated' | 'failed';
  readonly dbSha?: string;
  readonly bytes?: number;
  readonly error?: string;
}

/** Read side of the catalog pipeline (§6.4–§6.6). All db access is
 * READ-ONLY; implementations must never create sidecar files (-journal/
 * -wal/-shm) next to catalog files and must never modify them. */
export interface CatalogStore {
  /** Install state of one catalog (undefined when not installed). */
  getMeta(catalogId: ModuleId): CatalogMeta | undefined;
  /** `GET /api/catalog/:id/latest` — ordered by `jdn` DESC (§6.6). */
  latest(catalogId: ModuleId, query?: CatalogBrowseQuery): CatalogPage;
  /** `GET /api/catalog/:id/title` — ordered by `title` (§6.6). */
  byTitle(catalogId: ModuleId, query?: CatalogBrowseQuery): CatalogPage;
  /** `GET /api/catalog/:id/search` — FTS5 sidecar, cursor pagination. */
  search(catalogId: ModuleId, query: CatalogSearchQuery): CatalogPage;
}

/**
 * Write side of the catalog pipeline (§6.1–§6.3): update check via the
 * GitHub commits API (1 call), per-blob conditional GET (ETag /
 * If-None-Match) under a token-bucket rate budget, 7zz extraction to a
 * temp dir, ATOMIC rename into the catalogs dir (never in-place), and
 * resumable batch state (a crash mid-batch resumes from pending).
 */
export interface CatalogSyncService {
  /** §6.1 — 1 commits-API call → changed set (no blob traffic). */
  checkForUpdates(): Promise<CatalogUpdateCheck>;
  /** §6.2–§6.3 — fetch+extract+install one catalog atomically. */
  syncCatalog(catalogId: ModuleId): Promise<CatalogSyncResult>;
  /** Sync the whole changed set; resumable (pending survives crashes
   * and repeat calls skip 304'd ids). */
  syncChanged(ids?: readonly ModuleId[]): Promise<readonly CatalogSyncResult[]>;
  /** Read side over the installed catalogs. */
  readonly store: CatalogStore;
  /** FTS sidecar invalidation hook: `dbSha` change (or undefined) →
   * sidecar keyed by db_sha rebuilds on next use (§6.5). */
  invalidate(catalogId: ModuleId): void;
}

// ─────────────────────────────────────────────────────────────────
// Live-scrape fallback (DESIGN.md §6.8): browse/search for enabled
// modules WITHOUT an FMD2-DB catalog. Lookup order everywhere:
// catalog first (§6.4–§6.6), live directory walk second (§6.8:
// GetDirectoryPageNumber → GetNameAndLink), typed error otherwise —
// a failed walk NEVER surfaces as a partial page.
// ─────────────────────────────────────────────────────────────────

/** §6.8 discriminator: where a browse/search response was served from. */
export type CatalogSource = 'catalog' | 'live';

/** Failure kinds of the live-scrape fallback (mapped onto the §10 envelope). */
export type CatalogFallbackErrorKind =
  | 'fallback_unavailable'
  | 'walk_failed'
  | 'lane_closed';

/**
 * Typed fallback error. `fallback_unavailable` → 404 (no catalog AND
 * the module cannot serve a directory walk); `walk_failed` → 502 (the
 * module's directory events failed or returned net_problem — callers
 * must discard ALL partial results); `lane_closed` → 503 (the update
 * lane is shutting down).
 */
export class CatalogFallbackError extends Error {
  readonly kind: CatalogFallbackErrorKind;

  constructor(kind: CatalogFallbackErrorKind, message: string) {
    super(message);
    this.name = 'CatalogFallbackError';
    this.kind = kind;
  }
}

/**
 * §4 job-lane slot port for live scrapes: browse-triggered directory
 * walks run on the UPDATE lane's slot budget (never the download
 * lane's), so saturating scrapes cannot starve downloads. `acquire`
 * resolves with the slot's release function, or null when the lane is
 * closing (caller maps to `lane_closed`).
 */
export interface UpdateLaneGate {
  acquire(): Promise<(() => void) | null>;
  /** Concurrent in-flight scrape slots (watchdog/test input). */
  readonly active: number;
  /** Waiters queued behind the slot budget (watchdog/test input). */
  readonly queued: number;
  /** Stop granting new slots; queued waiters resolve null (§4 fail fast). */
  close(): void;
}

/**
 * Read side of the §6.8 live-scrape fallback: serves the SAME shapes
 * as {@link CatalogStore} from the module API when
 * `data/catalogs/<ID>.db` is absent. Results are §5.8-normalized
 * directory-walk snapshots cached per module with a TTL (default 6 h);
 * a catalog install invalidates the cache and the API's lookup order
 * flips the module back to `catalog` on its next request.
 *
 * All methods are async (each may drive a module-engine walk) and may
 * throw {@link CatalogFallbackError}; cursor pagination follows the
 * catalog endpoints' opaque base64url offset scheme (query-bound).
 */
export interface CatalogFallbackStore {
  /**
   * True when `catalogId` can be served live — the module is
   * registered AND declares BOTH directory events
   * (OnGetDirectoryPageNumber + OnGetNameAndLink, §5.1). Catalog
   * presence is NOT part of this check: callers consult
   * `CatalogStore.getMeta` first and only fall back when absent.
   */
  supports(catalogId: ModuleId): boolean;
  /** Latest-first browse over the cached walk (§6.8; the walk order IS
   * the site's newest-first directory order). */
  latest(catalogId: ModuleId, query?: CatalogBrowseQuery): Promise<CatalogPage>;
  /** Title-ordered browse over the cached walk (§6.8; NOCASE + link
   * tiebreak, same ordering as §6.6 `title`). */
  byTitle(catalogId: ModuleId, query?: CatalogBrowseQuery): Promise<CatalogPage>;
  /** In-memory LIKE search (title/alttitles/summary terms ANDed,
   * exact `status`, substring `genre`) with the catalog endpoints'
   * cursor scheme (§6.8). */
  search(catalogId: ModuleId, query: CatalogSearchQuery): Promise<CatalogPage>;
  /** Drop the cached walk for one id — called when a catalog arrives
   * (§6.8: the live→catalog switch). */
  invalidate(catalogId: ModuleId): void;
}
