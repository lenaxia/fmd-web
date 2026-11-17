/**
 * Metrics integration test (§4/§15 acceptance): a scripted workload —
 * jobs through the REAL SQLite queue behind the instrumented wrapper,
 * /api/info requests with ok + error outcomes, a sync trigger — must
 * emit the expected queue-depth / throughput / latency / error / sync /
 * memory series on the metrics endpoint.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteJobQueue } from '../../src/jobs/queue/queue.js';
import { InstrumentedJobQueue } from '../../src/observability/instrumented-queue.js';
import { InstrumentedSyncService } from '../../src/observability/instrumented-sync.js';
import { FmdMetrics } from '../../src/observability/metrics.js';
import { buildApp } from '../../src/api/app.js';
import {
  FakeSyncService,
  InMemoryFavoriteService,
  InMemoryLibraryService,
  InMemoryModuleService,
  type CatalogSyncOutcome,
  type JobCreateInput,
  type JobRecord,
  type JobService,
  type JobsPage,
} from '../../src/api/services.js';
import type { JobActionTypeT } from '@fmd/contract';
import {
  CATALOG_ID,
  FakeInfoService,
  InMemoryCatalogStore,
  MODULE_A_ID,
  TEST_VERSION,
  catalogFixtures,
  defaultRegistrations,
} from '../api/helpers.js';

const TMP = mkdtempSync(join(tmpdir(), 'fmd-metrics-'));

/**
 * Minimal §10 JobService port over the instrumented queue — enough for
 * the scripted workload without dragging the download-engine module
 * graph (RuntimeJobService) into an observability test.
 */
class QueueJobService implements JobService {
  constructor(private readonly queue: InstrumentedJobQueue) {}

  createDownload(input: JobCreateInput): { job: JobRecord; replayed: boolean } {
    const payload = {
      type: 'download',
      moduleId: input.moduleId,
      mangaUrl: input.mangaUrl,
      ...(input.mangaTitle !== undefined ? { mangaTitle: input.mangaTitle } : {}),
      chapterLink: input.chapterLink,
      ...(input.chapterName !== undefined ? { chapterName: input.chapterName } : {}),
    } as const;
    const { job, replayed } = this.queue.enqueue(payload);
    return { job: this.toRecord(job.id), replayed };
  }

  get(id: string): JobRecord | undefined {
    return this.queue.get(id) === undefined ? undefined : this.toRecord(id);
  }

  list(opts: { state?: JobRecord['state']; cursor?: string; limit: number }): JobsPage {
    const rows = this.queue.list({ ...(opts.state !== undefined ? { state: opts.state } : {}), limit: opts.limit });
    const jobs = rows.map((row) => this.toRecord(row.id));
    if (jobs.length < opts.limit) {
      return { jobs };
    }
    const last = jobs[jobs.length - 1]?.id;
    if (last === undefined) {
      return { jobs };
    }
    return { jobs, nextCursor: last };
  }

  cancel(id: string): JobRecord {
    this.queue.cancel(id);
    return this.toRecord(id);
  }

  resume(id: string): JobRecord {
    this.queue.resume(id);
    return this.toRecord(id);
  }

  /** Downloads parity: the matrix subset this workload exercises
   * (hold/lift/cancel); the re-enqueue actions are download-lane
   * concerns the observability double never hits. */
  action(id: string, type: JobActionTypeT): JobRecord {
    const current = this.queue.get(id);
    if (type === 'pause' || type === 'disable') {
      if (current !== undefined && (current.state === 'running' || current.state === 'retry') && type === 'pause') {
        this.queue.cancel(id);
      } else if (current !== undefined && current.state === 'queued' && !current.paused) {
        this.queue.hold(id);
      }
      return this.toRecord(id);
    }
    if (type === 'resume' || type === 'enable') {
      this.queue.resume(id);
      return this.toRecord(id);
    }
    throw new Error(`unsupported action in the metrics double: ${type}`);
  }

  remove(id: string): { job: JobRecord; dataDeleted: boolean } {
    const job = this.toRecord(id);
    this.queue.remove(id);
    return { job, dataDeleted: false };
  }

  bulkAction(): never {
    throw new Error('bulk actions are not part of the metrics workload');
  }

  private toRecord(id: string): JobRecord {
    const job = this.queue.get(id) as NonNullable<ReturnType<InstrumentedJobQueue['get']>>;
    const payload = { ...job.payload } as Record<string, unknown>;
    return {
      id: job.id,
      type: 'download',
      moduleId: String(payload['moduleId'] ?? ''),
      payload,
      state: job.state,
      priority: job.priority,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
    };
  }
}

/** Parse one metric line value from a Prometheus exposition. */
function valueOf(exposition: string, line: string): number {
  const match = exposition.split('\n').find((entry) => entry.startsWith(`${line} `));
  if (match === undefined) {
    throw new Error(`series not found: ${line}\n${exposition.slice(0, 600)}`);
  }
  return Number(match.slice(line.length + 1));
}

function hasLine(exposition: string, line: string): boolean {
  return exposition.split('\n').includes(line);
}

afterAll((): void => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/metrics (§4/§15 scripted workload)', (): void => {
  it('emits queue/latency/error/sync/memory series for the scripted workload', async (): Promise<void> => {
    const sqliteQueue = new SqliteJobQueue({ file: join(TMP, 'app.db') });
    const metrics = new FmdMetrics();
    // The run-level expression-dedup counters (bound as the assembly binds
    // the logger's): 1 distinct WARN + 99 suppressed repeats expected.
    let warned = 0;
    let suppressed = 0;
    metrics.bindExpressionDedup(() => ({ warned, suppressed }));
    metrics.bindProcessMemory();
    const queue = new InstrumentedJobQueue(sqliteQueue, metrics);
    try {
      const info = new FakeInfoService([MODULE_A_ID]);
      const app = buildApp(
        {
          modules: new InMemoryModuleService(defaultRegistrations()),
          catalogs: new InMemoryCatalogStore(catalogFixtures(), [CATALOG_ID]),
          info,
          // §10 JobService over the instrumented SQLite queue.
          jobs: new QueueJobService(queue),
          library: new InMemoryLibraryService(),
          favorites: new InMemoryFavoriteService(),
          sync: new InstrumentedSyncService(new FakeSyncService(undefined, [CATALOG_ID], {
            [CATALOG_ID]: { id: CATALOG_ID, state: 'unchanged' } satisfies CatalogSyncOutcome,
          }), metrics),
          readiness: (): { ready: boolean } => ({ ready: true }),
        },
        { version: TEST_VERSION, metrics },
      );

      // ── scripted workload ────────────────────────────────────────────
      // 1. two download jobs via the idempotent API…
      const created1 = await app.inject({ method: 'POST', url: '/api/jobs/download', payload: {
        moduleId: MODULE_A_ID, mangaUrl: 'https://example.test/manga', chapterLink: 'https://example.test/c1',
      } });
      expect(created1.statusCode).toBe(201);
      await app.inject({ method: 'POST', url: '/api/jobs/download', payload: {
        moduleId: MODULE_A_ID, mangaUrl: 'https://example.test/manga', chapterLink: 'https://example.test/c2',
      } });

      // 2. one info-lane job straight on the queue (left queued → depth).
      queue.enqueue({ type: 'info', moduleId: MODULE_A_ID, url: 'https://example.test/manga' });

      // 3. download lane throughput: claim both (claim ⇒ running); first →
      // done, second → failed(net).
      const job1 = queue.claim('download');
      const job2 = queue.claim('download');
      expect(job1).toBeDefined();
      expect(job2).toBeDefined();
      expect(job1!.state).toBe('running');
      queue.transition(job1!.id, 'done');
      queue.transition(job2!.id, 'failed', { failureKind: 'net', error: 'upstream 500' });

      // 4. per-module requests: 2 ok (distinct URLs — a repeated
      // module+url would be a cache hit and never reach the engine) +
      // 1 engine-level error (unknown module).
      for (const url of ['https://example.test/manga-a', 'https://example.test/manga-b']) {
        const res = await app.inject({ method: 'POST', url: '/api/info', payload: {
          moduleId: MODULE_A_ID, url,
        } });
        expect(res.statusCode).toBe(200);
      }
      const failing = await app.inject({ method: 'POST', url: '/api/info', payload: {
        moduleId: 'd'.repeat(32), url: 'https://example.test/manga',
      } });
      expect(failing.statusCode).toBe(404);

      // 5. sync triggers (instrumented sync service → ok counters).
      const syncRes = await app.inject({ method: 'POST', url: '/api/sync/modules' });
      expect(syncRes.statusCode).toBe(200);
      const catalogRes = await app.inject({ method: 'POST', url: `/api/sync/catalog/${CATALOG_ID}` });
      expect(catalogRes.statusCode).toBe(200);

      // 6. corpus pass rates (§15 provider lands before the scrape).
      metrics.setCorpusPassRates([{ module: MODULE_A_ID, rate: 0.99 }]);

      // ── assert via the metrics endpoint ─────────────────────────────
      const res = await app.inject({ method: 'GET', url: '/api/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      const exposition = res.body;

      // Queue depth per lane (live gauge): 1 queued info job; download lane drained.
      expect(valueOf(exposition, 'fmd_queue_depth{lane="info"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_queue_depth{lane="download"}')).toBe(0);
      expect(valueOf(exposition, 'fmd_jobs_state{lane="info",state="queued"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_jobs_state{lane="download",state="done"}')).toBe(1);

      // Throughput + failure counters.
      expect(valueOf(exposition, 'fmd_jobs_enqueued_total{lane="download"}')).toBe(2);
      expect(valueOf(exposition, 'fmd_jobs_enqueued_total{lane="info"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_jobs_claimed_total{lane="download"}')).toBe(2);
      expect(valueOf(exposition, 'fmd_jobs_terminal_total{lane="download",state="done"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_jobs_terminal_total{lane="download",state="failed"}')).toBe(1);
      // Labels render in sorted order (kind < lane).
      expect(valueOf(exposition, 'fmd_job_failures_total{kind="net",lane="download"}')).toBe(1);

      // Per-module request latency + error counts (§15).
      expect(valueOf(exposition, `fmd_module_requests_total{module="${MODULE_A_ID}",outcome="ok"}`)).toBe(2);
      expect(valueOf(exposition, `fmd_module_requests_total{module="${'d'.repeat(32)}",outcome="error"}`)).toBe(1);
      expect(valueOf(exposition, `fmd_module_request_latency_seconds_count{module="${MODULE_A_ID}"}`)).toBe(2);
      // Immediate fake resolves inside the smallest latency bucket.
      expect(valueOf(exposition, `fmd_module_request_latency_seconds_bucket{module="${MODULE_A_ID}",le="0.005"}`)).toBe(2);
      expect(hasLine(exposition, `fmd_module_request_latency_seconds_bucket{module="${MODULE_A_ID}",le="+Inf"} 2`)).toBe(true);

      // Sync progress series (§6).
      expect(valueOf(exposition, 'fmd_sync_operations_total{kind="modules",outcome="ok"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_sync_operations_total{kind="catalog",outcome="ok"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_sync_in_progress{kind="modules"}')).toBe(0);
      expect(valueOf(exposition, 'fmd_sync_progress_ratio{kind="modules"}')).toBe(1);
      expect(valueOf(exposition, 'fmd_sync_last_success_timestamp_seconds{kind="modules"}')).toBeGreaterThan(0);

      // Engine pool RSS (§5.12) + GC family present.
      expect(valueOf(exposition, 'fmd_engine_pool_rss_bytes')).toBeGreaterThan(1024);
      expect(exposition).toContain('# TYPE fmd_gc_pause_count_total counter');

      // Dedup counters + corpus pass rates re-exported.
      suppressed = 99;
      warned = 1;
      const res2 = await app.inject({ method: 'GET', url: '/api/metrics' });
      expect(valueOf(res2.body, 'fmd_log_expression_warns_total')).toBe(1);
      expect(valueOf(res2.body, 'fmd_log_expression_suppressed_total')).toBe(99);
      expect(valueOf(res2.body, `fmd_corpus_pass_rate{module="${MODULE_A_ID}"}`)).toBe(0.99);

      await app.close();
    } finally {
      queue.close();
    }
  });
});
