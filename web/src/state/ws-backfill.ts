/**
 * D19 WS backfill client state machine (DESIGN.md §10, D19/D21).
 *
 * Transport-agnostic controller: the app passes a WebSocket factory
 * (default: the global constructor) so tests drive a mock socket.
 *
 * Protocol (documented §10 client contract — mirrored by the shared
 * zod schemas in @fmd/contract, which the server hub validates with):
 *   client → `{type:'hello', lastEventId?}` on every open; the id is the
 *            last seen event, so the server backfills what was missed.
 *   server → `{type:'event', id, job}` snapshots (live or backfill)
 *   server → `{type:'resync'}` when the requested window is outside the
 *            ring buffer (last 1000 events/job, 15 min max age): the
 *            client must refetch full state and reset its cursor.
 *   server → `{type:'gap', fromId, toId}` when the connection's
 *            outbound queue dropped events (D21 slow-consumer policy):
 *            same obligation — refetch full state and reset the cursor.
 *
 * Status machine:
 *   idle → connecting → open | backfilling → reconnecting → connecting …
 *   (reconnect attempts back off exponentially, capped; a successful
 *   open resets the attempt counter; `resync` or `gap` clears
 *   lastEventId and invokes onResync exactly once per hint.)
 */
import type { components } from '../api/openapi';
import type { JobEventMessage, WsServerMessage, HelloMessage } from './ws-protocol';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'backfilling' | 'reconnecting';

/** Minimal socket surface the controller needs (tests mock this). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WsLike;

export interface WsBackfillOptions {
  readonly url: string;
  readonly onEvent: (event: JobEventMessage) => void;
  /** Fired on a `resync` hint: refetch full job state (D19). */
  readonly onResync: () => void;
  readonly webSocketFactory?: WebSocketFactory;
  readonly initialLastEventId?: string;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  /** Timer injection for tests; default setTimeout/clearTimeout. */
  readonly scheduleTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly cancelTimer?: (handle: TimerHandle) => void;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 15_000;

/** Timer handle type (resolves to Node's Timeout / DOM number). */
export type TimerHandle = ReturnType<typeof setTimeout>;

export class WsBackfillController {
  private readonly opts: WsBackfillOptions;
  private readonly factory: WebSocketFactory;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly schedule: (fn: () => void, ms: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;

  private socket: WsLike | null = null;
  private timer: TimerHandle | null = null;
  private statusValue: WsStatus = 'idle';
  private attemptValue = 0;
  private lastEventIdValue: string | undefined;
  private stopped = true;
  private resyncPending = false;

  constructor(options: WsBackfillOptions) {
    this.opts = options;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.schedule = options.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancelTimer ?? ((h) => clearTimeout(h));    this.lastEventIdValue = options.initialLastEventId;
  }

  get status(): WsStatus {
    return this.statusValue;
  }

  get lastEventId(): string | undefined {
    return this.lastEventIdValue;
  }

  get reconnectAttempt(): number {
    return this.attemptValue;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.closeSocket();
    this.setStatus('idle');
  }

  /** Current backoff delay for the pending/next reconnect attempt. */
  backoffDelayMs(): number {
    const factor = 2 ** Math.min(this.attemptValue, 16);
    return Math.min(this.backoffBaseMs * factor, this.backoffMaxMs);
  }

  private setStatus(next: WsStatus): void {
    this.statusValue = next;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    const socket = this.factory(this.opts.url);
    this.socket = socket;
    socket.onopen = (): void => {
      if (this.stopped || this.socket !== socket) return;
      this.attemptValue = 0;
      this.sendHello();
      this.setStatus(this.lastEventIdValue !== undefined ? 'backfilling' : 'open');
    };
    socket.onerror = (): void => {
      /* close follows; nothing to do here */
    };
    socket.onclose = (): void => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.onmessage = (ev): void => {
      if (this.stopped || this.socket !== socket) return;
      this.handleMessage(ev.data);
    };
  }

  private sendHello(): void {
    const socket = this.socket;
    if (socket === null) return;
    const hello: HelloMessage =
      this.lastEventIdValue !== undefined
        ? { type: 'hello', lastEventId: this.lastEventIdValue }
        : { type: 'hello' };
    socket.send(JSON.stringify(hello));
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = this.backoffDelayMs();
    this.attemptValue += 1;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule((): void => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (message === null) return;
    switch (message.type) {
      case 'event': {
        if (this.statusValue === 'backfilling') this.setStatus('open');
        this.lastEventIdValue = message.id;
        this.opts.onEvent(message);
        break;
      }
      case 'resync':
      case 'gap': {
        // D19 resync / D21 gap: the replay window (or the dropped id
        // range) is gone — refetch full state and let the next hello
        // start from a fresh cursor.
        if (this.statusValue === 'backfilling') this.setStatus('open');
        if (!this.resyncPending) {
          this.resyncPending = true;
          this.lastEventIdValue = undefined;
          try {
            this.opts.onResync();
          } finally {
            this.resyncPending = false;
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

function defaultWebSocketFactory(url: string): WsLike {
  const ctor = globalThis.WebSocket;
  if (ctor === undefined) {
    throw new Error('WebSocket is not available in this environment');
  }
  return new ctor(url) as unknown as WsLike;
}

/** Narrow a raw WS payload onto the shared server-message union
 * (`@fmd/contract` WsServerMessageT; drift-pinned by test). Hand-rolled
 * (no zod in the browser bundle): every contract-valid frame parses,
 * and anything else returns null and is ignored. */
export function parseServerMessage(data: unknown): WsServerMessage | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['type'] === 'resync') {
    return { type: 'resync' };
  }
  if (
    record['type'] === 'gap' &&
    isEventId(record['fromId']) &&
    isEventId(record['toId'])
  ) {
    return { type: 'gap', fromId: record['fromId'], toId: record['toId'] };
  }
  if (record['type'] === 'event' && typeof record['id'] === 'string' && typeof record['job'] === 'object' && record['job'] !== null) {
    return { type: 'event', id: record['id'], job: record['job'] as components['schemas']['Job'] };
  }
  return null;
}

/** Contract event ids are decimal digit strings (`WsEventIdSchema`). */
function isEventId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
