import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobState, LaneId } from '@fmd/contract';
import {
  IdempotencyConflictError,
  LaneRunner,
  RETENTION_MS,
  SqliteJobQueue,
  type QueueJob,
} from '../../src/jobs/queue/queue.js';
import { InvalidJobPayloadError } from '../../src/jobs/queue/payloads.js';
import {
  InvalidJobTransitionError,
  MissingJobFailureKindError,
} from '../../src/jobs/queue/state-machine.js';
import { downloadPayload, mkTmpDir, openHarness, rmDir, type QueueHarness } from './helpers.js';

describe('SqliteJobQueue — typed payloads & lanes (§4/§9)', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-basic');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('a download payload round-trips typed through the persisted row', () => {
    const payload = downloadPayload('/ch/1');
    const { job, replayed } = harness.queue.enqueue(payload);
    expect(replayed).toBe(false);
    expect(job.lane).toBe('download');
    expect(job.state).toBe('queued');
    expect(job.payload).toEqual(payload); // discriminated-union equality, not a string
    expect(harness.queue.get(job.id)?.payload).toEqual(payload);
  });

  it('each of the four §4 lane families routes by its discriminant', () => {
    const jobs: QueueJob[] = [
      harness.queue.enqueue({ type: 'download', moduleId: 'm'.repeat(32), mangaUrl: 'u', chapterLink: '/c' }).job,
      harness.queue.enqueue({ type: 'info', moduleId: 'm'.repeat(32), url: 'u' }).job,
      harness.queue.enqueue({ type: 'update' }).job,
      harness.queue.enqueue({ type: 'sync', target: 'catalog-all' }).job,
    ];
    expect(jobs.map((j) => j.lane)).toEqual(['download', 'info', 'update', 'sync']);
  });

  it('sync jobs targeting one catalog require catalogId', () => {
    expect(() => harness.queue.enqueue({ type: 'sync', target: 'catalog' })).toThrow(
      /requires catalogId/,
    );
    expect(() =>
      harness.queue.enqueue({ type: 'sync', target: 'catalog', catalogId: 'c'.repeat(32) }),
    ).not.toThrow();
  });

  it('a corrupted payload row fails LOUDLY at parse time (never stringly-typed)', async () => {
    const { job } = harness.queue.enqueue(downloadPayload('/ch/x'));
    // Foreign bytes in the persisted payload column (behind the queue's back).
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(harness.file);
    try {
      raw.prepare("UPDATE job SET payload = '{\"type\":\"bogus\"}' WHERE id = ?").run(Number(job.id));
    } finally {
      raw.close();
    }
    expect(() => harness.queue.get(job.id)).toThrow(InvalidJobPayloadError);
  });

  it('claims are FIFO within a priority, higher priority first', () => {
    const a = harness.queue.enqueue(downloadPayload('/a')).job;
    const b = harness.queue.enqueue(downloadPayload('/b')).job;
    const urgent = harness.queue.enqueue(downloadPayload('/urgent'), { priority: 5 }).job;

    expect(harness.queue.claim('download')?.id).toBe(urgent.id);
    expect(harness.queue.claim('download')?.id).toBe(a.id);
    expect(harness.queue.claim('download')?.id).toBe(b.id);
    expect(harness.queue.claim('download')).toBeUndefined();
  });

  it('claim bumps attempts, sets running + claimed_by, and lanes are isolated', () => {
    const download = harness.queue.enqueue(downloadPayload('/d')).job;
    const info = harness.queue.enqueue({ type: 'info', moduleId: 'm'.repeat(32), url: 'u' }).job;
    const update = harness.queue.enqueue({ type: 'update' }).job;
    const sync = harness.queue.enqueue({ type: 'sync', target: 'modules' }).job;

    const claimedDownload = harness.queue.claim('download', { workerId: 'dl-0' });
    expect(claimedDownload?.id).toBe(download.id);
    expect(claimedDownload?.state).toBe('running');
    expect(claimedDownload?.attempts).toBe(1);

    // Each lane surfaces ONLY its own jobs.
    expect(harness.queue.claim('info')?.id).toBe(info.id);
    expect(harness.queue.claim('update')?.id).toBe(update.id);
    expect(harness.queue.claim('sync')?.id).toBe(sync.id);

    // All lanes drained → undefined, and a download claimant can never
    // observe a foreign job (the stress drill re-proves this under
    // 16 threads).
    expect(harness.queue.claim('download')).toBeUndefined();
    expect(harness.queue.claim('info')).toBeUndefined();
    expect(harness.queue.claim('sync')).toBeUndefined();

    const counts: Record<JobState, number> = harness.queue.counts();
    expect(counts.running).toBe(4);
    expect(harness.queue.counts('info')).toEqual({
      queued: 0,
      running: 1,
      retry: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it('a claimed running job never re-claims (single-row claim guard)', () => {
    const { job } = harness.queue.enqueue(downloadPayload('/d'));
    expect(harness.queue.claim('download')?.id).toBe(job.id);
    expect(harness.queue.claim('download')).toBeUndefined();
  });
});

describe('SqliteJobQueue — §10 idempotency', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-idem');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('same key + same payload replays the ORIGINAL job', () => {
    const first = harness.queue.enqueue(downloadPayload('/same'), { idempotencyKey: 'k1' });
    const second = harness.queue.enqueue(downloadPayload('/same'), { idempotencyKey: 'k1' });
    expect(second.replayed).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(harness.queue.counts('download').queued).toBe(1);
  });

  it('same key + DIFFERENT payload is a conflict (throws)', () => {
    harness.queue.enqueue(downloadPayload('/one'), { idempotencyKey: 'k1' });
    expect(() =>
      harness.queue.enqueue(downloadPayload('/two'), { idempotencyKey: 'k1' }),
    ).toThrow(IdempotencyConflictError);
  });

  it('different keys with identical payloads are distinct jobs', () => {
    const a = harness.queue.enqueue(downloadPayload('/same'), { idempotencyKey: 'ka' });
    const b = harness.queue.enqueue(downloadPayload('/same'), { idempotencyKey: 'kb' });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(b.job.id).not.toBe(a.job.id);
  });
});

describe('SqliteJobQueue — state machine enforcement on live rows', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-state');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('queued → done throws (the §7.1 chain cannot be skipped)', () => {
    const { job } = harness.queue.enqueue(downloadPayload('/d'));
    expect(() => harness.queue.transition(job.id, 'done')).toThrow(InvalidJobTransitionError);
  });

  it('running → queued throws (no silent requeue)', () => {
    const { job } = harness.queue.enqueue(downloadPayload('/d'));
    harness.queue.claim('download');
    expect(() => harness.queue.transition(job.id, 'queued')).toThrow(InvalidJobTransitionError);
  });

  it('→ failed without a typed failureKind throws through the queue too', () => {
    const { job } = harness.queue.enqueue(downloadPayload('/d'));
    harness.queue.claim('download');
    expect(() => harness.queue.transition(job.id, 'failed')).toThrow(MissingJobFailureKindError);
    const failed = harness.queue.transition(job.id, 'failed', { failureKind: 'pack' });
    expect(failed.state).toBe('failed');
    expect(failed.failureKind).toBe('pack');
  });

  it('cancel beats claim: a cancelled job is unclaimable and its stale worker outcome throws', () => {
    const a = harness.queue.enqueue(downloadPayload('/cancel-queued')).job;
    // Cancel while queued → claim must not surface it.
    harness.queue.cancel(a.id);
    expect(harness.queue.claim('download')).toBeUndefined();
    expect(harness.queue.get(a.id)?.state).toBe('cancelled');
    // Cancel while running → the (stale) worker's done-write now throws.
    const b = harness.queue.enqueue(downloadPayload('/cancel-running')).job;
    harness.queue.claim('download');
    harness.queue.cancel(b.id);
    expect(() => harness.queue.transition(b.id, 'done')).toThrow(InvalidJobTransitionError);
    expect(harness.queue.get(b.id)?.state).toBe('cancelled');
  });

  it('retry cycles legally: running→retry→running→done', () => {
    const { job } = harness.queue.enqueue(downloadPayload('/r'));
    harness.queue.claim('download');
    harness.queue.transition(job.id, 'retry');
    const again = harness.queue.claim('download'); // retry rows are claimable
    expect(again?.id).toBe(job.id);
    expect(again?.attempts).toBe(2);
    expect(harness.queue.transition(job.id, 'done').state).toBe('done');
  });

  it('terminal rows are closed: done → anything throws', () => {
    const { job } = harness.queue.enqueue(downloadPayload('/d'));
    harness.queue.claim('download');
    harness.queue.transition(job.id, 'done');
    for (const to of ['queued', 'running', 'retry', 'done', 'failed', 'cancelled'] as const) {
      expect(() => harness.queue.transition(job.id, to)).toThrow(InvalidJobTransitionError);
    }
  });

  it('an unknown job id throws on transition', () => {
    expect(() => harness.queue.transition('9999', 'running')).toThrow(/not found/);
  });
});

describe('SqliteJobQueue — watchdog & recovery primitives (§4/§7.1)', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-recover');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('staleRunningJobs lists only quiet claims (watchdog input)', async () => {
    const quiet = harness.queue.enqueue(downloadPayload('/quiet')).job;
    void harness.queue.enqueue(downloadPayload('/fresh'));
    harness.queue.claim('download', { workerId: 'stuck' }); // claimed_at = t0
    await harness.clock.advance(120_000);
    void harness.queue.enqueue(downloadPayload('/second'));
    harness.queue.claim('download', { workerId: 'lively' }); // claimed_at = t+120s

    const stale = harness.queue.staleRunningJobs(60_000);
    expect(stale.map((j) => j.id)).toEqual([quiet.id]);
    expect(stale[0]?.attempts).toBe(1);
  });

  it('recoverOrphans re-pools running rows as retry and clears claim bookkeeping', async () => {
    const { job } = harness.queue.enqueue(downloadPayload('/orphan'));
    const queued = harness.queue.enqueue(downloadPayload('/queued')).job;
    harness.queue.claim('download', { workerId: 'dead-thread' });
    harness.queue.updateProgress(job.id, { chapterIndex: 5, chapterTotal: 30 });
    await harness.clock.advance(1_000); // flush progress

    const recovered: number = harness.queue.recoverOrphans();
    expect(recovered).toBe(1);
    const after = harness.queue.get(job.id);
    expect(after?.state).toBe('retry');
    expect(after?.progress).toEqual({ chapterIndex: 5, chapterTotal: 30 });
    expect(after?.attempts).toBe(1); // history preserved
    expect(harness.queue.get(queued.id)?.state).toBe('queued'); // untouched

    expect(harness.queue.recoverOrphans()).toBe(0); // idempotent
  });
});

describe('SqliteJobQueue — retention (§9)', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-retention');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('RETENTION_MS is exactly 30 days', () => {
    expect(RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('prune removes only terminal rows older than 30d (non-terminal survive regardless of age)', async () => {
    // t=0 batch: one per terminal state + an ancient QUEUED job.
    const doneJob = (() => {
      const { job } = harness.queue.enqueue(downloadPayload('/done'));
      harness.queue.claim('download');
      return harness.queue.transition(job.id, 'done');
    })();
    const failedJob = (() => {
      const { job } = harness.queue.enqueue({ type: 'info', moduleId: 'm'.repeat(32), url: 'u' });
      harness.queue.claim('info');
      return harness.queue.transition(job.id, 'failed', { failureKind: 'net' });
    })();
    const cancelledJob = (() => {
      const { job } = harness.queue.enqueue({ type: 'update' });
      return harness.queue.cancel(job.id);
    })();
    const ancientQueued = harness.queue.enqueue({ type: 'sync', target: 'modules' }).job;

    // 1 ms before the cutoff nothing is prunable.
    await harness.clock.advance(RETENTION_MS - 1);
    expect(harness.queue.pruneRetention()).toBe(0);

    // Cross the boundary: t = 30d + 1 ms → cutoff = 1 ms > updated_at(0).
    await harness.clock.advance(2);
    expect(harness.queue.pruneRetention()).toBe(3);
    expect(harness.queue.get(doneJob.id)).toBeUndefined();
    expect(harness.queue.get(failedJob.id)).toBeUndefined();
    expect(harness.queue.get(cancelledJob.id)).toBeUndefined();
    // The non-terminal job survives NO MATTER how old it is.
    expect(harness.queue.get(ancientQueued.id)?.state).toBe('queued');
    expect(harness.queue.counts()).toEqual({
      queued: 1,
      running: 0,
      retry: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    });
  });
});

describe('LaneRunner — four lanes, independent concurrency (§4)', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-runner');
    harness = openHarness(dir);
  });

  afterEach(async () => {
    await runner?.stop();
    harness.queue.close();
    rmDir(dir);
  });

  let runner: LaneRunner | undefined;

  interface PeakTracker {
    current: number;
    peak: number;
  }

  function tracker(): PeakTracker {
    return { current: 0, peak: 0 };
  }

  it('per-lane caps hold independently: a busy download lane never throttles info', async () => {
    const { queue, clock } = harness;
    const downloadPeak = tracker();
    const infoPeak = tracker();

    const handlerFor = (peak: PeakTracker, workMs: number) => {
      return async (): Promise<{ type: 'done' }> => {
        peak.current += 1;
        peak.peak = Math.max(peak.peak, peak.current);
        await clock.delay(workMs);
        peak.current -= 1;
        return { type: 'done' };
      };
    };

    for (let i = 0; i < 3; i += 1) {
      queue.enqueue(downloadPayload(`/d${String(i)}`));
    }
    queue.enqueue({ type: 'info', moduleId: 'm'.repeat(32), url: 'u' });

    runner = new LaneRunner(queue, {
      clock,
      maxAttempts: 3,
      lanes: {
        download: { concurrency: 2, handler: handlerFor(downloadPeak, 5_000) },
        info: { concurrency: 1, handler: handlerFor(infoPeak, 5_000) },
      },
    });
    runner.start();

    // t=0: slots claimed — download at its cap (2 of 3 claimed), info at 1.
    await clock.drain();
    expect(runner.activeCount('download')).toBe(2);
    expect(runner.activeCount('info')).toBe(1);
    expect(downloadPeak.current).toBe(2);
    expect(infoPeak.current).toBe(1);

    // Handlers finish → the third download job is claimed, info drains.
    await clock.advance(5_000);
    expect(runner.activeCount('download')).toBe(1);
    expect(runner.activeCount('info')).toBe(0);
    await clock.advance(5_000);

    await runner.stop();
    runner = undefined;

    expect(downloadPeak.peak).toBe(2); // cap respected, never 3
    expect(infoPeak.peak).toBe(1);
    expect(queue.counts('download')).toMatchObject({ done: 3 });
    expect(queue.counts('info')).toMatchObject({ done: 1 });
  });

  it('retry outcomes cycle until attempts exhaust, then fail with the typed kind', async () => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/flaky'));

    runner = new LaneRunner(queue, {
      clock,
      maxAttempts: 2,
      lanes: {
        download: {
          concurrency: 1,
          pollIntervalMs: 1,
          handler: async (): Promise<{ type: 'retry'; error: string }> => {
            await clock.delay(1);
            return { type: 'retry', error: 'transient fetch failure' };
          },
        },
      },
    });
    runner.start();
    await clock.advance(10_000); // two claims → exhausted
    await runner.stop();
    runner = undefined;

    const job: QueueJob | undefined = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('failed');
    expect(job?.failureKind).toBe('net'); // documented default for exhausted retries
    expect(job?.attempts).toBe(2);
    expect(job?.error).toContain('transient fetch failure');
  });

  it('an explicit failure outcome persists its typed kind', async () => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/oom'));
    runner = new LaneRunner(queue, {
      clock,
      lanes: {
        download: {
          concurrency: 1,
          handler: async (): Promise<{ type: 'failed'; kind: 'engine_oom'; error: string }> => {
            await clock.delay(1);
            return { type: 'failed', kind: 'engine_oom', error: '512 MB budget exceeded' };
          },
        },
      },
    });
    runner.start();
    await clock.advance(1_000);
    await runner.stop();
    runner = undefined;

    const job: QueueJob | undefined = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('failed');
    expect(job?.failureKind).toBe('engine_oom');
  });

  it('a handler that throws is classified worker_stalled (§4 watchdog semantics)', async () => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/explodes'));
    runner = new LaneRunner(queue, {
      clock,
      lanes: {
        download: {
          concurrency: 1,
          handler: async (): Promise<{ type: 'done' }> => {
            await clock.delay(1);
            throw new Error('worker wedged mid-event');
          },
        },
      },
    });
    runner.start();
    await clock.advance(1_000);
    await runner.stop();
    runner = undefined;

    const job: QueueJob | undefined = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('failed');
    expect(job?.failureKind).toBe('worker_stalled');
    expect(job?.error).toContain('worker wedged');
  });

  it('stop() finishes in-flight handlers before exiting (bounded drain)', async () => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/drain'));
    let handlerFinished = false;
    runner = new LaneRunner(queue, {
      clock,
      lanes: {
        download: {
          concurrency: 1,
          handler: async (): Promise<{ type: 'done' }> => {
            await clock.delay(4_000);
            handlerFinished = true;
            return { type: 'done' };
          },
        },
      },
    });
    runner.start();
    await clock.drain();
    expect(runner.activeCount('download')).toBe(1);

    const stopped: Promise<void> = runner.stop();
    // stop() must NOT resolve before the in-flight handler completed.
    let resolvedBeforeWork = false;
    void stopped.then((): void => {
      resolvedBeforeWork = true;
    });
    await clock.drain();
    expect(resolvedBeforeWork).toBe(false);
    await clock.advance(4_000);
    await stopped;
    expect(handlerFinished).toBe(true);
    expect(queue.counts('download').done).toBe(1);
    runner = undefined;
  });
});

describe('SqliteJobQueue — lifecycle', () => {
  it('operations after close() throw; close() is idempotent', () => {
    const dir: string = mkTmpDir('queue-close');
    try {
      const harness: QueueHarness = openHarness(dir);
      const { job } = harness.queue.enqueue(downloadPayload('/d'));
      harness.queue.close();
      harness.queue.close();
      expect(() => harness.queue.claim('download')).toThrow(/closed/);
      expect(() => harness.queue.get(job.id)).toThrow(/closed/);
    } finally {
      rmDir(dir);
    }
  });

  it('all four lanes coexist in one db with independent counters', () => {
    const dir: string = mkTmpDir('queue-lanes-coexist');
    try {
      const harness: QueueHarness = openHarness(dir);
      const lanes: LaneId[] = ['info', 'download', 'update', 'sync'];
      lanes.forEach((lane, i) => {
        if (lane === 'download') {
          harness.queue.enqueue(downloadPayload(`/lane-${String(i)}`));
        } else if (lane === 'info') {
          harness.queue.enqueue({ type: 'info', moduleId: 'm'.repeat(32), url: 'u' });
        } else if (lane === 'update') {
          harness.queue.enqueue({ type: 'update' });
        } else {
          harness.queue.enqueue({ type: 'sync', target: 'modules' });
        }
      });
      for (const lane of lanes) {
        expect(harness.queue.counts(lane).queued).toBe(1);
      }
      expect(harness.queue.list({ state: 'queued' })).toHaveLength(4);
      expect(new SqliteJobQueue({ file: harness.file, recoverOnOpen: true }).counts().queued).toBe(4);
    } finally {
      rmDir(dir);
    }
  });
});
