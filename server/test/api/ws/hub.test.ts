/**
 * WsHub unit tests — the D19 reconnect decision matrix and the D21
 * drop-oldest/gap-marker policy, exercised through `HubSocket` fakes
 * (no network; the wire-level integration lives in
 * `ws.integration.test.ts`). Clock, ring bounds, queue bounds and the
 * backpressure cap are all injected, so every boundary (exactly-at
 * capacity, exactly-at watermark, exactly-at 15 min) is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { WsHub, type HubSocket, type WsSubscription } from '../../../src/api/ws/hub.js';
import { WS_RING_CAPACITY, WS_RING_MAX_AGE_MS, type JobT } from '@fmd/contract';

const MAX_AGE_MS = WS_RING_MAX_AGE_MS;

/** Recording HubSocket fake. */
class FakeSocket implements HubSocket {
  readonly sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | undefined;
  buffered = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  get bufferedAmount(): number {
    return this.buffered;
  }
}

/** A reader that never drains while `stalled` — the pump always parks. */
class StalledSocket extends FakeSocket {
  stalled = true;
  override get bufferedAmount(): number {
    return this.stalled ? Number.MAX_SAFE_INTEGER : super.bufferedAmount;
  }
}

interface Frame {
  type: string;
  id?: string;
  fromId?: string;
  toId?: string;
}

function frames(sock: FakeSocket): Frame[] {
  return sock.sent.map((f) => JSON.parse(f) as Frame);
}

function eventIds(sock: FakeSocket): string[] {
  return frames(sock)
    .filter((f) => f.type === 'event')
    .map((f) => f.id as string);
}

function connect(hub: WsHub, socket: HubSocket, lastEventId?: string): WsSubscription {
  const sub = hub.connect(socket);
  const hello: Record<string, unknown> = { type: 'hello' };
  if (lastEventId !== undefined) {
    hello['lastEventId'] = lastEventId;
  }
  hub.onMessage(sub, JSON.stringify(hello));
  return sub;
}

let jobSeq = 0;
function makeJob(overrides: Partial<JobT> = {}): JobT {
  jobSeq += 1;
  const id = overrides.id ?? String(jobSeq);
  return {
    id,
    type: 'download',
    moduleId: 'a'.repeat(32),
    payload: { moduleId: 'a'.repeat(32), mangaUrl: 'https://ex.org/m', chapterLink: 'ch/1' },
    state: 'queued',
    priority: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function publish(hub: WsHub, overrides: Partial<JobT> = {}): number {
  const message = hub.publish(makeJob(overrides));
  return Number(message.id);
}

describe('WsHub — live fanout', (): void => {
  it('sends every published event to live subscribers in publish order', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const idle = new FakeSocket(); // connected but hello not sent yet
    hub.connect(idle);
    const live = new FakeSocket();
    connect(hub, live);

    publish(hub, { state: 'running' }); // id 1 → only `live`
    expect(idle.sent).toHaveLength(0);
    expect(eventIds(live)).toEqual(['1']);

    connect(hub, idle); // hello without cursor → full buffered tail, then live
    expect(eventIds(idle)).toEqual(['1']); // tail
    publish(hub, { id: 'j', state: 'running', progress: { pages: 3 } }); // 2
    publish(hub, { id: 'j', state: 'done' }); // 3
    expect(eventIds(idle)).toEqual(['1', '2', '3']);
    expect(eventIds(live)).toEqual(['1', '2', '3']);
    hub.close();
  });

  it('publish validates job snapshots through the shared schema', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    expect(() => hub.publish({ ...makeJob(), createdAt: 'nope' } as unknown as JobT)).toThrow();
    hub.close();
  });
});

describe('WsHub — D19 reconnect decisions', (): void => {
  it('hello WITHOUT lastEventId replays the full buffered tail, then streams live', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    publish(hub, { state: 'running' }); // id 1 pre-dates the client
    const sock = new FakeSocket();
    connect(hub, sock);
    expect(eventIds(sock)).toEqual(['1']); // full tail (buffers absorb pre-hello publishes)
    publish(hub, { state: 'done' }); // id 2 — live
    expect(eventIds(sock)).toEqual(['1', '2']);
    hub.close();
  });

  it('replays EXACTLY the buffered events above the cursor, in id order', (): void => {
    let now = 0;
    const hub = new WsHub({ tickIntervalMs: 0, now: () => now });
    publish(hub, { id: 'a', state: 'running' }); // 1
    publish(hub, { id: 'b', state: 'running' }); // 2
    publish(hub, { id: 'a', state: 'done' }); // 3
    const sock = new FakeSocket();
    connect(hub, sock, '1');
    expect(eventIds(sock)).toEqual(['2', '3']);
    // The seam: a live event right after the replay continues the sequence.
    now += 1;
    publish(hub, { id: 'a', state: 'failed' }); // 4
    expect(eventIds(sock)).toEqual(['2', '3', '4']);
    hub.close();
  });

  it('cursor exactly at the newest id → no replay, straight to live', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    publish(hub, { state: 'running' }); // 1
    const sock = new FakeSocket();
    connect(hub, sock, '1');
    expect(sock.sent).toEqual([]);
    publish(hub, { state: 'done' }); // 2
    expect(eventIds(sock)).toEqual(['2']);
    hub.close();
  });

  it('resync when the hub never emitted an event (previous epoch)', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const sock = new FakeSocket();
    connect(hub, sock, '50');
    expect(frames(sock).map((f) => f.type)).toEqual(['resync']);
    hub.close();
  });

  it('resync when the cursor is AHEAD of the newest id (restart epoch skew)', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    publish(hub, { state: 'running' }); // 1
    const sock = new FakeSocket();
    connect(hub, sock, '50');
    expect(frames(sock).map((f) => f.type)).toEqual(['resync']);
    hub.close();
  });

  it('resync at the buffer boundary: cursor below the eviction watermark', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0, capacity: 3 });
    publish(hub, { id: 'a', state: 'queued' }); // 1
    publish(hub, { id: 'a', state: 'running' }); // 2
    publish(hub, { id: 'a', state: 'running' }); // 3
    publish(hub, { id: 'a', state: 'done' }); // 4 → evicts id 1 (watermark 1)
    publish(hub, { id: 'a', state: 'failed' }); // 5 → evicts id 2 (watermark 2)
    const behind = new FakeSocket();
    connect(hub, behind, '1');
    expect(frames(behind).map((f) => f.type)).toEqual(['resync']);
    // The boundary case: the cursor AT the watermark is exactly reconstructable.
    const exact = new FakeSocket();
    connect(hub, exact, '2');
    expect(eventIds(exact)).toEqual(['3', '4', '5']);
    hub.close();
  });

  it('resync at the AGE boundary: exactly 15 min is beyond the buffer', (): void => {
    let now = 0;
    const hub = new WsHub({ tickIntervalMs: 0, now: () => now });
    publish(hub, { id: 'a', state: 'running' }); // 1 @ t=0
    publish(hub, { id: 'a', state: 'done' }); // 2 @ t=0
    // 1 ms under the bound → retained → exact replay.
    now = MAX_AGE_MS - 1;
    const fresh = new FakeSocket();
    connect(hub, fresh, '1');
    expect(eventIds(fresh)).toEqual(['2']);
    // Exactly AT the bound → swept → resync (cursor 1 < watermark 2).
    now = MAX_AGE_MS;
    const aged = new FakeSocket();
    connect(hub, aged, '1');
    expect(frames(aged).map((f) => f.type)).toEqual(['resync']);
    hub.close();
  });

  it('a malformed or non-hello first frame answers resync (safe fallback)', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    publish(hub, { state: 'running' });
    const garbage = new FakeSocket();
    hub.onMessage(hub.connect(garbage), '{not json');
    expect(frames(garbage).map((f) => f.type)).toEqual(['resync']);
    const wrong = new FakeSocket();
    hub.onMessage(hub.connect(wrong), JSON.stringify({ type: 'hello', lastEventId: 'not-a-number' }));
    expect(frames(wrong).map((f) => f.type)).toEqual(['resync']);
    // A valid-JSON frame that is NOT a hello is a handshake protocol
    // violation → same safe fallback: resync, then live.
    const ping = new FakeSocket();
    hub.onMessage(hub.connect(ping), JSON.stringify({ type: 'ping' }));
    expect(frames(ping).map((f) => f.type)).toEqual(['resync']);
    // After the handshake, later frames are ignored (no re-hello, no
    // resync for chatter on a live connection).
    const live = new FakeSocket();
    const sub = connect(hub, live, '1');
    hub.onMessage(sub, JSON.stringify({ type: 'ping' }));
    hub.onMessage(sub, 'garbage');
    publish(hub, { state: 'done' }); // 2 — still streaming live
    expect(eventIds(live)).toEqual(['2']);
    hub.close();
  });

  it('re-hello on the same connection is ignored', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    publish(hub, { state: 'running' }); // 1
    publish(hub, { state: 'done' }); // 2
    const sock = new FakeSocket();
    const sub = connect(hub, sock, '1');
    hub.onMessage(sub, JSON.stringify({ type: 'hello', lastEventId: '1' }));
    expect(eventIds(sock)).toEqual(['2']);
    hub.close();
  });

  it('capacity defaults to the D19 constants (1000 events / 15 min)', (): void => {
    expect(WS_RING_CAPACITY).toBe(1000);
    expect(WS_RING_MAX_AGE_MS).toBe(15 * 60 * 1000);
    const hub = new WsHub({ tickIntervalMs: 0 });
    for (let i = 0; i < 1001; i += 1) {
      publish(hub, { id: 'job-1', state: 'running' }); // one job, 1001 updates
    }
    expect(hub.stats.bufferedEvents).toBe(1000);
    expect(hub.stats.lastEvictedId).toBe(1);
    // Cursor BELOW the watermark → not reconstructable → resync.
    const behind = new FakeSocket();
    connect(hub, behind, '0');
    expect(frames(behind).map((f) => f.type)).toEqual(['resync']);
    // The watermark itself and everything above it are exact replays.
    const atWatermark = new FakeSocket();
    connect(hub, atWatermark, '1');
    expect(eventIds(atWatermark)).toEqual(
      Array.from({ length: 1000 }, (_, i) => String(i + 2)),
    );
    const above = new FakeSocket();
    connect(hub, above, '2');
    expect(eventIds(above).length).toBe(999);
    expect(eventIds(above)[0]).toBe('3');
    hub.close();
  });
});

describe('WsHub — D21 slow-consumer policy (drop-oldest + gap marker)', (): void => {
  it('drops the OLDEST queued events and keeps ONE contiguous gap marker', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0, queueLimit: 4, bufferedLimitBytes: 1 });
    const sock = new StalledSocket();
    connect(hub, sock);
    for (let i = 0; i < 10; i += 1) {
      publish(hub, { state: 'running' });
    }
    expect(sock.sent).toHaveLength(0); // stalled reader — everything parked
    expect(hub.stats.droppedEvents).toBe(6); // events 1..6 dropped so far
    expect(hub.stats.queuedMessages).toBeGreaterThan(0);
    // Stall ends → the next publish triggers the pump → parked frames flush.
    sock.stalled = false;
    publish(hub, { state: 'running' }); // id 11 — enqueue drops 7th + flushes
    expect(hub.stats.droppedEvents).toBe(7);
    const all = frames(sock);
    const gaps = all.filter((f) => f.type === 'gap');
    const kept = all.filter((f) => f.type === 'event').map((f) => Number(f.id));
    expect(gaps).toHaveLength(1);
    const gap = gaps[0] as Frame & { fromId: string; toId: string };
    expect(Number(gap.fromId)).toBe(1);
    expect(kept).toEqual([8, 9, 10, 11]); // the newest survive, drop-oldest took the head
    // Coverage: gap range ∪ kept ids == 1..11, disjoint.
    const covered = new Set<number>(kept);
    for (let id = Number(gap.fromId); id <= Number(gap.toId); id += 1) {
      expect(covered.has(id)).toBe(false);
      covered.add(id);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(hub.stats.droppedEvents + kept.length).toBe(11);
  });

  it('merge invariant holds over a long overflow run (single contiguous range)', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0, queueLimit: 4, bufferedLimitBytes: 1 });
    const sock = new StalledSocket();
    connect(hub, sock);
    for (let i = 0; i < 40; i += 1) {
      publish(hub, { state: 'running' });
    }
    sock.stalled = false;
    publish(hub, { state: 'running' }); // 41 — flush trigger
    const all = frames(sock);
    const gaps = all.filter((f) => f.type === 'gap');
    const kept = all.filter((f) => f.type === 'event').map((f) => Number(f.id));
    expect(gaps).toHaveLength(1);
    const gap = gaps[0] as Frame & { fromId: string; toId: string };
    expect(Number(gap.fromId)).toBe(1);
    expect(Number(gap.toId)).toBe(Math.min(...kept) - 1);
    expect([...kept].sort((a, b) => a - b)).toEqual(kept); // strictly increasing arrival
    const covered = new Set<number>(kept);
    for (let id = Number(gap.fromId); id <= Number(gap.toId); id += 1) {
      covered.add(id);
    }
    expect(covered.size).toBe(41);
    expect(hub.stats.droppedEvents + kept.length).toBe(41);
  });

  it('a resync hint survives queue overflow (re-emitted at the tail)', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0, queueLimit: 4, bufferedLimitBytes: 1 });
    const sock = new StalledSocket();
    // Hub has no events → the hello answers resync into the (unbounded) queue.
    connect(hub, sock, '0');
    for (let i = 0; i < 10; i += 1) {
      publish(hub, { state: 'running' }); // bounded phase — overflow drops the hint
    }
    sock.stalled = false;
    publish(hub, { state: 'running' }); // flush trigger
    expect(frames(sock).some((f) => f.type === 'resync')).toBe(true);
  });

  it('a full-tail backfill is delivered complete with zero drops (unbounded hello phase)', (): void => {
    // queueLimit 4 ON PURPOSE: the hello replay is queued unbounded, so
    // a 50-event replay survives a bound that would drop-oldest in the
    // bounded live phase (covered by the tests above).
    const hub = new WsHub({ tickIntervalMs: 0, queueLimit: 4, bufferedLimitBytes: 1 });
    for (let i = 0; i < 50; i += 1) {
      publish(hub, { state: 'running' });
    }
    const sock = new FakeSocket(); // healthy reader — the pump drains instantly
    connect(hub, sock, '0');
    expect(eventIds(sock)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 1)));
    expect(frames(sock).some((f) => f.type === 'gap')).toBe(false);
    expect(hub.stats.droppedEvents).toBe(0);
    expect(hub.stats.queuedMessages).toBe(0);
    hub.close();
  });

  it('pump resumes draining once the reader stops stalling', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0, bufferedLimitBytes: 1 });
    const sock = new FakeSocket();
    sock.buffered = Number.MAX_SAFE_INTEGER; // stalled
    connect(hub, sock);
    publish(hub, { state: 'running' }); // 1 → queued, parked
    expect(sock.sent).toHaveLength(0);
    expect(hub.stats.queuedMessages).toBe(1);
    sock.buffered = 0; // stall ends
    publish(hub, { state: 'done' }); // 2 → enqueue pumps both
    expect(eventIds(sock)).toEqual(['1', '2']);
    expect(hub.stats.queuedMessages).toBe(0);
    hub.close();
  });

  it('onClose discards the subscriber and its queue', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const sock = new FakeSocket();
    const sub = connect(hub, sock);
    hub.onClose(sub);
    expect(hub.stats.subscribers).toBe(0);
    publish(hub, { state: 'running' }); // no subscribers → buffered only
    expect(sock.sent).toHaveLength(0);
    hub.close();
  });

  it('close() closes every subscriber socket (1001) and is idempotent', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.connect(a);
    hub.connect(b);
    hub.close();
    hub.close();
    expect(a.closedWith?.code).toBe(1001);
    expect(b.closedWith?.code).toBe(1001);
    expect(() => publish(hub)).toThrow(/closed/);
  });
});
