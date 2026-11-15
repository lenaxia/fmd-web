import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chapterProgress,
  downloadPayload,
  mkTmpDir,
  openHarness,
  rmDir,
  type QueueHarness,
} from './helpers.js';

/**
 * Crash-recovery drill (§7.1 "resumable across restarts"): a job dies
 * mid-download (process kill — no close(), no terminal transition).
 * On restart the queue re-pools the orphaned `running` row as `retry`
 * and the NEXT claimant resumes FROM ITS PERSISTED PROGRESS.
 */
describe('crash recovery — kill mid-job → restart → resume from persisted progress', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir('queue-crash');
  });

  afterEach(() => {
    rmDir(dir);
  });

  function crash(harness: QueueHarness): void {
    // Process-kill semantics: NO close(), NO flush, NO transitions —
    // the instance is simply abandoned (its coalescer loop dies with
    // the fake process; the db file keeps whatever was durably flushed).
    void harness;
  }

  it('a download killed mid-chapter resumes at its last flushed chapter index', async () => {
    // ── life 1: claim, work, persist progress … crash ──
    const first = openHarness(dir);
    const { job } = first.queue.enqueue(downloadPayload('/ch/6'));
    first.queue.claim('download', { workerId: 'victim-0' });
    first.queue.updateProgress(job.id, chapterProgress(5, 30));
    await first.clock.advance(1_000); // the ≤1 s flush lands → progress durable
    expect(first.queue.get(job.id)?.progress).toEqual(chapterProgress(5, 30));
    crash(first); // 💥

    // ── life 2: restart with boot-time recovery ──
    const second = openHarness(dir, { recoverOnOpen: true });
    const resumed = second.queue.get(job.id);
    expect(resumed?.state).toBe('retry'); // orphaned running → retry
    expect(resumed?.progress).toEqual(chapterProgress(5, 30)); // progress survived
    expect(resumed?.attempts).toBe(1);

    // The next claimant picks the retry row up and RESUMES from index 5.
    const claimed = second.queue.claim('download', { workerId: 'phoenix-0' });
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(2);
    expect(claimed?.progress).toEqual(chapterProgress(5, 30));

    for (let i = 6; i <= 30; i += 1) {
      second.queue.updateProgress(job.id, chapterProgress(i, 30));
    }
    await second.clock.advance(1_000);
    const finished = second.queue.transition(job.id, 'done');
    expect(finished.state).toBe('done');
    expect(finished.progress).toEqual(chapterProgress(30, 30));

    second.queue.close();
  });

  it('a job killed before any progress resumes from scratch', async () => {
    const first = openHarness(dir);
    const { job } = first.queue.enqueue(downloadPayload('/ch/0'));
    first.queue.claim('download', { workerId: 'victim-0' }); // killed pre-update
    crash(first);

    const second = openHarness(dir, { recoverOnOpen: true });
    const resumed = second.queue.get(job.id);
    expect(resumed?.state).toBe('retry');
    expect(resumed?.progress).toBeUndefined();

    const claimed = second.queue.claim('download');
    expect(claimed?.progress).toBeUndefined();
    second.queue.transition(job.id, 'done');
    expect(second.queue.counts('download').done).toBe(1);
    second.queue.close();
  });

  it('queued and retry rows survive restart untouched (recovery only re-pools running)', () => {
    const first = openHarness(dir);
    // Job B claimed FIRST (id order): the running orphan before the crash.
    const jobB = first.queue.enqueue(downloadPayload('/orphan')).job;
    first.queue.claim('download');
    expect(first.queue.get(jobB.id)?.state).toBe('running');
    // Job A: already in `retry` (a prior crash's outcome) — recovery must not touch it.
    const jobA = (() => {
      const { job } = first.queue.enqueue(downloadPayload('/already-retry'));
      first.queue.claim('download'); // claims the retry row too (claim matches queued|retry)
      first.queue.transition(job.id, 'retry');
      return job;
    })();
    expect(first.queue.get(jobA.id)?.state).toBe('retry');
    crash(first);

    const second = openHarness(dir, { recoverOnOpen: true });
    expect(second.queue.get(jobA.id)?.state).toBe('retry'); // unchanged
    expect(second.queue.get(jobB.id)?.state).toBe('retry'); // orphan re-pooled
    expect(second.queue.counts('download')).toMatchObject({ retry: 2, queued: 0 });
    second.queue.close();
  });

  it('recovery is idempotent and explicit (recoverOrphans callable without recoverOnOpen)', () => {
    const first = openHarness(dir);
    const { job } = first.queue.enqueue(downloadPayload('/orphan'));
    first.queue.claim('download');
    crash(first);

    const second = openHarness(dir); // no recoverOnOpen
    expect(second.queue.get(job.id)?.state).toBe('running'); // untouched until recovery runs
    expect(second.queue.recoverOrphans()).toBe(1);
    expect(second.queue.get(job.id)?.state).toBe('retry');
    expect(second.queue.recoverOrphans()).toBe(0);
    second.queue.close();
  });

  it('a resumed job cycles retry→running→retry→running→done across repeated crashes', async () => {
    const first = openHarness(dir);
    const { job } = first.queue.enqueue(downloadPayload('/flaky-net'));
    first.queue.claim('download');
    first.queue.updateProgress(job.id, chapterProgress(1, 3));
    await first.clock.advance(1_000);
    crash(first);

    const totalAttempts: number[] = [];
    let lastProgress = chapterProgress(1, 3);
    for (let life = 2; life <= 4; life += 1) {
      const next = openHarness(dir, { recoverOnOpen: true });
      const claimed = next.queue.claim('download');
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.progress).toEqual(lastProgress); // resumes where it left off
      totalAttempts.push(claimed?.attempts ?? 0);
      if (life < 4) {
        // This life advances one chapter before the next 💥.
        lastProgress = chapterProgress(life, 3);
        next.queue.updateProgress(job.id, lastProgress);
        await next.clock.advance(1_000); // flush before the next 💥
        crash(next);
      } else {
        next.queue.transition(job.id, 'done');
        next.queue.close();
      }
    }
    expect(totalAttempts).toEqual([2, 3, 4]); // claim history accumulates
    const finalHarness = openHarness(dir, { recoverOnOpen: true });
    try {
      expect(finalHarness.queue.get(job.id)?.state).toBe('done');
      expect(finalHarness.queue.recoverOrphans()).toBe(0);
    } finally {
      finalHarness.queue.close();
    }
  });
});
