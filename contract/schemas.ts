/**
 * Shared wire schemas (DESIGN.md §10 + D19) — THE single zod source for
 * every payload that crosses more than one package boundary:
 *
 * - REST/WS-shared payloads (`Job`, `Timestamp`, job states): the §10
 *   REST routes, the WS hub event frames and the SPA all validate
 *   against THIS module — server/src/api re-exports instead of
 *   redefining, so a REST change cannot drift away from the WS frames
 *   that carry the same job snapshots.
 * - The `/ws` client↔hub protocol (D19): `hello` (reconnect cursor),
 *   `event` (job snapshot, live or backfill), `gap` (slow-consumer
 *   drop-oldest marker, D21) and `resync` (requested replay window is
 *   outside the ring buffer). The hub routes are not expressible in the
 *   OpenAPI snapshot, so these schemas are the machine-readable contract
 *   for that surface.
 *
 * Types are always INFERRED (`z.infer`) — nothing is hand-duplicated.
 */
import { z } from 'zod';

// ── REST/WS-shared payload primitives (§9/§10) ───────────────────────

/** RFC 3339 UTC timestamp (ISO strings as produced by toISOString()). */
export const TimestampSchema = z.iso.datetime({ offset: false });
export type TimestampT = z.infer<typeof TimestampSchema>;

/** Job states (§7.1 persisted state machine). */
export const JobStateSchema = z.enum(['queued', 'running', 'retry', 'done', 'failed', 'cancelled']);
export type JobStateT = z.infer<typeof JobStateSchema>;

/**
 * Failure kinds carried by `state = failed` (§4/§7.3 — the typed
 * classification a `→ failed` transition REQUIRES, enforced by the
 * state machine). Surfaced on failed job rows so the triage surface
 * can group by cause without re-deriving it from error text.
 */
export const JobFailureKindSchema = z.enum(['worker_stalled', 'engine_oom', 'net', 'pack']);
export type JobFailureKindT = z.infer<typeof JobFailureKindSchema>;

/** The §9 `job` row projection shared by REST `/api/jobs*` and every WS event frame. */
export const JobSchema = z.object({
  id: z.string(),
  type: z.literal('download'),
  moduleId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  state: JobStateSchema,
  priority: z.number().int(),
  progress: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  idempotencyKey: z.string().optional(),
  /**
   * Add-as-stopped hold (FMD2 cbAddAsStopped parity): `true` while the
   * queued row must NOT be claimed by the download lane — the state
   * stays `queued` and the hold only lifts via the resume endpoint.
   */
  paused: z.boolean().optional(),
  /**
   * The typed §4/§7.3 failure classification — present on `failed`
   * rows only (the state machine requires it on `→ failed`). Additive:
   * absent on every other state, so older frames/clients keep parsing.
   */
  failureKind: JobFailureKindSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type JobT = z.infer<typeof JobSchema>;

// ── downloads-tab task actions (FMD2 pmDownload parity, web-adapted) ──

/**
 * Per-job task actions (FMD2 pmDownload menu, frmMain.lfm:5538-5617 —
 * Stop/Resume/Redownload/Enable/Disable) as ONE typed union on a
 * single action route. Web adaptation of the FMD2 semantics:
 *
 * - `pause`   — resume-able stop (miDownloadStop): `queued` gains the
 *   hold (`paused: true`, DISABLED-analog — not claimable); `running`
 *   /`retry` user-cancels (STOP-analog — markers persist, resumable).
 * - `resume`  — the inverse (miDownloadResume): held `queued` lifts
 *   the hold; `cancelled` re-enqueues a FRESH chained attempt that
 *   resumes from the persisted markers.
 * - `retry`   — failed → fresh chained attempt (markers resume).
 * - `redownload` — done → fresh chained attempt (miDownloadRedownload).
 * - `disable` — hold a SCHEDULED-but-not-running row (queued only).
 * - `enable`  — lift that hold (queued+paused only).
 *
 * Every action validates against the state matrix; an illegal
 * application is 409 `conflict` with `{job, action}` details.
 */
export const JobActionTypeSchema = z.enum([
  'pause',
  'resume',
  'retry',
  'redownload',
  'enable',
  'disable',
]);
export type JobActionTypeT = z.infer<typeof JobActionTypeSchema>;

export const JobActionRequestSchema = z.object({ type: JobActionTypeSchema });
export type JobActionRequestT = z.infer<typeof JobActionRequestSchema>;

export const JobActionResponseSchema = z.object({ job: JobSchema });
export type JobActionResponseT = z.infer<typeof JobActionResponseSchema>;

/** DELETE /api/jobs/:id query — `data: true` also removes the artifact. */
export const JobDeleteQuerySchema = z.object({
  data: z.coerce.boolean().optional(),
});
export type JobDeleteQueryT = z.infer<typeof JobDeleteQuerySchema>;

/** Toolbar bulk actions (FMD2 tsDownload toolbar, frmMain.lfm:291-339). */
export const JobBulkActionSchema = z.enum(['pause', 'resume', 'delete']);
export type JobBulkActionT = z.infer<typeof JobBulkActionSchema>;

/**
 * `all` — every job the action legally applies to (pause/resume);
 * `completed` — terminal rows (delete: FMD2 miDownloadDeleteCompleted
 * = RemoveAllFinishedTasks).
 */
export const JobBulkScopeSchema = z.enum(['all', 'completed']);
export type JobBulkScopeT = z.infer<typeof JobBulkScopeSchema>;

export const JobBulkActionRequestSchema = z.object({
  action: JobBulkActionSchema,
  scope: JobBulkScopeSchema.default('all'),
});
export type JobBulkActionRequestT = z.infer<typeof JobBulkActionRequestSchema>;

export const JobBulkActionResponseSchema = z.object({
  action: JobBulkActionSchema,
  scope: JobBulkScopeSchema,
  /** Rows this pass touched (0 on an already-settled queue — idempotent). */
  affected: z.number().int().min(0),
  /** Snapshots: resulting rows for pause/resume, removed rows for delete. */
  jobs: z.array(JobSchema),
});
export type JobBulkActionResponseT = z.infer<typeof JobBulkActionResponseSchema>;

// ── /ws protocol (§10 reconnect + D19 backfill + D21 gap marker) ─────

/**
 * Monotonic event id (decimal string). Ids are assigned by the hub per
 * stream and increase strictly per publish — therefore per job too —
 * and double as the client's backfill cursor (D19).
 */
export const WsEventIdSchema = z.string().regex(/^\d+$/, 'expected a decimal event id');
export type WsEventIdT = z.infer<typeof WsEventIdSchema>;

/**
 * D19 ring-buffer bounds, published here so server and clients agree
 * on the numbers the `resync` hint is derived from: the hub keeps the
 * LAST `WS_RING_CAPACITY` events per job and drops buffered events
 * older than `WS_RING_MAX_AGE_MS`; a reconnect whose cursor is behind
 * any evicted event cannot be reconstructed and receives `resync`.
 */
export const WS_RING_CAPACITY = 1000;
export const WS_RING_MAX_AGE_MS = 15 * 60 * 1000;

/** Client → hub, sent on EVERY open (D19 backfill cursor). */
export const WsHelloMessageSchema = z.object({
  type: z.literal('hello'),
  /** Last seen event id; omit on a first connect (live tail only). */
  lastEventId: WsEventIdSchema.optional(),
});
export type WsHelloMessageT = z.infer<typeof WsHelloMessageSchema>;

/** Hub → client: one job-event snapshot (live stream or backfill). */
export const WsJobEventMessageSchema = z.object({
  type: z.literal('event'),
  /** Monotonic event id — the client's backfill cursor (D19). */
  id: WsEventIdSchema,
  /** Current snapshot of the affected job (same schema as REST). */
  job: JobSchema,
});
export type WsJobEventMessageT = z.infer<typeof WsJobEventMessageSchema>;

/**
 * Hub → client (D21 slow-consumer policy): this connection's outbound
 * queue overflowed and the oldest queued events were dropped (drop-
 * oldest). The client MUST refetch full state and reset its cursor —
 * `fromId`/`toId` bound (inclusive) the contiguous id range it never
 * received on this connection.
 */
export const WsGapMessageSchema = z.object({
  type: z.literal('gap'),
  fromId: WsEventIdSchema,
  toId: WsEventIdSchema,
});
export type WsGapMessageT = z.infer<typeof WsGapMessageSchema>;

/**
 * Hub → client (D19): the requested replay window is outside the ring
 * buffer (last 1000 events per job, 15 min max age, or a cursor from a
 * previous hub epoch). The client must refetch full state and reset its
 * cursor; live events keep flowing.
 */
export const WsResyncMessageSchema = z.object({ type: z.literal('resync') });
export type WsResyncMessageT = z.infer<typeof WsResyncMessageSchema>;

// ── catalog provisioning progress (site-first browse, §6.2–§6.3) ─────

/**
 * Fine-grained phases of one catalog provision (the DBUpdaterThread
 * parity surface). `checking` = update check/starting, `downloading` =
 * FMD2-DB 7z blob fetch, `extracting` = 7zz unpack, `installing` =
 * atomic rename imminent, `done`/`failed` = terminal.
 */
export const CatalogSyncPhaseSchema = z.enum([
  'checking',
  'downloading',
  'extracting',
  'installing',
  'done',
  'failed',
]);
export type CatalogSyncPhaseT = z.infer<typeof CatalogSyncPhaseSchema>;

/**
 * Terminal provision outcomes. `no-catalog` is the FMD2-DB 404 case:
 * no prebuilt catalog exists for the site (§6.8 live-scrape territory).
 * `cancelled` is client-side (fetch abort) and never crosses the wire.
 */
export const CatalogSyncOutcomeSchema = z.enum(['updated', 'unchanged', 'failed', 'no-catalog']);
export type CatalogSyncOutcomeT = z.infer<typeof CatalogSyncOutcomeSchema>;

/** One catalog-provision progress snapshot (WS `sync` frame payload). */
export const CatalogSyncProgressSchema = z.object({
  /**
   * Ring-buffer correlation key — `catalog-sync:<moduleId>` (see
   * `catalogSyncJobId`). The hub buffers sync frames under this key
   * exactly like job events, so D19 backfill covers them for free.
   */
  jobId: z.string().min(1),
  moduleId: z.string().min(1),
  phase: CatalogSyncPhaseSchema,
  outcome: CatalogSyncOutcomeSchema.optional(),
  detail: z.string().optional(),
  /** 0..100 when the current phase has a determinate measure. */
  percent: z.number().min(0).max(100).optional(),
});
export type CatalogSyncProgressT = z.infer<typeof CatalogSyncProgressSchema>;

/** The canonical sync-job ring key for one module's catalog provision. */
export const CATALOG_SYNC_JOB_PREFIX = 'catalog-sync:';
export function catalogSyncJobId(moduleId: string): string {
  return `${CATALOG_SYNC_JOB_PREFIX}${moduleId}`;
}

/** Hub → client: one catalog-provision progress snapshot. */
export const WsSyncEventMessageSchema = z.object({
  type: z.literal('sync'),
  /** Monotonic event id — the client's backfill cursor (D19). */
  id: WsEventIdSchema,
  sync: CatalogSyncProgressSchema,
});
export type WsSyncEventMessageT = z.infer<typeof WsSyncEventMessageSchema>;

/** Every server → client frame (discriminated on `type`). */
export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsJobEventMessageSchema,
  WsSyncEventMessageSchema,
  WsGapMessageSchema,
  WsResyncMessageSchema,
]);
export type WsServerMessageT = z.infer<typeof WsServerMessageSchema>;

/** Every client → hub frame (currently only the D19 hello). */
export const WsClientMessageSchema = z.discriminatedUnion('type', [WsHelloMessageSchema]);
export type WsClientMessageT = z.infer<typeof WsClientMessageSchema>;
