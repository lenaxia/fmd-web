/**
 * Site-availability API contract (dead-site discovery): the /api/modules
 * availability join + the manual per-row Check endpoint. The probe is
 * a scripted fake (the REAL worker op is pinned in the engine-thread
 * suite; classification itself in the unit + runtime suites) — this
 * file pins the ROUTE contract: verdict mapping, record writes, the
 * live join on the next /api/modules read, typed errors, and the
 * not-mounted posture when no availability service is bound.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createDefaultServices, type ApiServices } from '../../src/main.js';
import { InMemoryModuleService } from '../../src/api/services.js';
import type { SiteAvailabilityRecord, SiteCheckResult } from '../../src/runtime/site-availability.js';
import { makeRegistration } from './helpers.js';

const MODULE_A = 'a'.repeat(32);
const MODULE_B = 'b'.repeat(32);

/** Scripted availability service: the probe answers per test, the
 * record store is a live Map (the join must read it back). */
class FakeAvailability {
  readonly records = new Map<string, SiteAvailabilityRecord>();
  readonly probes: string[] = [];
  readonly answer: (moduleId: string) => Promise<{ readonly resultCode: number; readonly resultString: string }>;

  public constructor(
    answer: (moduleId: string) => Promise<{ readonly resultCode: number; readonly resultString: string }> = (): Promise<{
      readonly resultCode: number;
      readonly resultString: string;
    }> => Promise.resolve({ resultCode: 200, resultString: 'OK' }),
  ) {
    this.answer = answer;
  }

  record(moduleId: string, outcome: { verdict: 'reachable' | 'unreachable'; reason?: string }): void {
    this.records.set(moduleId, {
      status: outcome.verdict,
      checkedAt: new Date().toISOString(),
      reason: outcome.reason ?? null,
    });
  }

  get(moduleId: string): SiteAvailabilityRecord {
    return this.records.get(moduleId) ?? { status: 'unknown', checkedAt: null, reason: null };
  }

  list(): ReadonlyMap<string, SiteAvailabilityRecord> {
    return this.records;
  }

  async check(moduleId: string): Promise<SiteCheckResult> {
    this.probes.push(moduleId);
    const raw = await this.answer(moduleId);
    const outcome =
      raw.resultCode >= 500
        ? { verdict: 'unreachable' as const, reason: raw.resultString }
        : raw.resultCode >= 200 && raw.resultCode < 400
          ? { verdict: 'reachable' as const }
          : undefined;
    if (outcome === undefined) {
      return {
        moduleId,
        verdict: 'none',
        detail: `No verdict — origin answered HTTP ${String(raw.resultCode)}; record unchanged`,
        availability: this.get(moduleId),
      };
    }
    this.record(moduleId, outcome);
    return {
      moduleId,
      verdict: outcome.verdict,
      detail: outcome.verdict === 'reachable' ? `Reachable (HTTP ${String(raw.resultCode)})` : `Unreachable — ${outcome.reason ?? ''}`,
      availability: this.get(moduleId),
    };
  }
}

function appWith(availability: FakeAvailability | undefined): ReturnType<typeof buildApp> {
  const modules = new InMemoryModuleService(
    [
      makeRegistration({ id: MODULE_A, name: 'AlphaSource' }),
      makeRegistration({ id: MODULE_B, name: 'BetaSource' }),
    ],
    false,
    (): boolean => false,
    // the LIVE availability join (mirrors the assembly wiring: the
    // module service reads the record store per list()/get() call).
    ...(availability !== undefined ? [(id: string): SiteAvailabilityRecord => availability.get(id)] : []),
  );
  const services: ApiServices = {
    ...createDefaultServices({ modules }),
    ...(availability !== undefined ? { availability } : {}),
  };
  return buildApp(services, { version: '0.1.0-test' });
}

describe('GET /api/modules — availability join', (): void => {
  it('every row carries availability: unknown for never-touched sites (seeded, silent)', async (): Promise<void> => {
    const app = appWith(new FakeAvailability());
    const response = await app.inject({ method: 'GET', url: '/api/modules' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { modules: Array<{ id: string; availability: SiteAvailabilityRecord }> };
    for (const row of body.modules) {
      expect(row.availability).toEqual({ status: 'unknown', checkedAt: null, reason: null });
    }
  });

  it('a written record is visible on the next read (live join, no cache)', async (): Promise<void> => {
    const availability = new FakeAvailability();
    const app = appWith(availability);
    availability.record(MODULE_A, { verdict: 'unreachable', reason: 'connect ECONNREFUSED 127.0.0.1:9' });
    const response = await app.inject({ method: 'GET', url: '/api/modules' });
    const row = ((response.json() as { modules: Array<{ id: string; availability: SiteAvailabilityRecord }> }).modules).find(
      (m): boolean => m.id === MODULE_A,
    );
    expect(row?.availability).toMatchObject({ status: 'unreachable', reason: 'connect ECONNREFUSED 127.0.0.1:9' });
    expect(typeof row?.availability.checkedAt).toBe('string');
  });

  it('the join survives without a bound availability service (unknown default)', async (): Promise<void> => {
    const app = appWith(undefined);
    const response = await app.inject({ method: 'GET', url: '/api/modules' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { modules: Array<{ availability: SiteAvailabilityRecord }> };
    expect(body.modules.every((m): boolean => m.availability.status === 'unknown')).toBe(true);
  });
});

describe('POST /api/modules/:id/check — the manual per-row probe', (): void => {
  it('a reachable probe: verdict reachable, the record joins on the next modules read', async (): Promise<void> => {
    const availability = new FakeAvailability();
    const app = appWith(availability);
    const response = await app.inject({ method: 'POST', url: `/api/modules/${MODULE_A}/check` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SiteCheckResult;
    expect(body.verdict).toBe('reachable');
    expect(body.detail).toBe('Reachable (HTTP 200)');
    expect(body.availability.status).toBe('reachable');
    expect(availability.probes).toEqual([MODULE_A]);
    const modules = await app.inject({ method: 'GET', url: '/api/modules' });
    const row = ((modules.json() as { modules: Array<{ id: string; availability: SiteAvailabilityRecord }> }).modules).find(
      (m): boolean => m.id === MODULE_A,
    );
    expect(row?.availability.status).toBe('reachable');
  });

  it('a transport failure: verdict unreachable + reason on the record', async (): Promise<void> => {
    const availability = new FakeAvailability(
      (): Promise<{ readonly resultCode: number; readonly resultString: string }> =>
        Promise.resolve({ resultCode: 500, resultString: 'timeout after 15000ms' }),
    );
    const app = appWith(availability);
    const response = await app.inject({ method: 'POST', url: `/api/modules/${MODULE_A}/check` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SiteCheckResult;
    expect(body.verdict).toBe('unreachable');
    expect(body.availability).toMatchObject({ status: 'unreachable', reason: 'timeout after 15000ms' });
  });

  it('a 4xx answer: verdict none — 200 OK with the record intentionally unchanged', async (): Promise<void> => {
    const availability = new FakeAvailability(
      (): Promise<{ readonly resultCode: number; readonly resultString: string }> =>
        Promise.resolve({ resultCode: 403, resultString: 'Forbidden' }),
    );
    const app = appWith(availability);
    const response = await app.inject({ method: 'POST', url: `/api/modules/${MODULE_A}/check` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SiteCheckResult;
    expect(body.verdict).toBe('none');
    expect(body.availability.status).toBe('unknown');
  });

  it('a malformed module id is the typed 400 envelope', async (): Promise<void> => {
    const app = appWith(new FakeAvailability());
    const response = await app.inject({ method: 'POST', url: '/api/modules/not-an-id/check' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('a probe that throws surfaces the typed error envelope, never a 500 stack', async (): Promise<void> => {
    const availability = new FakeAvailability(
      (): Promise<{ readonly resultCode: number; readonly resultString: string }> =>
        Promise.reject(new Error('engine thread died: exit code 1')),
    );
    const app = appWith(availability);
    const response = await app.inject({ method: 'POST', url: `/api/modules/${MODULE_A}/check` });
    expect([500, 502]).toContain(response.statusCode);
    expect(response.json()).toMatchObject({ error: { code: 'internal_error' } });
  });

  it('the route is NOT mounted when no availability service is bound (covers posture)', async (): Promise<void> => {
    const app = appWith(undefined);
    const response = await app.inject({ method: 'POST', url: `/api/modules/${MODULE_A}/check` });
    expect(response.statusCode).toBe(404);
  });
});
