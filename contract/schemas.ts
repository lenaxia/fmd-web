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
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type JobT = z.infer<typeof JobSchema>;

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

/** Every server → client frame (discriminated on `type`). */
export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsJobEventMessageSchema,
  WsGapMessageSchema,
  WsResyncMessageSchema,
]);
export type WsServerMessageT = z.infer<typeof WsServerMessageSchema>;

/** Every client → hub frame (currently only the D19 hello). */
export const WsClientMessageSchema = z.discriminatedUnion('type', [WsHelloMessageSchema]);
export type WsClientMessageT = z.infer<typeof WsClientMessageSchema>;
