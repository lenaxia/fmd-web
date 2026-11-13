/**
 * WS reconnect + backfill state machine tests (D19) — mock WebSocket,
 * no network (DESIGN.md §13): hello cursor on every open, exponential
 * backoff reconnect, backfill cursor replay, `resync` hint handling
 * (window older than the 1000-event/15-min ring buffer), stop cleanup,
 * malformed payload tolerance.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseServerMessage,
  WsBackfillController,
  type TimerHandle,
  type WsLike,
} from '../src/state/ws-backfill';
import type { JobEventMessage } from '../src/state/ws-protocol';
import { jobFixture } from './fixtures';

/** noUncheckedIndexedAccess helper: assert presence in tests. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value in test');
  return value;
}

class MockWebSocket implements WsLike {
  static instances: MockWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    /* recorded implicitly by close handlers */
  }

  serverOpen(): void {
    this.onopen?.();
  }

  serverMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(): void {
    this.onclose?.();
  }

  hello(): { type: string; lastEventId?: string } {
    expect(this.sent).toHaveLength(1);
    return JSON.parse(this.sent[0] ?? '') as { type: string; lastEventId?: string };
  }
}

interface CapturedTimer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function makeTimers(): {
  schedule: (fn: () => void, ms: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  timers: CapturedTimer[];
  fireAll: () => void;
  pending: () => CapturedTimer[];
} {
  const timers: CapturedTimer[] = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number): TimerHandle => {
      const timer: CapturedTimer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timers.length as unknown as TimerHandle;
    },
    cancel: (handle: TimerHandle): void => {
      const timer = timers[(handle as unknown as number) - 1];
      if (timer !== undefined) timer.cancelled = true;
    },
    pending: (): CapturedTimer[] => timers.filter((t): boolean => !t.cancelled),
    fireAll: (): void => {
      for (const t of timers.splice(0)) {
        if (!t.cancelled) t.fn();
      }
    },
  };
}

function eventMessage(id: string): string {
  const event: JobEventMessage = { type: 'event', id, job: jobFixture(`job-${id}`) };
  return JSON.stringify(event);
}

function makeController(overrides?: {
  onEvent?: (e: JobEventMessage) => void;
  onResync?: () => void;
  timers?: ReturnType<typeof makeTimers>;
  initialLastEventId?: string;
}): { controller: WsBackfillController; sockets: () => MockWebSocket[]; onEvent: (e: JobEventMessage) => void; onResync: () => void } {
  const sockets: MockWebSocket[] = [];
  const onEvent =
    overrides?.onEvent ??
    ((): void => {});
  const onResync = overrides?.onResync ?? ((): void => {});
  const timers = overrides?.timers ?? makeTimers();
  const controller = new WsBackfillController({
    url: 'ws://localhost/ws',
    onEvent,
    onResync,
    webSocketFactory: (url: string): WsLike => {
      const ws = new MockWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
    ...(overrides?.initialLastEventId !== undefined ? { initialLastEventId: overrides.initialLastEventId } : {}),
  });
  return { controller, sockets: (): MockWebSocket[] => sockets, onEvent, onResync };
}

describe('WsBackfillController — D19 reconnect/backfill state machine', (): void => {
  it('idle → connecting → open; hello without cursor on first connect', (): void => {
    const { controller, sockets } = makeController();
    controller.start();
    expect(controller.status).toBe('connecting');

    const first = must(sockets()[0]);
    expect(first).toBeInstanceOf(MockWebSocket);
    first.serverOpen();
    expect(first.hello()).toEqual({ type: 'hello' });
    expect(controller.status).toBe('open');
    controller.stop();
  });

  it('tracks the last event id from event snapshots', (): void => {
    const onEvent = vi.fn();
    const { controller, sockets } = makeController({ onEvent });
    controller.start();
    const ws = must(sockets()[0]);
    ws.serverOpen();
    ws.serverMessage(eventMessage('e1'));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(controller.lastEventId).toBe('e1');
    ws.serverMessage(eventMessage('e2'));
    expect(controller.lastEventId).toBe('e2');
    controller.stop();
  });

  it('close → reconnecting with exponential backoff; hello REPLAYS lastEventId (backfill)', (): void => {
    const timers = makeTimers();
    const { controller, sockets } = makeController({ timers });
    controller.start();
    const first = must(sockets()[0]);
    first.serverOpen();
    first.serverMessage(eventMessage('e41'));

    first.serverClose();
    expect(controller.status).toBe('reconnecting');
    expect(timers.pending()).toHaveLength(1);
    expect(must(timers.pending()[0]).ms).toBe(500);

    timers.fireAll();
    const second = must(sockets()[1]);
    expect(controller.status).toBe('connecting');
    second.serverOpen();
    // D19 backfill: the hello carries the last seen event id
    expect(second.hello()).toEqual({ type: 'hello', lastEventId: 'e41' });
    expect(controller.status).toBe('backfilling');
    second.serverMessage(eventMessage('e42'));
    expect(controller.status).toBe('open');

    // Second drop → the attempt counter RESET on the successful open,
    // so the backoff starts over at the base delay (fresh attempt 1).
    second.serverClose();
    expect(must(timers.pending()[0]).ms).toBe(500);
    expect(controller.reconnectAttempt).toBe(1);
    controller.stop();
  });

  it('resync hint clears the cursor and notifies (ring-buffer window gone)', (): void => {
    const onResync = vi.fn();
    const timers = makeTimers();
    const { controller, sockets } = makeController({ onResync, timers });
    controller.start();
    const ws = must(sockets()[0]);
    ws.serverOpen();
    ws.serverMessage(eventMessage('e1'));

    ws.serverMessage(JSON.stringify({ type: 'resync' }));
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(controller.lastEventId).toBeUndefined();

    ws.serverClose();
    timers.fireAll();
    const next = must(sockets()[1]);
    next.serverOpen();
    // fresh cursor after resync: hello without lastEventId
    expect(next.hello()).toEqual({ type: 'hello' });
    controller.stop();
  });

  it('stop() cancels the pending reconnect timer and goes idle', (): void => {
    const timers = makeTimers();
    const { controller, sockets } = makeController({ timers });
    controller.start();
    must(sockets()[0]).serverClose();
    expect(timers.pending()).toHaveLength(1);

    controller.stop();
    expect(controller.status).toBe('idle');
    expect(timers.pending()).toHaveLength(0);
    const before = sockets().length;
    timers.fireAll();
    expect(sockets().length).toBe(before); // no new connection after stop
  });

  it('caps the backoff at backoffMaxMs', (): void => {
    const timers = makeTimers();
    const { controller, sockets } = makeController({ timers });
    controller.start();
    for (let round = 0; round < 6; round += 1) {
      const socketsNow = sockets().length;
      const ws = must(sockets()[socketsNow - 1]);
      ws.serverClose();
      const delay = must(timers.pending()[0]).ms;
      if (round < 5) {
        expect(delay).toBe(500 * 2 ** round);
      } else {
        expect(delay).toBe(15_000); // cap, not 16s
      }
      timers.fireAll();
    }
    controller.stop();
  });

  it('ignores malformed / unknown messages without crashing', (): void => {
    const onEvent = vi.fn();
    const { controller, sockets } = makeController({ onEvent });
    controller.start();
    const ws = must(sockets()[0]);
    ws.serverOpen();
    ws.serverMessage('not json');
    ws.serverMessage(JSON.stringify({ type: 'unknown' }));
    ws.serverMessage(JSON.stringify({ type: 'event' })); // missing id/job
    ws.serverMessage(42);
    expect(onEvent).not.toHaveBeenCalled();
    expect(controller.lastEventId).toBeUndefined();
    expect(controller.status).toBe('open');
    controller.stop();
  });

  it('starts from an injected initial cursor (resume across reloads)', (): void => {
    const { controller, sockets } = makeController({ initialLastEventId: 'e9' });
    controller.start();
    const ws0 = must(sockets()[0]);
    ws0.serverOpen();
    expect(ws0.hello()).toEqual({ type: 'hello', lastEventId: 'e9' });
    expect(controller.status).toBe('backfilling');
    controller.stop();
  });
});

describe('parseServerMessage', (): void => {
  it('narrow documented messages and reject the rest', (): void => {
    const event = parseServerMessage(eventMessage('e1'));
    expect(event).not.toBeNull();
    expect(event?.type).toBe('event');
    if (event?.type === 'event') {
      expect(event.job.id).toBe('job-e1');
    }
    expect(parseServerMessage(JSON.stringify({ type: 'resync' }))?.type).toBe('resync');
    expect(parseServerMessage('junk')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
    expect(parseServerMessage(undefined)).toBeNull();
  });
});
