import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chapterProgress,
  downloadPayload,
  mkTmpDir,
  openHarness,
  rmDir,
  type QueueHarness,
} from './helpers.js';
import { PROGRESS_FLUSH_INTERVAL_MS } from '../../src/jobs/lanes.js';

/**
 * §4 write coalescing drill: 1000 progress updates for one job must
 * produce a WRITE COUNT bounded by the job's duration (≤ ~1 flush per
 * second of job lifetime), while consumers observe updates with ≤1 s
 * latency (in-memory instantly, persisted at the flush boundary).
 * All timing is virtual (FakeClock) — deterministic under repetition.
 */
describe('§4 progress coalescing', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-coalesce');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('the cadence constant is the §4 1 flush/sec/job budget', () => {
    expect(PROGRESS_FLUSH_INTERVAL_MS).toBe(1_000);
  });

  it('1000 updates over a 1 s job → exactly ONE durable write carrying the newest snapshot', async () => {
    const { queue, clock } = harness;
    const { job } = queue.enqueue(downloadPayload('/hot'));
    queue.claim('download');

    for (let i = 1; i <= 1000; i += 1) {
      queue.updateProgress(job.id, chapterProgress(i, 30));
      await clock.advance(1); // job duration: 1000 ms of virtual time
    }

    // One flush at the 1 s boundary — the write amount budget, §4.
    expect(queue.coalescerStats().flushes).toBe(1);
    expect(queue.coalescerStats().updates).toBe(1000);
    expect(queue.coalescerStats().coalescedAway).toBe(999);

    // The persisted write carries the LATEST snapshot (replace wins).
    expect(queue.get(job.id)?.progress).toEqual(chapterProgress(1000, 30));
    // And time moving on produces no further writes (idle = no writes).
    await clock.advance(5_000);
    expect(queue.coalescerStats().flushes).toBe(1);
  });

  it('updates burst at t=0 still bound to one flush; visibility latency ≤1 s is asserted', async () => {
    const { queue, clock } = harness;
    const { job } = queue.enqueue(downloadPayload('/burst'));
    queue.claim('download');

    for (let i = 1; i <= 1000; i += 1) {
      queue.updateProgress(job.id, chapterProgress(i, 42));
    }
    // In-memory visibility is INSTANT (latest snapshot, no flush needed).
    expect(queue.progressOf(job.id)).toEqual(chapterProgress(1000, 42));
    // The PERSISTED row lags — that is the coalescing (no write yet).
    expect(queue.get(job.id)?.progress).toBeUndefined();

    // t = 999 ms: still not persisted (latency budget not elapsed).
    await clock.advance(999);
    expect(queue.get(job.id)?.progress).toBeUndefined();
    // t = 1000 ms: persisted. Update visibility latency ≤ 1 s — asserted.
    await clock.advance(1);
    expect(queue.get(job.id)?.progress).toEqual(chapterProgress(1000, 42));
    expect(queue.coalescerStats().flushes).toBe(1);
  });

  it('per-job budgets are independent: two staggered jobs each flush once', async () => {
    const { queue, clock } = harness;
    const a = queue.enqueue(downloadPayload('/a')).job;
    const b = queue.enqueue(downloadPayload('/b')).job;
    queue.claim('download');

    queue.updateProgress(a.id, chapterProgress(1, 9));
    await clock.advance(999);
    queue.updateProgress(b.id, chapterProgress(1, 9)); // t=999, B due at 1999
    await clock.advance(1); // t=1000 → A flushes
    expect(queue.coalescerStats().flushes).toBe(1);
    expect(queue.get(a.id)?.progress).toEqual(chapterProgress(1, 9));
    expect(queue.get(b.id)?.progress).toBeUndefined();

    await clock.advance(999); // t=1999 → B flushes
    expect(queue.coalescerStats().flushes).toBe(2);
    expect(queue.get(b.id)?.progress).toEqual(chapterProgress(1, 9));
  });

  it('further updates after a flush restart the ≤1 s budget (steady stream = 1 write/sec)', async () => {
    const { queue, clock } = harness;
    const { job } = queue.enqueue(downloadPayload('/steady'));
    queue.claim('download');

    // 3 s steady stream: one update every 500 ms → one write per second.
    for (let i = 1; i <= 6; i += 1) {
      queue.updateProgress(job.id, chapterProgress(i, 6));
      await clock.advance(500);
    }
    // Flushes at t=1000, 2000, 3000 — each carrying the newest snapshot
    // at that boundary (i=2, i=4, i=6); the in-betweens were absorbed.
    expect(queue.coalescerStats().flushes).toBe(3);
    expect(queue.get(job.id)?.progress).toEqual(chapterProgress(6, 6));
  });

  it('a terminal transition carries the coalesced snapshot atomically (one write, no lag)', () => {
    const { queue } = harness;
    const { job } = queue.enqueue(downloadPayload('/finish'));
    queue.claim('download');
    queue.updateProgress(job.id, chapterProgress(30, 30));
    // done BEFORE any flush boundary: the terminal UPDATE persists the
    // snapshot itself (progress COALESCEd into the state write).
    const done = queue.transition(job.id, 'done');
    expect(done.progress).toEqual(chapterProgress(30, 30));
    expect(queue.get(job.id)?.progress).toEqual(chapterProgress(30, 30));
    expect(queue.coalescerStats().flushes).toBe(1); // the take(), not a separate UPDATE
    expect(queue.progressOf(job.id)).toEqual(chapterProgress(30, 30));
  });

  it('close() flushes buffered progress (graceful §4 shutdown order)', () => {
    const file = harness.file;
    const { queue } = harness;
    const { job } = queue.enqueue(downloadPayload('/shutdown'));
    queue.claim('download');
    queue.updateProgress(job.id, chapterProgress(7, 30));
    queue.close(); // before any flush boundary
    expect(queue.coalescerStats().flushes).toBe(1);

    // A fresh instance on the same file sees the persisted snapshot.
    const reopened = openHarness(dir);
    try {
      expect(reopened.queue.get(job.id)?.progress).toEqual(chapterProgress(7, 30));
    } finally {
      reopened.queue.close();
    }
    void file;
  });
});
