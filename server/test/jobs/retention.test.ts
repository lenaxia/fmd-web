import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadPayload, mkTmpDir, openHarness, rmDir, type QueueHarness } from './helpers.js';
import { RETENTION_MS } from '../../src/jobs/queue/queue.js';

/**
 * §9 retention drill on a deterministic fake clock: terminal job
 * history is pruned after 30 days; non-terminal rows (queued/running/
 * retry) survive NO MATTER how ancient, and nothing is pruned a
 * millisecond early.
 */
describe('§9 retention — prune >30d jobs (fake clock)', () => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-prune');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('terminal rows pruned strictly AFTER 30 days; live rows immune', async () => {
    const { queue, clock } = harness;

    // ── t=0: one row per terminal state, plus a queued row that will go ancient.
    const doneAtT0 = (() => {
      const { job } = queue.enqueue(downloadPayload('/done'));
      queue.claim('download');
      return queue.transition(job.id, 'done');
    })();
    const failedAtT0 = (() => {
      const { job } = queue.enqueue({ type: 'info', moduleId: 'm'.repeat(32), url: 'u' });
      queue.claim('info');
      return queue.transition(job.id, 'failed', { failureKind: 'net', error: 'upstream 5xx' });
    })();
    const cancelledAtT0 = (() => {
      const { job } = queue.enqueue({ type: 'update' });
      return queue.cancel(job.id);
    })();
    const ancientQueued = queue.enqueue({ type: 'sync', target: 'modules' }).job;

    // ── t = 30d − 1 ms: nothing is prunable yet.
    await clock.advance(RETENTION_MS - 1);
    expect(queue.pruneRetention()).toBe(0);
    expect(queue.get(doneAtT0.id)).toBeDefined();

    // ── t = 30d + 1 s: the t=0 terminal rows cross the boundary.
    await clock.advance(1_001);
    expect(queue.pruneRetention()).toBe(3);
    expect(queue.get(doneAtT0.id)).toBeUndefined();
    expect(queue.get(failedAtT0.id)).toBeUndefined();
    expect(queue.get(cancelledAtT0.id)).toBeUndefined();
    // The ancient QUEUED row survives — retention is terminal-only.
    expect(queue.get(ancientQueued.id)?.state).toBe('queued');
  });

  it('a terminal row freshly completed at the boundary survives (updated_at is the clock)', async () => {
    const { queue, clock } = harness;

    // Complete a job AT t = 30d: its updated_at sits exactly on the default cutoff.
    await clock.advance(RETENTION_MS);
    const freshDone = (() => {
      const { job } = queue.enqueue(downloadPayload('/fresh'));
      queue.claim('download');
      return queue.transition(job.id, 'done');
    })();

    await clock.advance(1_000); // t = 30d + 1s → cutoff = 1s < updated_at(30d) → survives
    expect(queue.pruneRetention()).toBe(0);
    expect(queue.get(freshDone.id)).toBeDefined();

    // 30 days after COMPLETION it goes.
    await clock.advance(RETENTION_MS); // t = 60d + 1s → cutoff = 30d + 1s > 30d → pruned
    expect(queue.pruneRetention()).toBe(1);
    expect(queue.get(freshDone.id)).toBeUndefined();
  });

  it('an explicit now argument prunes against that instant (caller-supplied clock)', async () => {
    const { queue, clock } = harness;
    const doneJob = (() => {
      const { job } = queue.enqueue(downloadPayload('/d'));
      queue.claim('download');
      return queue.transition(job.id, 'done');
    })();

    await clock.advance(RETENTION_MS + 5_000); // t = 30d + 5s → the default NOW prunes it
    // An explicit SMALLER now (t = 1s) prunes nothing — the argument controls.
    expect(queue.pruneRetention(1_000)).toBe(0);
    expect(queue.get(doneJob.id)).toBeDefined();
    // Default now (the fake clock) prunes.
    expect(queue.pruneRetention()).toBe(1);
    expect(queue.get(doneJob.id)).toBeUndefined();
  });

  it('running/retry rows are never pruned even when ancient', async () => {
    const { queue, clock } = harness;
    const { job } = queue.enqueue(downloadPayload('/ancient-running'));
    queue.claim('download');
    const retrying = (() => {
      const { job } = queue.enqueue(downloadPayload('/ancient-retry'));
      queue.claim('download'); // claim matches queued|retry — picks this one
      queue.transition(job.id, 'retry');
      return job;
    })();

    await clock.advance(RETENTION_MS * 2);
    expect(queue.pruneRetention()).toBe(0);
    expect(queue.get(job.id)?.state).toBe('running');
    expect(queue.get(retrying.id)?.state).toBe('retry');
  });
});

describe('[parity-sweep] M2 — settings-driven retention (PUT /api/settings/retention)', () => {
  let dir: string;

  afterEach(() => {
    rmDir(dir);
  });

  const terminalRowAtT0 = (h: QueueHarness): string => {
    const { job } = h.queue.enqueue(downloadPayload('/settings-prune'));
    h.queue.claim('download');
    h.queue.transition(job.id, 'done');
    return job.id;
  };

  it('a LIVE provider window is honored: 7 days prunes at the 7-day boundary', async () => {
    dir = mkTmpDir('queue-prune-settings');
    const harness = openHarness(dir, { retentionMs: (): number => 7 * 86_400_000 });
    const id = terminalRowAtT0(harness);
    await harness.clock.advance(6 * 86_400_000);
    expect(harness.queue.pruneRetention()).toBe(0);
    expect(harness.queue.get(id)).toBeDefined();
    await harness.clock.advance(2 * 86_400_000);
    expect(harness.queue.pruneRetention()).toBe(1);
    expect(harness.queue.get(id)).toBeUndefined();
    harness.queue.close();
  });

  it('the window is re-read at EVERY prune: a settings change applies on the next sweep', async () => {
    dir = mkTmpDir('queue-prune-live');
    let days = 30;
    const harness = openHarness(dir, { retentionMs: (): number => days * 86_400_000 });
    const id = terminalRowAtT0(harness);
    await harness.clock.advance(10 * 86_400_000);
    days = 7; // PUT /api/settings/retention { days: 7 }
    expect(harness.queue.pruneRetention()).toBe(1);
    expect(harness.queue.get(id)).toBeUndefined();
    harness.queue.close();
  });

  it('days = 0 KEEPS FOREVER (ancient terminal rows survive)', async () => {
    dir = mkTmpDir('queue-prune-forever');
    const harness = openHarness(dir, { retentionMs: (): number => 0 });
    const id = terminalRowAtT0(harness);
    await harness.clock.advance(3650 * 86_400_000);
    expect(harness.queue.pruneRetention()).toBe(0);
    expect(harness.queue.get(id)).toBeDefined();
    harness.queue.close();
  });

  it('a negative provider result is treated as keep-forever (defensive)', async () => {
    dir = mkTmpDir('queue-prune-negative');
    const harness = openHarness(dir, { retentionMs: (): number => -1 });
    const id = terminalRowAtT0(harness);
    await harness.clock.advance(400 * 86_400_000);
    expect(harness.queue.pruneRetention()).toBe(0);
    expect(harness.queue.get(id)).toBeDefined();
    harness.queue.close();
  });
});
