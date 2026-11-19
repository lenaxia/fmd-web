// @vitest-environment node
/**
 * [triage] classification + service unit acceptance (D1 §2 TRIAGE,
 * tsk-granite-crown-orders): failures GROUP BY CAUSE over state that
 * already exists — the §7.1 failed rows (typed failure kind + error
 * text) joined with the [site-availability] record. NO new state
 * machine: the service only reads (snapshot) and funnels rows through
 * the SAME per-job retry action the downloads tab uses.
 *
 * Pins:
 * - classifyFailedJob precedence: availability record (site_dead) →
 *   typed non-site kinds (other) → narrow 429 / anti-bot vocabulary →
 *   other;
 * - the snapshot: all four groups ALWAYS present in the fixed order,
 *   counts, per-site buckets with the availability + registry-name
 *   joins, cursor-paginated walks, and the live-successor exclusion
 *   (a failed row whose `<key>#<n>` chain is back in the pipe drops
 *   out — it does not await attention);
 * - retryGroup: exactly the group's rows retried, the SAME action
 *   seam, availability NEVER gates a retry (the site_dead group
 *   retries like any other — D1 §3), and a row that raced away (409)
 *   is skipped, not fatal.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@fmd/contract';
import type { JobFailureKind } from '@fmd/contract';
import { classifyFailedJob, TriageService } from '../../src/runtime/triage.js';
import type { TriageAvailabilitySeam } from '../../src/runtime/triage.js';
import type { JobRecord, JobsListOptions, JobsPage } from '../../src/api/services.js';
import type { SiteAvailabilityRecord } from '../../src/runtime/site-availability.js';

// ── classifyFailedJob: precedence over the three signal sources ─────

describe('classifyFailedJob', (): void => {
  it('the availability record wins: unreachable → site_dead (even with 429 text)', (): void => {
    expect(
      classifyFailedJob({ failureKind: 'net', error: 'HTTP 429 too many requests', availability: 'unreachable' }),
    ).toBe('site_dead');
  });

  it('typed non-site kinds are other BEFORE any text is read (a pack error mentioning 403 is not anti-bot)', (): void => {
    expect(classifyFailedJob({ failureKind: 'pack', error: 'zip: chapter 403.zip corrupt', availability: 'unknown' })).toBe('other');
    expect(classifyFailedJob({ failureKind: 'engine_oom', error: 'heap exhausted', availability: 'unknown' })).toBe('other');
    expect(classifyFailedJob({ failureKind: 'worker_stalled', error: 'no heartbeat', availability: 'unknown' })).toBe('other');
    expect(classifyFailedJob({ failureKind: 'pack', error: 'HTTP 429', availability: 'reachable' })).toBe('other');
  });

  it('429 vocabulary → throttled (net kind or kindless in-memory rows)', (): void => {
    expect(classifyFailedJob({ failureKind: 'net', error: '2 image(s) failed — #0: HTTP 429', availability: 'unknown' })).toBe('throttled');
    expect(classifyFailedJob({ failureKind: undefined, error: 'too many requests', availability: 'unknown' })).toBe('throttled');
  });

  it('anti-bot / bypass vocabulary → antibot (4xx writes no availability verdict — text is the only signal)', (): void => {
    expect(classifyFailedJob({ failureKind: 'net', error: '#1: HTTP 403 (Forbidden)', availability: 'unknown' })).toBe('antibot');
    expect(classifyFailedJob({ failureKind: 'net', error: 'challenge page served (cloudflare)', availability: 'reachable' })).toBe('antibot');
    expect(classifyFailedJob({ failureKind: 'net', error: 'antibot fallthrough; bypass unavailable', availability: 'unknown' })).toBe('antibot');
  });

  it('everything else → other (transport noise, engine faults, empty text)', (): void => {
    expect(classifyFailedJob({ failureKind: 'net', error: 'connection reset', availability: 'unknown' })).toBe('other');
    expect(classifyFailedJob({ failureKind: undefined, error: undefined, availability: 'unknown' })).toBe('other');
    expect(classifyFailedJob({ failureKind: 'net', error: 'HTTP 500 internal', availability: 'reachable' })).toBe('other');
  });
});

// ── the service: fake job seam + availability records ───────────────

/** The narrow TriageService port (list + action) as a scripted fake. */
class FakeJobSeam {
  readonly rows = new Map<string, JobRecord>();
  readonly retried: string[] = [];
  /** ids whose retry must simulate a lost race (409 — row moved). */
  raceAwayIds: ReadonlySet<string> = new Set();
  /** page size for the cursor-walk pin (default: everything at once). */
  pageSize = Number.MAX_SAFE_INTEGER;

  private seed = 100;

  addFailed(overrides: Partial<JobRecord> & { id: string; moduleId: string }): JobRecord {
    const row: JobRecord = {
      id: overrides.id,
      type: 'download',
      moduleId: overrides.moduleId,
      payload: {
        moduleId: overrides.moduleId,
        mangaUrl: 'https://ex.org/manga/x',
        mangaTitle: 'Fixture Manga',
        chapterLink: 'https://ex.org/manga/x/1',
        chapterName: 'Ch. 1',
        ...(overrides.payload ?? {}),
      },
      state: 'failed',
      priority: 0,
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
      ...(overrides.idempotencyKey !== undefined ? { idempotencyKey: overrides.idempotencyKey } : {}),
      ...(overrides.failureKind !== undefined ? { failureKind: overrides.failureKind } : {}),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
    };
    this.rows.set(row.id, row);
    return row;
  }

  addLive(id: string, moduleId: string, idempotencyKey: string): JobRecord {
    const row: JobRecord = {
      id,
      type: 'download',
      moduleId,
      payload: { moduleId, mangaUrl: 'https://ex.org/manga/x', chapterLink: 'https://ex.org/manga/x/1' },
      state: 'queued',
      priority: 0,
      idempotencyKey,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    this.rows.set(id, row);
    return row;
  }

  list = (opts: JobsListOptions): JobsPage => {
    const stateFilter = opts.state ?? opts.states?.[0];
    const matched = [...this.rows.values()]
      .filter((row): boolean =>
        stateFilter === undefined
          ? true
          : opts.states !== undefined
            ? opts.states.includes(row.state)
            : row.state === stateFilter,
      )
      .sort((a, b): number => (Number(b.id) > Number(a.id) ? 1 : -1));
    const start = opts.cursor !== undefined ? matched.findIndex((row): boolean => row.id === opts.cursor) + 1 : 0;
    // the page-size cap is what forces the service's cursor walk
    const limit = Math.min(opts.limit, this.pageSize);
    const page = matched.slice(start, start + limit);
    // keyset semantics (the real service's): cursor = the LAST row of
    // this page; the walk resumes strictly after it.
    const last = page.at(-1);
    return { jobs: page, ...(last !== undefined ? { nextCursor: last.id } : {}) };
  };

  action = (id: string, type: 'retry'): JobRecord => {
    if (type !== 'retry') {
      throw new Error('fake seam: only retry is scripted');
    }
    const row = this.rows.get(id);
    if (row === undefined || row.state !== 'failed') {
      throw new ApiError(409, 'conflict', `cannot retry job ${id} in state ${row?.state ?? 'gone'}`);
    }
    if (this.raceAwayIds.has(id)) {
      throw new ApiError(409, 'conflict', `job ${id} raced away`);
    }
    this.retried.push(id);
    this.seed += 1;
    const fresh: JobRecord = {
      ...row,
      id: String(this.seed),
      state: 'queued',
      ...(row.idempotencyKey !== undefined ? { idempotencyKey: `${row.idempotencyKey}#1` } : {}),
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    this.rows.set(fresh.id, fresh);
    return fresh;
  };
}

function availabilityOf(records: Record<string, SiteAvailabilityRecord>): TriageAvailabilitySeam {
  return {
    list: (): ReadonlyMap<string, SiteAvailabilityRecord> => new Map(Object.entries(records)),
  };
}

const UNREACHABLE: SiteAvailabilityRecord = {
  status: 'unreachable',
  checkedAt: '2026-01-02T00:00:00.000Z',
  reason: 'connect ECONNREFUSED',
};

function makeService(
  jobs: FakeJobSeam,
  availability?: TriageAvailabilitySeam,
  moduleName?: (moduleId: string) => string | undefined,
): TriageService {
  return new TriageService({
    jobs,
    ...(availability !== undefined ? { availability } : {}),
    ...(moduleName !== undefined ? { moduleName } : {}),
    now: (): Date => new Date('2026-01-04T00:00:00.000Z'),
  });
}

describe('TriageService.snapshot', (): void => {
  it('ALL FOUR groups always present, fixed order, with counts + failedTotal', (): void => {
    const jobs = new FakeJobSeam();
    const snap = makeService(jobs, availabilityOf({})).snapshot();
    expect(snap.groups.map((group): string => group.cause)).toEqual(['site_dead', 'antibot', 'throttled', 'other']);
    expect(snap.groups.every((group): boolean => group.count === 0 && group.sites.length === 0)).toBe(true);
    expect(snap.failedTotal).toBe(0);
    expect(snap.generatedAt).toBe('2026-01-04T00:00:00.000Z');
  });

  it('groups by cause with per-site buckets, availability + registry-name joins', (): void => {
    const jobs = new FakeJobSeam();
    jobs.addFailed({ id: '1', moduleId: 'dead-site', failureKind: 'net' as JobFailureKind, error: 'connection reset', idempotencyKey: 'k-dead' });
    jobs.addFailed({ id: '2', moduleId: 'blocked-site', failureKind: 'net' as JobFailureKind, error: '#0: HTTP 403 (Forbidden)', idempotencyKey: 'k-bot' });
    jobs.addFailed({ id: '3', moduleId: 'throttled', failureKind: 'net' as JobFailureKind, error: 'HTTP 429 too many requests', idempotencyKey: 'k-429' });
    jobs.addFailed({ id: '4', moduleId: 'throttled', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: 'k-429b' });
    jobs.addFailed({ id: '5', moduleId: 'engine', failureKind: 'engine_oom' as JobFailureKind, error: 'heap exhausted', idempotencyKey: 'k-oom' });

    const snap = makeService(
      jobs,
      availabilityOf({ 'dead-site': UNREACHABLE, throttled: { status: 'unknown', checkedAt: null, reason: null } }),
      (id): string | undefined => (id === 'dead-site' ? 'DeadSite' : id === 'throttled' ? 'Throttled' : undefined),
    ).snapshot();

    const byCause = new Map(snap.groups.map((group): [string, typeof group] => [group.cause, group]));
    expect(byCause.get('site_dead')?.count).toBe(1);
    expect(byCause.get('site_dead')?.sites[0]?.siteName).toBe('DeadSite');
    expect(byCause.get('site_dead')?.sites[0]?.availability.status).toBe('unreachable');
    expect(byCause.get('antibot')?.count).toBe(1);
    // same-site rows bucket together with the availability join
    expect(byCause.get('throttled')?.count).toBe(2);
    expect(byCause.get('throttled')?.sites).toHaveLength(1);
    expect(byCause.get('throttled')?.sites[0]?.jobs.map((job): string => job.id)).toEqual(['4', '3']);
    expect(byCause.get('other')?.count).toBe(1);
    expect(snap.failedTotal).toBe(5);
    // the attention row projection carries payload provenance + failure text
    expect(byCause.get('antibot')?.sites[0]?.jobs[0]?.mangaTitle).toBe('Fixture Manga');
    expect(byCause.get('antibot')?.sites[0]?.jobs[0]?.failureKind).toBe('net');
  });

  it('a failed row superseded by a LIVE retry-chain successor drops out (back in the pipe)', (): void => {
    const jobs = new FakeJobSeam();
    jobs.addFailed({ id: '1', moduleId: 'm', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: 'k1' });
    jobs.addFailed({ id: '2', moduleId: 'm', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: 'k2' });
    jobs.addLive('90', 'm', 'k1#1'); // k1 is being retried — not awaiting attention
    const snap = makeService(jobs).snapshot();
    expect(snap.failedTotal).toBe(1);
    expect(snap.groups.find((group): boolean => group.cause === 'throttled')?.count).toBe(1);
    const site = snap.groups.find((group): boolean => group.cause === 'throttled')?.sites[0];
    expect(site?.jobs.map((job): string => job.id)).toEqual(['2']);
  });

  it('cursor-paginated failed + live walks cover every row', (): void => {
    const jobs = new FakeJobSeam();
    jobs.pageSize = 2;
    for (let i = 1; i <= 5; i += 1) {
      jobs.addFailed({ id: String(i), moduleId: 'm', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: `k${String(i)}` });
    }
    const snap = makeService(jobs).snapshot();
    expect(snap.failedTotal).toBe(5);
    expect(snap.groups.find((group): boolean => group.cause === 'throttled')?.count).toBe(5);
  });

  it('no availability seam: every module reads unknown (site_dead stays empty, nothing throws)', (): void => {
    const jobs = new FakeJobSeam();
    jobs.addFailed({ id: '1', moduleId: 'm', failureKind: 'net' as JobFailureKind, error: 'connection reset', idempotencyKey: 'k1' });
    const snap = makeService(jobs).snapshot();
    expect(snap.groups.find((group): boolean => group.cause === 'site_dead')?.count).toBe(0);
    expect(snap.groups.find((group): boolean => group.cause === 'other')?.sites[0]?.availability).toEqual({
      status: 'unknown',
      checkedAt: null,
      reason: null,
    });
  });
});

describe('TriageService.retryGroup', (): void => {
  it('retries EXACTLY the group\'s rows through the SAME per-job retry seam', (): void => {
    const jobs = new FakeJobSeam();
    jobs.addFailed({ id: '1', moduleId: 'a', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: 'k1' });
    jobs.addFailed({ id: '2', moduleId: 'b', failureKind: 'net' as JobFailureKind, error: 'connection reset', idempotencyKey: 'k2' });
    const result = makeService(jobs).retryGroup('throttled');
    expect(result.cause).toBe('throttled');
    expect(result.affected).toBe(1);
    expect(jobs.retried).toEqual(['1']);
    expect(result.jobs.map((job): string => job.state)).toEqual(['queued']);
  });

  it('AVAILABILITY NEVER GATES: the site_dead group retries like any other (D1 §3)', (): void => {
    const jobs = new FakeJobSeam();
    jobs.addFailed({ id: '1', moduleId: 'dead-site', failureKind: 'net' as JobFailureKind, error: 'connect ECONNREFUSED', idempotencyKey: 'k1' });
    const service = makeService(jobs, availabilityOf({ 'dead-site': UNREACHABLE }));
    // grouped site_dead…
    expect(service.snapshot().groups.find((group): boolean => group.cause === 'site_dead')?.count).toBe(1);
    // …and still retried, no refusal anywhere.
    const result = service.retryGroup('site_dead');
    expect(result.affected).toBe(1);
    expect(jobs.retried).toEqual(['1']);
  });

  it('a row that raced away (409) is skipped, not fatal; the rest still retry', (): void => {
    const jobs = new FakeJobSeam();
    jobs.addFailed({ id: '1', moduleId: 'a', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: 'k1' });
    jobs.addFailed({ id: '2', moduleId: 'a', failureKind: 'net' as JobFailureKind, error: 'HTTP 429', idempotencyKey: 'k2' });
    jobs.raceAwayIds = new Set(['1']);
    const result = makeService(jobs).retryGroup('throttled');
    expect(result.affected).toBe(1);
    expect(jobs.retried).toEqual(['2']);
  });

  it('an empty group is a clean no-op (affected 0)', (): void => {
    const jobs = new FakeJobSeam();
    expect(makeService(jobs).retryGroup('antibot')).toMatchObject({ cause: 'antibot', affected: 0 });
    expect(jobs.retried).toEqual([]);
  });
});
