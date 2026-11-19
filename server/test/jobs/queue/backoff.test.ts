// @vitest-environment node
/**
 * [pipe-health] Retry backoff tests (DESIGN-NORTHSTAR §2 TRIAGE:
 * failures retry on a PACED schedule — never an instant fan-out):
 *
 * 1. the exponential+jitter curve pinned exactly (deterministic
 *    jitter source): base * factor^(attempt-1), multiplicative jitter
 *    up to +50%, capped at 24 h, never below the un-jittered base;
 * 2. a retrying job's `next_attempt_at` holds it out of the claim
 *    pool until the backoff elapses (the claim transaction enforces
 *    it) and the lane SLOT IS FREED while it waits — other work
 *    proceeds on the same single slot (a held-slot backoff would
 *    deadlock the lane for up to the 24 h cap);
 * 3. attempt exhaustion lands in the EXISTING `failed` terminal
 *    state with the typed kind + attempt count;
 * 4. crash recovery re-pools orphaned running rows as IMMEDIATELY
 *    claimable retries (no stamp — prompt boot-time re-pick-up).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaneRunner, type LaneHandlerOutcome, type QueueJob } from '../../../src/jobs/queue/queue.js';
import {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_RETRY_FACTOR,
  DEFAULT_RETRY_JITTER_SHARE,
  defaultRetryBackoffPolicy,
  resolveRetryBackoffPolicy,
  retryBackoffMs,
  type RetryBackoffPolicy,
} from '../../../src/jobs/queue/backoff.js';
import { downloadPayload, mkTmpDir, openHarness, rmDir, type QueueHarness } from '../helpers.js';

describe('retryBackoffMs — the pinned curve', (): void => {
  const base: RetryBackoffPolicy = {
    baseMs: 1_000,
    factor: 2,
    capMs: 24 * 60 * 60 * 1_000,
    jitterShare: 0.5,
    jitter: (): number => 0,
  };

  it('grows geometrically: base * factor^(attempt-1), attempt 1 = base', (): void => {
    expect(retryBackoffMs(base, 1)).toBe(1_000);
    expect(retryBackoffMs(base, 2)).toBe(2_000);
    expect(retryBackoffMs(base, 3)).toBe(4_000);
    expect(retryBackoffMs(base, 4)).toBe(8_000);
    expect(retryBackoffMs(base, 10)).toBe(512_000);
    // attempts < 1 clamp to the first-retry delay.
    expect(retryBackoffMs(base, 0)).toBe(1_000);
  });

  it('caps at 24 h (the charter bound)', (): void => {
    expect(retryBackoffMs(base, 30)).toBe(24 * 60 * 60 * 1_000);
    expect(retryBackoffMs(base, 400)).toBe(24 * 60 * 60 * 1_000);
  });

  it('multiplicative jitter: [base, base * (1 + share)] and never past the cap', (): void => {
    const half: RetryBackoffPolicy = { ...base, jitter: (): number => 0.5 };
    // base * (1 + jitterShare * u) = 1_000 * (1 + 0.5*0.5) = 1_250.
    expect(retryBackoffMs(half, 1)).toBe(1_250);
    expect(retryBackoffMs(half, 3)).toBe(5_000);
    const nearOne: RetryBackoffPolicy = { ...base, jitter: (): number => 0.999_999 };
    expect(retryBackoffMs(nearOne, 1)).toBeGreaterThanOrEqual(1_000);
    expect(retryBackoffMs(nearOne, 1)).toBeLessThanOrEqual(1_500);
    // The cap is absolute — jitter cannot push past it.
    expect(retryBackoffMs(nearOne, 30)).toBe(24 * 60 * 60 * 1_000);
  });

  it('exports the conservative defaults', (): void => {
    expect(DEFAULT_RETRY_BASE_MS).toBe(5_000);
    expect(DEFAULT_RETRY_FACTOR).toBe(2);
    expect(DEFAULT_RETRY_CAP_MS).toBe(24 * 60 * 60 * 1_000);
    expect(DEFAULT_RETRY_JITTER_SHARE).toBe(0.5);
    expect(defaultRetryBackoffPolicy.jitter).toBe(Math.random);
    expect(resolveRetryBackoffPolicy({ baseMs: 100 }).baseMs).toBe(100);
    expect(resolveRetryBackoffPolicy({ baseMs: 100 }).capMs).toBe(DEFAULT_RETRY_CAP_MS);
  });
});

describe('delayed re-claim over the SQLite queue (FakeClock)', (): void => {
  let dir = '';
  let harness: QueueHarness;
  let runner: LaneRunner | undefined;

  beforeEach((): void => {
    dir = mkTmpDir('queue-backoff');
    harness = openHarness(dir);
  });

  afterEach(async (): Promise<void> => {
    if (runner !== undefined) {
      await runner.stop();
      runner = undefined;
    }
    rmDir(dir);
  });

  it('a retry row is unclaimable until next_attempt_at elapses, then re-claimed', async (): Promise<void> => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/paced'));
    runner = new LaneRunner(queue, {
      clock,
      maxAttempts: 3,
      retryBackoff: { baseMs: 5_000, jitter: (): number => 0 },
      lanes: {
        download: {
          concurrency: 1,
          pollIntervalMs: 1,
          // A 50 ms handler makes the running window observable.
          handler: async (): Promise<{ type: 'retry'; error: string }> => {
            await clock.delay(50);
            return { type: 'retry', error: 'transient' };
          },
        },
      },
    });
    runner.start();
    // t=0: claim (attempts 1); t=50: handler → retry stamped 50 + 5_000.
    await clock.advance(60);

    let job: QueueJob | undefined = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('retry');
    expect(job?.attempts).toBe(1);
    expect(job?.nextAttemptAt).toBe(5_050);
    // THE gate: a direct claim while backing off returns nothing.
    expect(queue.claim('download')).toBeUndefined();

    await clock.advance(4_000); // t ≈ 4_060 — still backing off
    job = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('retry');
    expect(queue.claim('download')).toBeUndefined();

    await clock.advance(1_000); // t = 5_060: the stamp elapsed at 5_050 → re-claimed
    job = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('running');
    expect(job?.attempts).toBe(2);
    expect(job?.nextAttemptAt).toBeUndefined();
    // Let the in-flight attempt settle out to its own retry stamp
    // (attempt 2 → 10 s) before stop() drains the slot.
    await clock.advance(200);
    await runner.stop();
    runner = undefined;
    const final = queue.list({ lane: 'download' })[0];
    expect(final?.state).toBe('retry');
    expect(final?.attempts).toBe(2);
    expect(final?.nextAttemptAt).toBeGreaterThan(5_050);
  });

  it('the lane slot is FREED during backoff — other work proceeds', async (): Promise<void> => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/flaky'), { priority: 1 }); // claimed first
    queue.enqueue(downloadPayload('/healthy'));
    const byLink = (link: string): QueueJob | undefined =>
      queue
        .list({ lane: 'download' })
        .find((j): boolean => j.payload.type === 'download' && j.payload.chapterLink === link);
    runner = new LaneRunner(queue, {
      clock,
      maxAttempts: 5,
      retryBackoff: { baseMs: 60_000, jitter: (): number => 0 },
      lanes: {
        download: {
          concurrency: 1, // ONE slot: the freed slot is the whole point
          pollIntervalMs: 1,
          handler: async (job): Promise<LaneHandlerOutcome> =>
            job.payload.type === 'download' && job.payload.chapterLink === '/healthy'
              ? { type: 'done' }
              : { type: 'retry', error: 'transient' },
        },
      },
    });
    runner.start();
    await clock.advance(50); // claim #1 (/flaky) → retry stamped +60 s; slot frees

    // While /flaky backs off for a full minute, /healthy completes on
    // the SAME single slot — a held-slot backoff would deadlock here.
    await clock.advance(1_000);
    expect(byLink('/healthy')?.state).toBe('done');
    expect(byLink('/flaky')?.state).toBe('retry');
    expect(byLink('/flaky')?.nextAttemptAt).toBe(60_000);
    await runner.stop();
    runner = undefined;
  });

  it('attempt exhaustion lands in the existing failed state (typed kind, attempt count)', async (): Promise<void> => {
    const { queue, clock } = harness;
    queue.enqueue(downloadPayload('/doomed'));
    runner = new LaneRunner(queue, {
      clock,
      maxAttempts: 2,
      retryBackoff: { baseMs: 10, jitter: (): number => 0 },
      lanes: {
        download: {
          concurrency: 1,
          pollIntervalMs: 1,
          handler: async (): Promise<{ type: 'retry'; error: string }> => ({ type: 'retry', error: 'flaky image' }),
        },
      },
    });
    runner.start();
    await clock.advance(1_000); // attempt 1 → retry(+10 ms) → attempt 2 → exhausted
    await runner.stop();
    runner = undefined;

    const job: QueueJob | undefined = queue.list({ lane: 'download' })[0];
    expect(job?.state).toBe('failed');
    expect(job?.failureKind).toBe('net');
    expect(job?.attempts).toBe(2);
    expect(job?.error).toContain('flaky image');
  });

  it('crash recovery re-pools running rows as immediately claimable retries', async (): Promise<void> => {
    const { queue } = harness;
    queue.enqueue(downloadPayload('/crashed'));
    const claimed = queue.claim('download');
    expect(claimed?.state).toBe('running');
    // A retry stamp exists only via retry transitions — an orphaned
    // running row recovers with NO stamp (prompt boot-time re-pick-up).
    queue.recoverOrphans(10_000);
    const recovered = queue.list({ lane: 'download' })[0];
    expect(recovered?.state).toBe('retry');
    expect(recovered?.nextAttemptAt).toBeUndefined();
    expect(queue.claim('download')?.id).toBe(claimed?.id);
  });
});
