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

/** HTTP methods the API surface uses (§10); `WS` is the websocket hub. */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'WS';

/** One row of the §5.2 event-binding table. */
export interface EventBinding {
  /** Dispatcher name, e.g. `GetDirectoryPageNumber` (the `Do*` method). */
  readonly event: string;
  /** Return protocol for this event. */
  readonly returns: EventReturnKind;
  /** Exact globals bound for the call. There is no `ACCOUNT` anywhere. */
  readonly globals: readonly string[];
  /**
   * Globals the host READS BACK after the call. Only `PAGENUMBER` is
   * ever read back (§5.2); `URL` is never read back.
   */
  readonly readBack: readonly string[];
  /** Globals that are push-only (never read back) — e.g. `BeforeDownloadImage`. */
  readonly pushOnly?: boolean;
  /** True when account-status constants (asUnknown/asChecking/asValid/asInvalid) are bound. */
  readonly accountConstants?: boolean;
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
