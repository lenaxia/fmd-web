/**
 * §10 WS client↔hub message contract (client-side mirror of DESIGN.md
 * §10 + D19). The hub routes are NOT part of the OpenAPI snapshot
 * (WebSocket is not expressible there), so this file is the single
 * documented definition of the wire shapes the SPA speaks; the WS hub
 * story must keep its server side byte-compatible with these types.
 */
import type { components } from '../api/openapi';

export type JobWire = components['schemas']['Job'];

/** Client → server, sent on EVERY open (D19 backfill cursor). */
export interface HelloMessage {
  type: 'hello';
  /** Last seen event id; omit on a first connect (full tail). */
  lastEventId?: string;
}

/** Server → client: one job-event snapshot (live stream or backfill). */
export interface JobEventMessage {
  type: 'event';
  /** Monotonic event id — the client's backfill cursor (D19). */
  id: string;
  /** Current snapshot of the affected job. */
  job: JobWire;
}

/**
 * Server → client: the requested replay window is outside the ring
 * buffer (last 1000 events per job, 15 min max age) — the client must
 * refetch full state and reset its cursor (D19).
 */
export interface ResyncMessage {
  type: 'resync';
}

export type WsServerMessage = JobEventMessage | ResyncMessage;
