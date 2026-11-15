/**
 * `/ws` integration tests (DESIGN.md §10 + D19 + D21) over REAL loopback
 * WebSockets — the vitest offline guard allows loopback sockets. These
 * are the acceptance tests:
 *
 * 1. live events: connect → hello → publish → received on the wire;
 * 2. exact backfill: disconnect mid-job → N events emitted → reconnect
 *    with lastEventId → receives EXACTLY the missing sequence, then live;
 * 3. beyond-buffer/age reconnects → the `resync` hint (buffer boundary
 *    at the D19 constants: 1001 events against a 1000-event ring);
 * 4. multiple concurrent subscribers;
 * 5. the D21 slow-consumer policy under a genuinely STALLED reader
 *    (paused client socket): drop-oldest + gap marker asserted on the
 *    wire — every published id is covered exactly once by
 *    {received events} ∪ {gap ranges}, in order, with no duplicates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocket as WsClient } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildHarness, type Harness } from '../helpers.js';
import { WsHub, type WsHubStats } from '../../../src/api/ws/hub.js';
import { DEFAULT_WS_PATH } from '../../../src/api/ws/attach.js';
import { WS_RING_MAX_AGE_MS, type JobT } from '@fmd/contract';

const HOST = '127.0.0.1';

interface Frame {
  type: string;
  id?: string;
  fromId?: string;
  toId?: string;
  job?: JobT;
}

// ── harness ──────────────────────────────────────────────────────────

interface Running {
  readonly app: FastifyInstance;
  readonly hub: WsHub;
  readonly port: number;
  readonly jobs: Harness['jobs'];
  close(): Promise<void>;
}

async function startServer(
  hubOptions: ConstructorParameters<typeof WsHub>[0] = {},
): Promise<Running> {
  const hub = new WsHub({ tickIntervalMs: 0, ...hubOptions });
  const harness = buildHarness({ wsHub: hub });
  const app = harness.app;
  await app.listen({ port: 0, host: HOST });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    hub,
    port,
    jobs: harness.jobs,
    close: async (): Promise<void> => {
      await app.close(); // the onClose hook disposes the hub attachment
    },
  };
}

// ── ws client helpers ────────────────────────────────────────────────

function connect(port: number, path: string = DEFAULT_WS_PATH): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${String(port)}${path}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connect timed out'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function send(ws: WsClient, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

/** Receive exactly `count` frames. */
function collect(ws: WsClient, count: number, timeoutMs = 10_000): Promise<Frame[]> {
  const frames: Frame[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`collect timed out with ${String(frames.length)}/${String(count)} frame(s)`));
    }, timeoutMs);
    function onMessage(data: unknown): void {
      frames.push(JSON.parse(String(data)) as Frame);
      if (frames.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(frames);
      }
    }
    ws.on('message', onMessage);
  });
}

/** Accumulate every frame into a plain array until `stop()` — for the
 * stalled-reader test, which asserts on the FULL received set. */
function recorder(ws: WsClient): { readonly frames: Frame[]; stop(): void } {
  const frames: Frame[] = [];
  const onMessage = (data: unknown): void => {
    frames.push(JSON.parse(String(data)) as Frame);
  };
  ws.on('message', onMessage);
  return {
    frames,
    stop: (): void => {
      ws.off('message', onMessage);
    },
  };
}

function hello(ws: WsClient, lastEventId?: string): void {
  send(ws, lastEventId !== undefined ? { type: 'hello', lastEventId } : { type: 'hello' });
}

/** Expect a rejected upgrade on `path` (plain-HTTP error response). */
function expectRejectedUpgrade(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${String(port)}${path}`);
    ws.once('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.once('open', () => {
      ws.close();
      reject(new Error(`upgrade to ${path} should have been rejected`));
    });
    ws.once('error', (err: Error) => reject(err));
  });
}

// ── fixtures ─────────────────────────────────────────────────────────

let jobSeq = 0;
function job(overrides: Partial<JobT> = {}): JobT {
  jobSeq += 1;
  const id = overrides.id ?? String(jobSeq);
  return {
    id,
    type: 'download',
    moduleId: 'a'.repeat(32),
    payload: { moduleId: 'a'.repeat(32), mangaUrl: 'https://ex.org/manga', chapterLink: `ch/${id}` },
    state: 'queued',
    priority: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function publish(hub: WsHub, overrides: Partial<JobT> = {}): string {
  return hub.publish(job(overrides)).id;
}

/** Wait until `predicate` on the hub stats holds (busy server settle). */
async function waitForHub(hub: WsHub, predicate: (stats: WsHubStats) => boolean): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 10) {
    if (predicate(hub.stats)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('hub settle condition not met');
}

const openServers: Running[] = [];
const openClients: WsClient[] = [];

afterEach(async (): Promise<void> => {
  for (const client of openClients.splice(0)) {
    client.removeAllListeners();
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.terminate();
    }
  }
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function track(server: Promise<Running>): Promise<Running> {
  const running = await server;
  openServers.push(running);
  return running;
}

// ── tests ────────────────────────────────────────────────────────────

describe('/ws — live events', (): void => {
  it('delivers published job events to a live subscriber in order', async (): Promise<void> => {
    const server = await track(startServer());
    const ws = await connect(server.port);
    openClients.push(ws);
    hello(ws);
    const received = collect(ws, 3);
    publish(server.hub, { id: 'j1', state: 'running' }); // 1
    publish(server.hub, { id: 'j1', state: 'running', progress: { page: 2 } }); // 2
    publish(server.hub, { id: 'j2', state: 'done' }); // 3
    const frames = await received;
    expect(frames.map((f) => f.id)).toEqual(['1', '2', '3']);
    expect(frames.map((f) => f.job?.id)).toEqual(['j1', 'j1', 'j2']);
    expect(frames[2]?.job?.state).toBe('done');
    // Frames are contract-valid: the hub validated them, but assert the
    // envelope too (id + snapshot pairing).
    expect(frames.every((f) => f.type === 'event')).toBe(true);
  });

  it('a hello without lastEventId gets the full buffered tail, then live events', async (): Promise<void> => {
    const server = await track(startServer());
    const first = publish(server.hub, { state: 'queued' }); // pre-dates the client
    const ws = await connect(server.port);
    openClients.push(ws);
    hello(ws);
    const received = collect(ws, 2); // tail frame + the live frame below
    const second = publish(server.hub, { state: 'done' });
    const frames = await received;
    expect(frames.map((f) => f.id)).toEqual([first, second]);
    expect(Number(second)).toBe(Number(first) + 1);
  });

  it('another server route keeps working alongside the upgrade path', async (): Promise<void> => {
    const server = await track(startServer());
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('/ws — D19 exact backfill (acceptance)', (): void => {
  it('disconnect mid-job → events emitted → reconnect with lastEventId receives EXACTLY the missing sequence then live', async (): Promise<void> => {
    const server = await track(startServer());
    const port = server.port;

    // Session 1: live client sees events 1..3.
    const first = await connect(port);
    openClients.push(first);
    hello(first);
    const seenFirst = collect(first, 3);
    publish(server.hub, { id: 'jobA', state: 'queued' }); // 1
    publish(server.hub, { id: 'jobA', state: 'running' }); // 2
    publish(server.hub, { id: 'jobB', state: 'queued' }); // 3
    expect((await seenFirst).map((f) => f.id)).toEqual(['1', '2', '3']);

    // Disconnect mid-job (jobA still running), then the server emits
    // events the client will miss — interleaved across two jobs.
    first.close();
    await waitForHub(server.hub, (stats) => stats.subscribers === 0);
    publish(server.hub, { id: 'jobB', state: 'running' }); // 4
    publish(server.hub, { id: 'jobA', state: 'retry' }); // 5
    publish(server.hub, { id: 'jobA', state: 'running', progress: { page: 40 } }); // 6
    publish(server.hub, { id: 'jobA', state: 'done' }); // 7

    // Session 2: reconnect with the last seen cursor (event 3). The
    // exact sequence — the missing 4..7 then 8 — arrives in order
    // whether the hub replays event 8 from the buffer (hello raced the
    // publish) or streams it live: at the client the seam is invisible,
    // which is the property under test.
    const second = await connect(port);
    openClients.push(second);
    hello(second, '3');
    const rest = collect(second, 5);
    publish(server.hub, { id: 'jobB', state: 'done' }); // 8 — the live seam
    expect((await rest).map((f) => f.id)).toEqual(['4', '5', '6', '7', '8']);
    // No duplicates anywhere: the client's event id sequence is exactly 1..8.
    const allIds = ['1', '2', '3', ...(await rest).map((f) => f.id as string)];
    expect(allIds).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });
});

describe('/ws — D19 resync hint (acceptance: beyond buffer + age)', (): void => {
  it('beyond-buffer reconnect (1001 events vs 1000 ring) receives resync; cursors at the watermark replay exactly', async (): Promise<void> => {
    const server = await track(startServer());
    for (let i = 0; i < 1001; i += 1) {
      publish(server.hub, { id: 'job', state: 'running', progress: { i } });
    }
    expect(server.hub.stats.bufferedEvents).toBe(1000);
    expect(server.hub.stats.lastEvictedId).toBe(1);

    const stale = await connect(server.port);
    openClients.push(stale);
    hello(stale, '0'); // needs event 1 — evicted
    const hint = await collect(stale, 1);
    expect(hint.map((f) => f.type)).toEqual(['resync']);

    const exact = await connect(server.port);
    openClients.push(exact);
    hello(exact, '1'); // at the watermark — the replay is exact (events 2..1001)
    const frames = await collect(exact, 1000);
    expect(frames.map((f) => f.id)).toEqual(
      Array.from({ length: 1000 }, (_, i) => String(i + 2)),
    );
  }, 30_000);

  it('age boundary: at exactly 15 min the buffer is gone → resync; 1 ms under → exact replay', async (): Promise<void> => {
    let now = 1_000_000;
    const server = await track(startServer({ now: () => now }));
    publish(server.hub, { id: 'job', state: 'queued' }); // 1
    publish(server.hub, { id: 'job', state: 'running' }); // 2

    const fresh = await connect(server.port);
    openClients.push(fresh);
    hello(fresh, '1');
    expect((await collect(fresh, 1)).map((f) => f.id)).toEqual(['2']);

    // 1 ms UNDER the max age: still reconstructable.
    now += WS_RING_MAX_AGE_MS - 1;
    const under = await connect(server.port);
    openClients.push(under);
    hello(under, '1');
    expect((await collect(under, 1)).map((f) => f.id)).toEqual(['2']);

    // Exactly AT the max age: swept → resync (cursor 1 < watermark 2).
    now += 1;
    const aged = await connect(server.port);
    openClients.push(aged);
    hello(aged, '1');
    expect((await collect(aged, 1)).map((f) => f.type)).toEqual(['resync']);
  });

  it('epoch skew: a cursor ahead of the newest id gets resync (restart semantics)', async (): Promise<void> => {
    const server = await track(startServer());
    publish(server.hub, { state: 'running' }); // 1
    const ws = await connect(server.port);
    openClients.push(ws);
    hello(ws, '500');
    expect((await collect(ws, 1)).map((f) => f.type)).toEqual(['resync']);
  });

  it('undecodable first frame → resync, and the wrong path is rejected at upgrade', async (): Promise<void> => {
    const server = await track(startServer());
    publish(server.hub, { state: 'running' });
    const ws = await connect(server.port);
    openClients.push(ws);
    ws.send('{not json');
    expect((await collect(ws, 1)).map((f) => f.type)).toEqual(['resync']);

    const status = await expectRejectedUpgrade(server.port, '/nope');
    expect(status).toBe(404);
  });
});

describe('/ws — multiple concurrent subscribers', (): void => {
  it('fans every event out to all subscribers, each with an independent backfill', async (): Promise<void> => {
    const server = await track(startServer());
    const a = await connect(server.port);
    const b = await connect(server.port);
    openClients.push(a, b);
    hello(a);
    hello(b);
    const gotA = collect(a, 2);
    const gotB = collect(b, 2);
    publish(server.hub, { id: 'job', state: 'running' }); // 1
    publish(server.hub, { id: 'job', state: 'done' }); // 2
    expect((await gotA).map((f) => f.id)).toEqual(['1', '2']);
    expect((await gotB).map((f) => f.id)).toEqual(['1', '2']);

    // A third subscriber reconnects with a mid-stream cursor: exact backfill.
    const c = await connect(server.port);
    openClients.push(c);
    hello(c, '1');
    expect((await collect(c, 1)).map((f) => f.id)).toEqual(['2']);
  });
});

describe('/ws — D21 slow-consumer policy under a stalled reader (acceptance)', (): void => {
  it('drop-oldest + gap marker: received ∪ gap ranges covers every published id exactly once', async (): Promise<void> => {
    // Small bounds to reach the policy quickly: queueLimit 16 makes
    // overflow immediate once the pump parks. The pump's backpressure
    // gate is INJECTED (the D21 `canSend` seam): the paused reader
    // below is the stall narrative, and the closed gate is what makes
    // the drill deterministic — a paused loopback reader alone does not
    // produce transport backpressure (the kernel rcvbuf absorbs the
    // whole burst), which is exactly why deployments can supply a
    // tighter `canSend` policy than the bufferedAmount default.
    let gateOpen = true;
    const server = await track(
      startServer({ queueLimit: 16, tickIntervalMs: 50, canSend: (): boolean => gateOpen }),
    );
    const hub = server.hub;
    const ws = await connect(server.port);
    openClients.push(ws);
    hello(ws);
    // The D21 bound applies to LIVE subscribers — wait for the hello to
    // be processed before stalling/publishing (deterministic).
    await waitForHub(hub, (stats) => stats.liveSubscribers === 1);

    // Stall the CLIENT-side socket (stop reading frames)…
    const raw = (ws as unknown as { _socket?: import('node:net').Socket })._socket;
    expect(raw).toBeDefined();
    raw?.pause();
    // …and close the pump gate (backpressure reported).
    gateOpen = false;

    const TOTAL = 200;
    const rec = recorder(ws);
    for (let i = 0; i < TOTAL; i += 1) {
      publish(hub, { id: 'job', state: 'running', progress: { blob: 'x'.repeat(200), i } });
    }
    // Drops must actually have happened under the stall.
    await waitForHub(hub, (stats) => stats.droppedEvents > 0);
    // Resume the reader and reopen the gate; the tick pumps the parked
    // queue dry.
    gateOpen = true;
    raw?.resume();
    await waitForHub(hub, (stats) => stats.queuedMessages === 0);
    // Let the socket deliver the last flushed frames, then stop recording.
    await new Promise((resolve) => setTimeout(resolve, 500));
    rec.stop();

    // Everything the client got (events + gap ranges) must cover 1..TOTAL
    // exactly once, with events strictly increasing and gap markers
    // interleaved between them.
    const seen = rec.frames.filter((f) => f.type === 'event').map((f) => Number(f.id));
    const gaps = rec.frames
      .filter((f) => f.type === 'gap')
      .map((f) => ({ from: Number(f.fromId), to: Number(f.toId) }));
    expect(seen.length).toBeGreaterThan(0);
    expect(gaps.length).toBeGreaterThan(0);
    expect(hub.stats.droppedEvents).toBe(TOTAL - seen.length); // drop-oldest accounted

    const covered = new Set<number>(seen);
    for (const gap of gaps) {
      expect(gap.from).toBeLessThanOrEqual(gap.to);
      for (let id = gap.from; id <= gap.to; id += 1) {
        expect(covered.has(id)).toBe(false); // no duplicates, disjoint ranges
        covered.add(id);
      }
    }
    expect([...covered].sort((x, y) => x - y)).toEqual(
      Array.from({ length: TOTAL }, (_, i) => i + 1),
    );
    // Events arrive in publish order (the client cursor stays sound).
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
  }, 45_000);
});
