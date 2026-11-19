/**
 * [triage] API contract for the attention surface (D1 §2 TRIAGE,
 * tsk-granite-crown-orders): GET /api/triage (the grouped-by-cause
 * snapshot with the availability + registry-name joins) and POST
 * /api/triage/retry (the paced retry-all — pacing itself is pinned in
 * server/test/runtime/triage-retry-pacing.test.ts over the REAL lane;
 * this file pins the ROUTE contract: shape, grouping, the retry
 * action, typed 400 on an unknown cause, and the NEVER-gated posture
 * of a site_dead group).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createDefaultServices, type ApiServices } from '../../src/main.js';
import { InMemoryModuleService, InMemoryJobService } from '../../src/api/services.js';
import type { SiteAvailabilityRecord, SiteAvailabilityService } from '../../src/runtime/site-availability.js';
import { makeRegistration, MODULE_A_ID, MODULE_B_ID } from './helpers.js';

/** The availability seam as the triage join reads it (record store
 * only; the probe is not exercised on this surface). */
class FakeAvailability implements SiteAvailabilityService {
  readonly records = new Map<string, SiteAvailabilityRecord>();

  record(): void {
    // not scripted on this surface
  }

  get(moduleId: string): SiteAvailabilityRecord {
    return this.records.get(moduleId) ?? { status: 'unknown', checkedAt: null, reason: null };
  }

  list(): ReadonlyMap<string, SiteAvailabilityRecord> {
    return this.records;
  }

  async check(): Promise<never> {
    throw new Error('check is not scripted in the triage API suite');
  }
}

interface TriageWire {
  readonly failedTotal: number;
  readonly groups: ReadonlyArray<{
    readonly cause: string;
    readonly count: number;
    readonly sites: ReadonlyArray<{
      readonly moduleId: string;
      readonly siteName: string | null;
      readonly availability: { readonly status: string };
      readonly jobs: ReadonlyArray<{ readonly id: string; readonly failureKind: string }>;
    }>;
  }>;
}

function appWith(jobs: InMemoryJobService, availability: FakeAvailability | undefined): ReturnType<typeof buildApp> {
  const modules = new InMemoryModuleService(
    [makeRegistration({ id: MODULE_A_ID, name: 'AlphaSource' }), makeRegistration({ id: MODULE_B_ID, name: 'BetaSource' })],
    false,
    (): boolean => false,
  );
  const services: ApiServices = {
    ...createDefaultServices({ modules, jobs }),
    ...(availability !== undefined ? { availability } : {}),
  };
  return buildApp(services, { version: '0.1.0-test' });
}

let keySeed = 0;

async function createFailed(
  app: ReturnType<typeof buildApp>,
  jobs: InMemoryJobService,
  moduleId: string,
  failure: { readonly failureKind: 'worker_stalled' | 'engine_oom' | 'net' | 'pack'; readonly error?: string },
): Promise<string> {
  keySeed += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs/download',
    payload: {
      moduleId,
      mangaUrl: 'https://ex.org/manga/x',
      mangaTitle: 'Fixture Manga',
      chapterLink: 'https://ex.org/manga/x/1',
      chapterName: 'Ch. 1',
      idempotencyKey: `triage-key-${String(keySeed)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { job: { id: string } }).job.id;
  jobs.forceState(id, 'failed', undefined, undefined, failure);
  return id;
}

async function snapshot(app: ReturnType<typeof buildApp>): Promise<TriageWire> {
  const res = await app.inject({ method: 'GET', url: '/api/triage' });
  expect(res.statusCode).toBe(200);
  return res.json() as TriageWire;
}

describe('GET /api/triage — the attention snapshot', (): void => {
  it('healthy state: all four groups present with count 0 + failedTotal 0', async (): Promise<void> => {
    const app = appWith(new InMemoryJobService(), new FakeAvailability());
    const snap = await snapshot(app);
    expect(snap.groups.map((group): string => group.cause)).toEqual(['site_dead', 'antibot', 'throttled', 'other']);
    expect(snap.groups.every((group): boolean => group.count === 0 && group.sites.length === 0)).toBe(true);
    expect(snap.failedTotal).toBe(0);
  });

  it('groups by cause with counts, site buckets, registry-name + availability joins', async (): Promise<void> => {
    const jobs = new InMemoryJobService();
    const availability = new FakeAvailability();
    availability.records.set(MODULE_A_ID, {
      status: 'unreachable',
      checkedAt: '2026-01-02T00:00:00.000Z',
      reason: 'connect ECONNREFUSED',
    });
    const app = appWith(jobs, availability);
    await createFailed(app, jobs, MODULE_A_ID, { failureKind: 'net', error: 'connection reset' });
    await createFailed(app, jobs, MODULE_B_ID, { failureKind: 'net', error: '#0: HTTP 429 too many requests' });

    const snap = await snapshot(app);
    expect(snap.failedTotal).toBe(2);
    const byCause = new Map(snap.groups.map((group): [string, typeof group] => [group.cause, group]));
    // the [site-availability] join: MODULE_A's unreachable record → site_dead
    const dead = byCause.get('site_dead');
    expect(dead?.count).toBe(1);
    expect(dead?.sites[0]?.siteName).toBe('AlphaSource');
    expect(dead?.sites[0]?.availability.status).toBe('unreachable');
    expect(dead?.sites[0]?.jobs[0]?.failureKind).toBe('net');
    // 429 vocabulary → throttled, availability untouched (unknown)
    const throttled = byCause.get('throttled');
    expect(throttled?.count).toBe(1);
    expect(throttled?.sites[0]?.siteName).toBe('BetaSource');
    expect(throttled?.sites[0]?.availability.status).toBe('unknown');
  });

  it('no availability service bound: unknown everywhere, site_dead stays empty, nothing refuses', async (): Promise<void> => {
    const jobs = new InMemoryJobService();
    const app = appWith(jobs, undefined);
    await createFailed(app, jobs, MODULE_A_ID, { failureKind: 'net', error: 'connection reset' });
    const snap = await snapshot(app);
    expect(snap.groups.find((group): boolean => group.cause === 'site_dead')?.count).toBe(0);
    expect(snap.groups.find((group): boolean => group.cause === 'other')?.sites[0]?.availability.status).toBe('unknown');
  });

  it('failed rows carry the typed failureKind on the /api/jobs wire (additive §4/§7.3 seam)', async (): Promise<void> => {
    const jobs = new InMemoryJobService();
    const app = appWith(jobs, new FakeAvailability());
    await createFailed(app, jobs, MODULE_A_ID, { failureKind: 'pack', error: 'zip write failed' });
    const res = await app.inject({ method: 'GET', url: '/api/jobs?state=failed' });
    expect(res.statusCode).toBe(200);
    const wire = (res.json() as { jobs: ReadonlyArray<{ state: string; failureKind?: string }> }).jobs;
    expect(wire).toHaveLength(1);
    expect(wire[0]?.state).toBe('failed');
    expect(wire[0]?.failureKind).toBe('pack');
  });
});

describe('POST /api/triage/retry — the paced retry-all route', (): void => {
  it('retries exactly the named group through the per-job retry action; affected + queued rows', async (): Promise<void> => {
    const jobs = new InMemoryJobService();
    const app = appWith(jobs, new FakeAvailability());
    await createFailed(app, jobs, MODULE_A_ID, { failureKind: 'net', error: 'HTTP 429' });
    await createFailed(app, jobs, MODULE_B_ID, { failureKind: 'net', error: 'connection reset' });

    const res = await app.inject({ method: 'POST', url: '/api/triage/retry', payload: { cause: 'throttled' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cause: string; affected: number; jobs: ReadonlyArray<{ state: string }> };
    expect(body.cause).toBe('throttled');
    expect(body.affected).toBe(1);
    expect(body.jobs.map((job): string => job.state)).toEqual(['queued']);
    // the OTHER group is untouched
    const snap = await snapshot(app);
    expect(snap.groups.find((group): boolean => group.cause === 'other')?.count).toBe(1);
  });

  it('AVAILABILITY NEVER GATES: the site_dead group retries with an unreachable record bound (D1 §3)', async (): Promise<void> => {
    const jobs = new InMemoryJobService();
    const availability = new FakeAvailability();
    availability.records.set(MODULE_A_ID, {
      status: 'unreachable',
      checkedAt: '2026-01-02T00:00:00.000Z',
      reason: 'connect ECONNREFUSED',
    });
    const app = appWith(jobs, availability);
    await createFailed(app, jobs, MODULE_A_ID, { failureKind: 'net', error: 'connect ECONNREFUSED' });

    const res = await app.inject({ method: 'POST', url: '/api/triage/retry', payload: { cause: 'site_dead' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { affected: number }).affected).toBe(1);
  });

  it('an unknown cause is a typed 400 (validation_error), not a silent anything', async (): Promise<void> => {
    const app = appWith(new InMemoryJobService(), new FakeAvailability());
    const res = await app.inject({ method: 'POST', url: '/api/triage/retry', payload: { cause: 'exploded' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('an empty group is a clean no-op (affected 0)', async (): Promise<void> => {
    const app = appWith(new InMemoryJobService(), new FakeAvailability());
    const res = await app.inject({ method: 'POST', url: '/api/triage/retry', payload: { cause: 'antibot' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { affected: number }).affected).toBe(0);
  });
});
