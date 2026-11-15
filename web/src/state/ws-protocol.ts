/**
 * §10 WS client↔hub message contract (client-side mirror of DESIGN.md
 * §10 + D19/D21). The hub routes are NOT part of the OpenAPI snapshot
 * (WebSocket is not expressible there), so the wire shapes are defined
 * ONCE as zod schemas in `@fmd/contract` — the same source the server
 * hub parses its outbound frames with and the REST routes use for the
 * overlapping `Job` payloads — and re-exported here under their
 * historical client-side names. `web/test/ws-contract-drift.test.ts`
 * pins this mirror to the shared schemas (runtime + type level), so
 * the server and the SPA cannot drift apart.
 */
import type { components } from '../api/openapi';
import type {
  JobT,
  WsGapMessageT,
  WsHelloMessageT,
  WsJobEventMessageT,
  WsResyncMessageT,
  WsServerMessageT,
} from '@fmd/contract';

/** REST-generated job snapshot shape (drift-pinned to `JobT` by test). */
export type JobWire = components['schemas']['Job'];
export type { JobT };

/** Client → server, sent on EVERY open (D19 backfill cursor). */
export type HelloMessage = WsHelloMessageT;

/** Server → client: one job-event snapshot (live stream or backfill). */
export type JobEventMessage = WsJobEventMessageT;

/**
 * Server → client: the requested replay window is outside the ring
 * buffer (last 1000 events per job, 15 min max age) — the client must
 * refetch full state and reset its cursor (D19).
 */
export type ResyncMessage = WsResyncMessageT;

/**
 * Server → client (D21 slow-consumer policy): this connection dropped
 * the contiguous id range `fromId..toId` (inclusive) from its outbound
 * queue — same client obligation as `resync`: refetch full state and
 * reset the cursor.
 */
export type GapMessage = WsGapMessageT;

export type WsServerMessage = WsServerMessageT;

/**
 * Contract `JobT` → OpenAPI `Job` projection: strips explicitly-
 * `undefined` optional fields so the snapshot satisfies the generated
 * component type under `exactOptionalPropertyTypes` (same projection
 * discipline as the server's REST `toJobWire`). The shared zod schema
 * stays the source — this only adapts the optional-property typing.
 */
export function eventJobToWire(event: JobEventMessage): JobWire {
  const job = event.job;
  return {
    id: job.id,
    type: job.type,
    moduleId: job.moduleId,
    payload: job.payload,
    state: job.state,
    priority: job.priority,
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.idempotencyKey !== undefined ? { idempotencyKey: job.idempotencyKey } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
