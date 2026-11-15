/**
 * §10 WS hub (DESIGN.md §10 + D19 + D21): broadcasts job/progress/sync
 * events as `{type:'event', id, job}` snapshots over `/ws`, with the
 * D19 bounded-reconnect protocol:
 *
 *   client → `{type:'hello', lastEventId?}` on every open
 *   hub    → backfill replay of every buffered event with
 *            id > lastEventId (across jobs, in id order) — a hello
 *            WITHOUT a cursor replays the full buffered tail ("full
 *            tail" first connect) — then live events stream
 *   hub    → `{type:'resync'}` instead of a replay when the requested
 *            window cannot be reconstructed exactly
 *   hub    → `{type:'gap', fromId, toId}` when THIS connection's
 *            outbound queue overflowed (D21 slow-consumer policy)
 *
 * Storage: one ring buffer per job — the LAST `capacity` events per job
 * (default 1000), entries older than `maxAgeMs` (default 15 min) are
 * swept. Event ids are hub-global and strictly increasing per publish
 * (hence per job); they are the backfill cursor.
 *
 * Reconnect decision for a cursor L (after an age sweep):
 *   - hub never emitted an event, or L is ahead of the newest id
 *     (previous hub epoch, e.g. after a restart)        → resync
 *   - L < the global eviction watermark (an event at or above L was
 *     evicted from its job's ring: capacity or age)     → resync
 *   - otherwise replay (L, newest] from the ring buffers
 * The replay and the live-registration happen in one synchronous step,
 * so a subscriber receives the exact missing sequence then live events
 * with no duplicate and no gap at the seam.
 *
 * D21 slow-consumer policy (drop-oldest with gap marker): each
 * subscriber has a bounded outbound queue (`queueLimit`). While a
 * reader stalls (its socket's `bufferedAmount` stays above
 * `bufferedLimitBytes`), events accumulate; at overflow the OLDEST
 * queued messages are dropped and a contiguous `{type:'gap'}` marker
 * naming the dropped id range is queued in their place, so the client
 * can detect the loss and refetch. Dropped `resync` markers are
 * re-emitted at the tail (losing one would strand the client on stale
 * state). The hello/replay step enqueues UNBOUNDED (bounded by the ring
 * capacity itself) — a replay truncated by the connection's own queue
 * would defeat the protocol; once live, the D21 bound covers everything
 * queued, and a dropped backfill prefix is reported by the gap marker
 * like any other loss.
 */
import {
  JobSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
  WS_RING_CAPACITY,
  WS_RING_MAX_AGE_MS,
  type WsServerMessageT,
  type WsJobEventMessageT,
  type JobT,
} from '@fmd/contract';
import { JobEventRingBuffer } from './ring-buffer.js';

/** Minimal socket surface the hub needs (the `ws` server socket satisfies it). */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued by the transport but not yet flushed to a stalled reader. */
  readonly bufferedAmount: number;
}

export interface WsHubOptions {
  /** Ring capacity per job (D19 default 1000). */
  readonly capacity?: number;
  /** Ring max age in ms (D19 default 15 min). */
  readonly maxAgeMs?: number;
  /** Per-subscriber outbound queue depth before drop-oldest (D21, default 256). */
  readonly queueLimit?: number;
  /** Socket bufferedAmount soft cap that pauses the pump (D21, default 1 MiB). */
  readonly bufferedLimitBytes?: number;
  /**
   * Custom backpressure gate (D21 seam): return true while the socket
   * must NOT be written. Default predicate:
   * `socket.bufferedAmount < bufferedLimitBytes`. Kernels absorb writes
   * into rcvbuf even for paused readers, so deployments with proxy
   * layers can supply a tighter policy (token buckets, app-level
   * acks); tests use it to make the slow-consumer drill deterministic.
   */
  readonly canSend?: (socket: HubSocket) => boolean;
  /** Housekeeping tick (sweep + pump retry); 0 disables (default 250 ms). */
  readonly tickIntervalMs?: number;
  /** Injectable clock for deterministic boundary tests. */
  readonly now?: () => number;
}

export interface WsHubStats {
  readonly subscribers: number;
  /** Subscribers that answered the hello and stream live (D21 fanout set). */
  readonly liveSubscribers: number;
  readonly trackedJobs: number;
  readonly bufferedEvents: number;
  /** Highest assigned event id (0 when none were ever published). */
  readonly newestEventId: number;
  /** Global eviction watermark (0 when nothing was ever evicted). */
  readonly lastEvictedId: number;
  /** Messages queued-but-unsent across all subscribers (D21 observability). */
  readonly queuedMessages: number;
  /** Cumulative events dropped by the slow-consumer policy (D21). */
  readonly droppedEvents: number;
}

/** Opaque per-connection handle (created by `connect`). */
export interface WsSubscription {
  readonly id: number;
}

interface SubscriberState extends WsSubscription {
  readonly socket: HubSocket;
  /** Outbound wire messages awaiting a pump. */
  queue: WsServerMessageT[];
  /**
   * false until the hello is answered: backfill replays enqueue
   * unbounded (see module doc); live streaming enforces the D21 bound.
   */
  bounded: boolean;
  closed: boolean;
  /** Queued (not yet sent) message count — observability for tests. */
  queued: number;
  /** Dropped event count since connect (D21 observability). */
  dropped: number;
}

export class WsHub {
  private readonly buffers = new Map<string, JobEventRingBuffer<WsJobEventMessageT>>();
  private readonly subscribers = new Map<number, SubscriberState>();
  private readonly capacity: number;
  private readonly maxAgeMs: number;
  private readonly queueLimit: number;
  private readonly bufferedLimitBytes: number;
  private readonly canSend: ((socket: HubSocket) => boolean) | undefined;
  private readonly clock: () => number;
  private nextId = 1;
  private nextSubscriberId = 1;
  private evictedWatermark = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private closedHub = false;

  constructor(options: WsHubOptions = {}) {
    this.capacity = options.capacity ?? WS_RING_CAPACITY;
    this.maxAgeMs = options.maxAgeMs ?? WS_RING_MAX_AGE_MS;
    this.queueLimit = options.queueLimit ?? 256;
    this.bufferedLimitBytes = options.bufferedLimitBytes ?? 1024 * 1024;
    this.canSend = options.canSend;
    this.clock = options.now ?? Date.now;
    if (!Number.isInteger(this.queueLimit) || this.queueLimit < 1) {
      throw new Error('queueLimit must be an integer >= 1');
    }
    const tickIntervalMs = options.tickIntervalMs ?? 250;
    if (tickIntervalMs > 0 && typeof setInterval === 'function') {
      // Housekeeping tick: age sweep + pump retry for readers whose
      // stall ended while no new events were publishing. Unref'd — a
      // live hub never holds the process open.
      this.tick = setInterval((): void => {
        this.sweepAll();
        this.pumpAll();
      }, tickIntervalMs);
      this.tick.unref?.();
    }
  }

  /** Publish one job snapshot: assigns the next event id, buffers it
   * under the job's ring, and fans out to every live subscriber. */
  publish(rawJob: JobT): WsJobEventMessageT {
    if (this.closedHub) {
      throw new Error('hub is closed');
    }
    const job: JobT = JobSchema.parse(rawJob);
    this.sweepAll();
    const id = this.nextId;
    this.nextId += 1;
    const message: WsJobEventMessageT = { type: 'event', id: String(id), job };
    let buffer = this.buffers.get(job.id);
    if (buffer === undefined) {
      buffer = new JobEventRingBuffer<WsJobEventMessageT>({
        capacity: this.capacity,
        maxAgeMs: this.maxAgeMs,
        now: this.clock,
      });
      this.buffers.set(job.id, buffer);
    }
    buffer.append(id, message);
    this.evictedWatermark = Math.max(this.evictedWatermark, buffer.lastEvictedId);
    for (const sub of this.subscribers.values()) {
      if (sub.bounded && !sub.closed) {
        this.enqueue(sub, message);
      }
    }
    return message;
  }

  /** Register one accepted socket; the connection idles (unbounded
   * queue, nothing sent) until the D19 hello arrives. */
  connect(socket: HubSocket): WsSubscription {
    const sub: SubscriberState = {
      id: this.nextSubscriberId,
      socket,
      queue: [],
      bounded: false,
      closed: false,
      queued: 0,
      dropped: 0,
    };
    this.nextSubscriberId += 1;
    this.subscribers.set(sub.id, sub);
    return sub;
  }

  /** One inbound text frame. Only the FIRST message (the hello) is
   * acted on; later frames and undecodable payloads are ignored. A
   * malformed FIRST frame (undecodable JSON, wrong shape, non-decimal
   * cursor) answers `resync` — the safe fallback: the client refetches
   * instead of trusting a cursor we could not honor. */
  onMessage(sub: WsSubscription, raw: string): void {
    const state = this.subscribers.get(sub.id);
    if (state === undefined || state.closed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      if (!state.bounded) {
        this.enqueueResync(state);
        this.openLive(state);
      }
      return;
    }
    const decoded = WsClientMessageSchema.safeParse(parsed);
    if (!decoded.success) {
      if (!state.bounded) {
        this.enqueueResync(state);
        this.openLive(state);
      }
      return;
    }
    const hello = decoded.data;
    if (hello.type !== 'hello') {
      return;
    }
    if (state.bounded) {
      // One hello per connection — re-hellos are ignored.
      return;
    }
    this.answerHello(state, hello.lastEventId);
  }

  /** Connection teardown (socket 'close'). */
  onClose(sub: WsSubscription): void {
    const state = this.subscribers.get(sub.id);
    if (state === undefined) {
      return;
    }
    state.closed = true;
    state.queue = [];
    this.subscribers.delete(state.id);
  }

  /** Close every subscriber socket and stop the housekeeping tick.
   * Idempotent; a closed hub refuses further publishes. */
  close(): void {
    if (this.closedHub) {
      return;
    }
    this.closedHub = true;
    if (this.tick !== undefined) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
    for (const sub of this.subscribers.values()) {
      sub.closed = true;
      sub.queue = [];
      try {
        sub.socket.close(1001, 'server shutdown');
      } catch {
        // Socket already dying — nothing to recover.
      }
    }
    this.subscribers.clear();
  }

  get stats(): WsHubStats {
    let bufferedEvents = 0;
    for (const buffer of this.buffers.values()) {
      bufferedEvents += buffer.size;
    }
    let queuedMessages = 0;
    let droppedEvents = 0;
    let liveSubscribers = 0;
    for (const sub of this.subscribers.values()) {
      queuedMessages += sub.queued;
      droppedEvents += sub.dropped;
      if (sub.bounded && !sub.closed) {
        liveSubscribers += 1;
      }
    }
    return {
      subscribers: this.subscribers.size,
      liveSubscribers,
      trackedJobs: this.buffers.size,
      bufferedEvents,
      newestEventId: this.nextId - 1,
      lastEvictedId: this.evictedWatermark,
      queuedMessages,
      droppedEvents,
    };
  }

  // ── D19 reconnect protocol ────────────────────────────────────────

  /**
   * Answer the hello: decide resync vs exact replay, queue the reply,
   * then flip the subscriber to bounded live streaming — one
   * synchronous step, so live events can never interleave with the
   * replay (ordering + no-duplicate guarantee at the seam).
   */
  private answerHello(sub: SubscriberState, lastEventId: string | undefined): void {
    this.sweepAll();
    const decision = this.planReplay(lastEventId);
    if (decision === 'resync') {
      this.enqueueResync(sub);
    } else {
      for (const message of decision) {
        sub.queue.push(message);
        sub.queued += 1;
      }
      this.pump(sub);
    }
    this.openLive(sub);
  }

  /**
   * The reconnect decision (see module doc). Returns the exact replay
   * sequence — every buffered event with id > L across jobs, in id
   * order — or 'resync' when it would not be exact. A hello WITHOUT a
   * cursor replays the full buffered tail (ws-protocol: "omit on a
   * first connect (full tail)") — events published before the hello
   * arrives are absorbed by the ring buffers, so the tail is exact
   * however the timing falls.
   */
  private planReplay(lastEventId: string | undefined): readonly WsJobEventMessageT[] | 'resync' {
    const tail: WsJobEventMessageT[] = [];
    for (const buffer of this.buffers.values()) {
      for (const entry of buffer.replay(0)) {
        tail.push(entry.value);
      }
    }
    tail.sort((a, b) => Number(a.id) - Number(b.id));
    if (lastEventId === undefined) {
      return tail; // First connect: full buffered tail, then live.
    }
    const cursor = Number(lastEventId);
    const newest = this.nextId - 1;
    if (newest === 0 || cursor > newest || cursor < this.evictedWatermark) {
      return 'resync';
    }
    return tail.filter((message) => Number(message.id) > cursor);
  }

  /** Age sweep across all per-job rings; empty rings are dropped. */
  private sweepAll(): void {
    for (const [jobId, buffer] of this.buffers) {
      buffer.sweep();
      this.evictedWatermark = Math.max(this.evictedWatermark, buffer.lastEvictedId);
      if (buffer.isEmpty) {
        this.buffers.delete(jobId);
      }
    }
  }

  private openLive(sub: SubscriberState): void {
    sub.bounded = true;
    this.pump(sub);
  }

  private enqueueResync(sub: SubscriberState): void {
    this.enqueue(sub, { type: 'resync' });
  }

  // ── D21 slow-consumer policy (drop-oldest + gap marker) ───────────

  /**
   * Queue one outbound message through the contract schema (parse
   * before send — the schemas stay the single source of truth both
   * ways, same discipline as the REST routes) and pump.
   */
  private enqueue(sub: SubscriberState, message: WsServerMessageT): void {
    if (sub.closed) {
      return;
    }
    const wire = WsServerMessageSchema.parse(message);
    if (sub.bounded && sub.queue.length >= this.queueLimit) {
      // ONE drop pass per enqueue: dropOldest makes room by removing
      // the oldest entries, then inserts the gap marker, so the queue
      // may transiently hold limit+1 until the next pass — never
      // re-loop here (the marker insertion would feed itself).
      this.dropOldest(sub);
    }
    sub.queue.push(wire);
    sub.queued += 1;
    this.pump(sub);
  }

  /**
   * Drop the oldest queued message(s) to make room, folding dropped id
   * ranges (and any previously queued gap marker) into ONE contiguous
   * gap range. The range merges into the first marker already queued
   * (it sits ahead of everything newer, so the position stays correct)
   * or is inserted at the queue head — everything still queued is
   * newer than the dropped prefix. A dropped `resync` hint is
   * re-emitted at the tail: refetch hints must survive overflow.
   */
  private dropOldest(sub: SubscriberState): void {
    let fromId = Number.POSITIVE_INFINITY;
    let toId = Number.NEGATIVE_INFINITY;
    let resyncLost = false;
    let droppedEvents = 0;
    while (sub.queue.length >= this.queueLimit) {
      const dropped = sub.queue.shift();
      if (dropped === undefined) {
        break;
      }
      sub.queued -= 1;
      if (dropped.type === 'gap') {
        fromId = Math.min(fromId, Number(dropped.fromId));
        toId = Math.max(toId, Number(dropped.toId));
      } else if (dropped.type === 'event') {
        fromId = Math.min(fromId, Number(dropped.id));
        toId = Math.max(toId, Number(dropped.id));
        droppedEvents += 1;
      } else {
        resyncLost = true;
      }
    }
    if (fromId <= toId) {
      const merged = sub.queue.find((m): boolean => m.type === 'gap');
      if (merged !== undefined && merged.type === 'gap') {
        merged.fromId = String(Math.min(Number(merged.fromId), fromId));
        merged.toId = String(Math.max(Number(merged.toId), toId));
      } else {
        sub.queue.unshift({ type: 'gap', fromId: String(fromId), toId: String(toId) });
        sub.queued += 1;
      }
    }
    if (resyncLost) {
      sub.queue.push({ type: 'resync' });
      sub.queued += 1;
    }
    sub.dropped += droppedEvents;
  }

  /**
   * Drain the queue to the socket while the transport keeps accepting
   * bytes. A stalled reader (bufferedAmount >= cap) parks the rest; the
   * housekeeping tick or the next enqueue retries.
   */
  private pump(sub: SubscriberState): void {
    const canSend = this.canSend ?? ((socket: HubSocket): boolean => socket.bufferedAmount < this.bufferedLimitBytes);
    while (!sub.closed && sub.queue.length > 0 && canSend(sub.socket)) {
      const message = sub.queue.shift();
      if (message === undefined) {
        break;
      }
      sub.queued -= 1;
      try {
        sub.socket.send(JSON.stringify(message));
      } catch {
        // Send failure ≈ dead socket — the 'close' handler cleans up.
        return;
      }
    }
  }

  private pumpAll(): void {
    for (const sub of this.subscribers.values()) {
      if (sub.bounded && !sub.closed) {
        this.pump(sub);
      }
    }
  }
}
