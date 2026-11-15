import { describe, expect, it } from 'vitest';
import { ConcurrentImageWorkerPool } from '../../../src/jobs/download/image-worker-pool.js';

/**
 * ImageWorkerPool (DESIGN §7.1 / §5.3: `MaxThreadPerTaskLimit` threads
 * per task — uDownloadsManager.pas:870-920): a bounded-concurrency
 * driver over a FIFO of work ids. Cancellation stops scheduling
 * queued-but-unstarted items; in-flight items settle on their own
 * (the pipeline aborts them via HTTP.Terminated, §4).
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

describe('ConcurrentImageWorkerPool', () => {
  it('runs every work id exactly once', async () => {
    const pool = new ConcurrentImageWorkerPool();
    const seen: number[] = [];
    await pool.run([0, 1, 2, 3], 2, async (workId) => {
      seen.push(workId);
    });
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(seen).toHaveLength(4);
  });

  it('honors maxThreads=1 (strict sequential order, MaxThreadPerTaskLimit)', async () => {
    const pool = new ConcurrentImageWorkerPool();
    const order: number[] = [];
    await pool.run([5, 3, 1], 1, async (workId) => {
      order.push(workId);
    });
    expect(order).toEqual([5, 3, 1]);
  });

  it('never exceeds the concurrency bound under parallel work', async () => {
    const pool = new ConcurrentImageWorkerPool();
    let inflight = 0;
    let peak = 0;
    await pool.run(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (workId) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5 * (workId % 3)));
        inflight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually parallel
  });

  it('concurrency above the queue length degrades to the queue size', async () => {
    const pool = new ConcurrentImageWorkerPool();
    let inflight = 0;
    let peak = 0;
    await pool.run([0, 1], 8, async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await flush();
      inflight -= 1;
    });
    expect(peak).toBe(2);
  });

  it('shouldStop skips queued-but-unstarted items (§4 fail fast)', async () => {
    const pool = new ConcurrentImageWorkerPool();
    const started: number[] = [];
    let stop = false;
    await pool.run(
      [0, 1, 2, 3, 4],
      1,
      async (workId) => {
        started.push(workId);
        if (workId === 1) {
          stop = true;
        }
      },
      () => stop,
    );
    expect(started).toEqual([0, 1]); // 2..4 never started
  });

  it('a throwing worker does not sink the pool; the error surfaces per item', async () => {
    const pool = new ConcurrentImageWorkerPool();
    const done: number[] = [];
    const failures = await pool.run(
      [0, 1, 2],
      1,
      async (workId) => {
        if (workId === 1) {
          throw new Error('boom');
        }
        done.push(workId);
      },
      () => false,
    );
    expect(done).toEqual([0, 2]);
    expect(failures).toEqual([{ workId: 1, error: 'boom' }]);
  });

  it('resolves when the queue is empty', async () => {
    const pool = new ConcurrentImageWorkerPool();
    await expect(pool.run([], 3, async () => undefined)).resolves.toEqual([]);
  });
});
