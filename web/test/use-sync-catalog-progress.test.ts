// @vitest-environment jsdom

/**
 * useSyncCatalogProgress (site-first browse): the typed provision
 * state machine — WS `sync` frames for the matching job key reduce
 * idle → installing → ready|no-catalog|failed; terminal states are
 * settled; foreign job keys are ignored; the REST-free reducer is
 * exercised purely, the hook through a mock socket (D19 controller).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CatalogSyncProgressT } from '@fmd/contract';
import {
  INITIAL_PROVISION,
  reduceProvision,
  useSyncCatalogProgress,
} from '../src/state/use-sync-catalog-progress';
import { catalogSyncJobId } from '../src/state/ws-protocol';
import type { WsLike } from '../src/state/ws-backfill';

const MODULE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function sync(jobId: string, phase: CatalogSyncProgressT['phase'], extra?: Partial<CatalogSyncProgressT>): CatalogSyncProgressT {
  return { jobId, moduleId: MODULE_ID, phase, ...extra };
}

describe('reduceProvision (pure state machine)', (): void => {
  const jobId = catalogSyncJobId(MODULE_ID);

  it('idle → installing on every non-terminal phase, carrying detail/percent', (): void => {
    const a = reduceProvision(INITIAL_PROVISION, sync(jobId, 'checking'));
    expect(a).toEqual({ state: 'installing', phase: 'checking' });
    const b = reduceProvision(a, sync(jobId, 'downloading', { percent: 40 }));
    expect(b).toEqual({ state: 'installing', phase: 'downloading', percent: 40 });
    const c = reduceProvision(b, sync(jobId, 'installing', { detail: 'renaming' }));
    expect(c).toEqual({ state: 'installing', phase: 'installing', percent: 40, detail: 'renaming' });
  });

  it('terminal outcomes: ready / no-catalog / failed', (): void => {
    const installing = reduceProvision(INITIAL_PROVISION, sync(jobId, 'downloading'));
    expect(reduceProvision(installing, sync(jobId, 'done', { outcome: 'updated' }))).toEqual({ state: 'ready' });
    expect(reduceProvision(installing, sync(jobId, 'done', { outcome: 'unchanged' }))).toEqual({ state: 'ready' });
    expect(reduceProvision(installing, sync(jobId, 'done', { outcome: 'no-catalog', detail: 'HTTP 404' }))).toEqual({
      state: 'no-catalog',
      detail: 'HTTP 404',
    });
    expect(reduceProvision(installing, sync(jobId, 'failed', { detail: 'socket hang up' }))).toEqual({
      state: 'failed',
      detail: 'socket hang up',
    });
  });

  it('terminal states are settled — later frames cannot flip them', (): void => {
    const ready = reduceProvision(INITIAL_PROVISION, sync(jobId, 'done', { outcome: 'updated' }));
    expect(reduceProvision(ready, sync(jobId, 'downloading'))).toBe(ready);
    const failed = reduceProvision(INITIAL_PROVISION, sync(jobId, 'failed'));
    expect(reduceProvision(failed, sync(jobId, 'done', { outcome: 'updated' }))).toBe(failed);
  });
});

/** Minimal recording socket double (the controller binds handlers). */
class FakeWebSocket implements WsLike {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  // Test helpers
  open(): void {
    this.onopen?.();
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe('useSyncCatalogProgress (hook over the D19 controller)', (): void => {
  afterEach((): void => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
  });

  it('subscribes to the job key, reduces frames, and ignores foreign keys', (): void => {
    const jobId = catalogSyncJobId(MODULE_ID);
    const { result } = renderHook((): ReturnType<typeof useSyncCatalogProgress> =>
      useSyncCatalogProgress({ jobId, webSocketFactory: (url): WsLike => new FakeWebSocket(url) }),
    );
    expect(result.current.machine).toEqual({ state: 'idle' });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    act((): void => {
      socket?.open();
    });
    // hello carries no cursor (first connect)
    expect(socket?.sent[0]).toContain('"type":"hello"');

    act((): void => {
      socket?.push({ type: 'sync', id: '1', sync: sync(jobId, 'checking') });
    });
    expect(result.current.machine).toEqual({ state: 'installing', phase: 'checking' });
    expect(result.current.inFlight).toBe(true);

    // A foreign job key must not touch the machine…
    act((): void => {
      socket?.push({ type: 'sync', id: '2', sync: sync('catalog-sync:other', 'downloading') });
    });
    expect(result.current.machine).toEqual({ state: 'installing', phase: 'checking' });

    // …but its id still advances the shared cursor (D19 discipline).
    act((): void => {
      socket?.push({ type: 'sync', id: '3', sync: sync(jobId, 'done', { outcome: 'no-catalog' }) });
    });
    expect(result.current.machine).toEqual({ state: 'no-catalog' });
    expect(result.current.inFlight).toBe(false);
  });

  it('re-arms via reset() (a retry attempt starts from idle)', (): void => {
    const jobId = catalogSyncJobId(MODULE_ID);
    const { result } = renderHook((): ReturnType<typeof useSyncCatalogProgress> =>
      useSyncCatalogProgress({ jobId, webSocketFactory: (url): WsLike => new FakeWebSocket(url) }),
    );
    const socket = FakeWebSocket.instances[0];
    act((): void => {
      socket?.open();
      socket?.push({ type: 'sync', id: '1', sync: sync(jobId, 'failed', { detail: 'boom' }) });
    });
    expect(result.current.machine).toEqual({ state: 'failed', detail: 'boom' });
    act((): void => {
      result.current.reset();
    });
    expect(result.current.machine).toEqual({ state: 'idle' });
  });

  it('idle without a job key: no socket is ever opened', (): void => {
    const { result } = renderHook((): ReturnType<typeof useSyncCatalogProgress> =>
      useSyncCatalogProgress({ webSocketFactory: (url): WsLike => new FakeWebSocket(url) }),
    );
    expect(result.current.status).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
