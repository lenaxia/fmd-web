/**
 * Site-availability store + service (dead-site discovery): the persisted
 * per-module record over a REAL app.db (temp dir, better-sqlite3), the
 * self-healing flip-back (a later reachable write flips unreachable —
 * by construction, no timers), and the manual-Check contract through a
 * scripted probe (the worker op is pinned separately in the
 * engine-thread suite; classification lives HERE regardless of which
 * transport answered).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openQueueDb } from '../../src/jobs/queue/connection.js';
import {
  SqliteSiteAvailabilityService,
  SqliteSiteAvailabilityStore,
  UNKNOWN_AVAILABILITY,
} from '../../src/runtime/site-availability.js';

const dir = mkdtempSync(join(tmpdir(), 'fmd-availability-'));
const db = openQueueDb(join(dir, 'app.db'));
const store = new SqliteSiteAvailabilityStore(db);

afterAll((): void => {
  rmSync(dir, { recursive: true, force: true });
});

/** Deterministic clock: every write advances 1 minute. */
let clock = Date.parse('2026-11-19T00:00:00Z');

function serviceWithProbe(
  probe: (moduleId: string) => Promise<{ readonly resultCode: number; readonly resultString: string }>,
): SqliteSiteAvailabilityService {
  return new SqliteSiteAvailabilityService(
    store,
    probe,
    (): number => {
      const at = clock;
      clock += 60_000;
      return at;
    },
  );
}

describe('SqliteSiteAvailabilityStore (the persisted record)', (): void => {
  it('absent row reads unknown — seeded, silent, never-touched state', (): void => {
    expect(store.read('a'.repeat(32))).toEqual(UNKNOWN_AVAILABILITY);
    expect(store.read('a'.repeat(32)).checkedAt).toBeNull();
  });

  it('writes unreachable + reason with checked_at; list() serves the join', (): void => {
    store.write('b'.repeat(32), 'unreachable', 'connect ECONNREFUSED 127.0.0.1:9', 1000);
    const record = store.read('b'.repeat(32));
    expect(record.status).toBe('unreachable');
    expect(record.reason).toBe('connect ECONNREFUSED 127.0.0.1:9');
    expect(record.checkedAt).toBe(new Date(1000).toISOString());
    expect(store.readAll().get('b'.repeat(32))?.status).toBe('unreachable');
  });

  it('SELF-HEALING: a later reachable write flips the record back (no timers anywhere)', (): void => {
    store.write('c'.repeat(32), 'unreachable', 'timeout', 1000);
    store.write('c'.repeat(32), 'reachable', null, 2000);
    const record = store.read('c'.repeat(32));
    expect(record.status).toBe('reachable');
    expect(record.reason).toBeNull();
    expect(record.checkedAt).toBe(new Date(2000).toISOString());
  });
});

describe('SqliteSiteAvailabilityService (record + Check through the one classifier)', (): void => {
  it('record() persists an opportunistic outcome (reachable write has no reason)', (): void => {
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.reject(new Error('never probed')),
    );
    service.record('d'.repeat(32), { verdict: 'unreachable', reason: 'timeout after 15000ms' });
    expect(service.get('d'.repeat(32))).toMatchObject({ status: 'unreachable', reason: 'timeout after 15000ms' });
    service.record('d'.repeat(32), { verdict: 'reachable' });
    expect(service.get('d'.repeat(32))).toMatchObject({ status: 'reachable', reason: null });
  });

  it('check(): a 2xx probe writes reachable + reports the verdict', async (): Promise<void> => {
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.resolve({ resultCode: 200, resultString: 'OK' }),
    );
    const result = await service.check('e'.repeat(32));
    expect(result.verdict).toBe('reachable');
    expect(result.detail).toBe('Reachable (HTTP 200)');
    expect(result.availability).toMatchObject({ status: 'reachable' });
    expect(service.get('e'.repeat(32)).status).toBe('reachable');
  });

  it('check(): a transport failure writes unreachable + the transport reason', async (): Promise<void> => {
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.resolve({ resultCode: 500, resultString: 'getaddrinfo ENOTFOUND dead.test' }),
    );
    const result = await service.check('f'.repeat(32));
    expect(result.verdict).toBe('unreachable');
    expect(result.availability).toMatchObject({
      status: 'unreachable',
      reason: 'getaddrinfo ENOTFOUND dead.test',
    });
  });

  it('check(): a 523 answer writes unreachable (the Cloudflare family)', async (): Promise<void> => {
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.resolve({ resultCode: 523, resultString: 'Origin Unreachable' }),
    );
    const result = await service.check('1'.repeat(32));
    expect(result.verdict).toBe('unreachable');
    expect(result.availability.reason).toBe('Origin Unreachable');
  });

  it('check(): a 4xx answer is verdict none — the record stays UNCHANGED', async (): Promise<void> => {
    // pre-seed a reachable record so "unchanged" is observable
    store.write('2'.repeat(32), 'reachable', null, 1234);
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.resolve({ resultCode: 403, resultString: 'Forbidden' }),
    );
    const result = await service.check('2'.repeat(32));
    expect(result.verdict).toBe('none');
    expect(result.detail).toContain('403');
    expect(result.availability).toMatchObject({ status: 'reachable' });
    expect(service.get('2'.repeat(32)).status).toBe('reachable');
  });

  it('check(): probe errors propagate typed (the API surface maps the envelope)', async (): Promise<void> => {
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.reject(new Error('engine thread died: exit code 1')),
    );
    await expect(service.check('3'.repeat(32))).rejects.toThrow('engine thread died');
    // and nothing was written for the module
    expect(service.get('3'.repeat(32))).toEqual(UNKNOWN_AVAILABILITY);
  });

  it('checked_at advances with every confident write (the live clock seam)', async (): Promise<void> => {
    const service = serviceWithProbe((): Promise<{ resultCode: number; resultString: string }> =>
      Promise.resolve({ resultCode: 200, resultString: 'OK' }),
    );
    const first = await service.check('4'.repeat(32));
    const second = await service.check('4'.repeat(32));
    expect(new Date(second.availability.checkedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(first.availability.checkedAt ?? 0).getTime(),
    );
  });
});
