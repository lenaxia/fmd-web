/**
 * Site-first browse WS surface: `WsHub.publishSync` streams catalog
 * provision progress through the SAME D19 ring/replay machinery as
 * job events — live fanout, per-key (`catalog-sync:<moduleId>`)
 * buffering and exact reconnect backfill.
 */
import { describe, expect, it } from 'vitest';
import { WsHub, type HubSocket, type WsSubscription } from '../../../src/api/ws/hub.js';
import { catalogSyncJobId, type CatalogSyncProgressT } from '@fmd/contract';

class FakeSocket implements HubSocket {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  get bufferedAmount(): number {
    return 0;
  }
}

function hello(hub: WsHub, socket: FakeSocket, lastEventId?: string): WsSubscription {
  const sub = hub.connect(socket);
  hub.onMessage(sub, JSON.stringify({ type: 'hello', ...(lastEventId !== undefined ? { lastEventId } : {}) }));
  return sub;
}

function progress(moduleId: string, phase: CatalogSyncProgressT['phase'], outcome?: CatalogSyncProgressT['outcome']): CatalogSyncProgressT {
  return {
    jobId: catalogSyncJobId(moduleId),
    moduleId,
    phase,
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

describe('WsHub.publishSync (site-first browse)', (): void => {
  it('fans sync frames out to live subscribers with contract-exact shape', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const socket = new FakeSocket();
    hello(hub, socket);

    const message = hub.publishSync(progress('a'.repeat(32), 'downloading'));
    expect(message.type).toBe('sync');
    expect(message.sync.phase).toBe('downloading');
    expect(message.sync.jobId).toBe(catalogSyncJobId('a'.repeat(32)));

    const frames = socket.sent.map((f): Record<string, unknown> => JSON.parse(f) as Record<string, unknown>);
    const sync = frames.find((f): boolean => f['type'] === 'sync');
    expect(sync).toBeDefined();
    expect(sync?.['id']).toBe(message.id);
    expect((sync?.['sync'] as Record<string, unknown>)['moduleId']).toBe('a'.repeat(32));
    hub.close();
  });

  it('rejects malformed sync payloads at the contract boundary', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    expect((): void => {
      // percent out of range must not cross the hub
      hub.publishSync({ jobId: 'j', moduleId: 'm', phase: 'downloading', percent: 140 });
    }).toThrow();
    hub.close();
  });

  it('shares the D19 id space and replays sync frames exactly on reconnect', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const moduleId = 'b'.repeat(32);
    const first = hello(hub, new FakeSocket()); // live subscriber anchors the ids

    const e1 = hub.publishSync(progress(moduleId, 'checking'));
    const e2 = hub.publishSync(progress(moduleId, 'downloading'));
    const e3 = hub.publishSync(progress(moduleId, 'done', 'updated'));
    expect(Number(e2.id)).toBe(Number(e1.id) + 1);
    expect(Number(e3.id)).toBe(Number(e2.id) + 1);
    void first;

    // Reconnect with the cursor at e1: replays exactly e2, e3.
    const reconnect = new FakeSocket();
    hello(hub, reconnect, e1.id);
    const replayed = reconnect.sent
      .map((f): Record<string, unknown> => JSON.parse(f) as Record<string, unknown>)
      .filter((f): boolean => f['type'] === 'sync');
    expect(replayed.map((f): unknown => f['id'])).toEqual([e2.id, e3.id]);
    expect((replayed[1]?.['sync'] as Record<string, unknown>)['outcome']).toBe('updated');

    // A fresh connection (no cursor) gets the full buffered tail.
    const fresh = new FakeSocket();
    hello(hub, fresh);
    const tail = fresh.sent
      .map((f): Record<string, unknown> => JSON.parse(f) as Record<string, unknown>)
      .filter((f): boolean => f['type'] === 'sync');
    expect(tail.map((f): unknown => f['id'])).toEqual([e1.id, e2.id, e3.id]);
    hub.close();
  });

  it('buffers per sync-job key alongside job events without cross-talk', (): void => {
    const hub = new WsHub({ tickIntervalMs: 0 });
    const socket = new FakeSocket();
    hello(hub, socket);

    hub.publish({
      id: 'job-1',
      type: 'download',
      moduleId: 'a'.repeat(32),
      payload: {},
      state: 'queued',
      priority: 0,
      createdAt: '2026-11-16T00:00:00Z',
      updatedAt: '2026-11-16T00:00:00Z',
    });
    hub.publishSync(progress('c'.repeat(32), 'installing'));

    const frames = socket.sent.map((f): Record<string, unknown> => JSON.parse(f) as Record<string, unknown>);
    expect(frames.filter((f): boolean => f['type'] === 'event')).toHaveLength(1);
    expect(frames.filter((f): boolean => f['type'] === 'sync')).toHaveLength(1);
    expect(hub.stats.trackedJobs).toBe(2); // one job ring + one sync ring
    hub.close();
  });
});
