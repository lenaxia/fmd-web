/**
 * cbAddAsStopped hold at the QUEUE level (§4/§9): a paused enqueue is
 * a `queued` row the claim transaction cannot see — a live LaneRunner
 * skips it (state stays queued, handler never runs) until `resume()`
 * lifts the hold and the very next claim picks the row up. This is
 * the "queued, not auto-run, until resumed" contract behind the
 * MangaPage 'Start paused' option.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaneRunner } from '../../src/jobs/queue/queue.js';
import { downloadPayload, mkTmpDir, openHarness, rmDir, type QueueHarness } from './helpers.js';

describe('SqliteJobQueue — paused rows are unclaimable until resume', (): void => {
  let dir: string;
  let harness: QueueHarness;

  beforeEach(() => {
    dir = mkTmpDir('queue-paused');
    harness = openHarness(dir);
  });

  afterEach(() => {
    harness.queue.close();
    rmDir(dir);
  });

  it('enqueue({paused:true}) → queued row with the hold on the wire projection', (): void => {
    const { job } = harness.queue.enqueue(downloadPayload('/ch/1'), { paused: true });
    expect(job.state).toBe('queued');
    expect(job.paused).toBe(true);
    expect(harness.queue.get(job.id)?.paused).toBe(true);
  });

  it('claim skips paused rows (undefined) while unpaused siblings claim normally', (): void => {
    const paused = harness.queue.enqueue(downloadPayload('/ch/paused'), { paused: true }).job;
    const live = harness.queue.enqueue(downloadPayload('/ch/live')).job;

    // FIFO would hand back the PAUSED row (lower id) first — the claim
    // transaction must look past it to the live sibling.
    const claimed = harness.queue.claim('download', { workerId: 'w' });
    expect(claimed?.id).toBe(live.id);
    expect(claimed?.state).toBe('running');

    // The paused row is still queued and untouched by that claim.
    const still = harness.queue.get(paused.id);
    expect(still?.state).toBe('queued');
    expect(still?.paused).toBe(true);

    // Nothing else claimable on the lane.
    expect(harness.queue.claim('download', { workerId: 'w' })).toBeUndefined();
  });

  it('resume lifts the hold; the row claims on the next attempt; resume is idempotent', (): void => {
    const { job } = harness.queue.enqueue(downloadPayload('/ch/paused'), { paused: true });
    expect(harness.queue.claim('download', { workerId: 'w' })).toBeUndefined();

    const resumed = harness.queue.resume(job.id);
    expect(resumed.state).toBe('queued');
    expect(resumed.paused).toBe(false);

    // Idempotent: resuming again still returns the (claimable) row.
    expect(harness.queue.resume(job.id).paused).toBe(false);

    const claimed = harness.queue.claim('download', { workerId: 'w' });
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.state).toBe('running');
  });

  it('resume guards: terminal rows and unknown ids throw; cancel works on a held row', (): void => {
    const held = harness.queue.enqueue(downloadPayload('/ch/held'), { paused: true }).job;
    expect(harness.queue.cancel(held.id).state).toBe('cancelled');
    expect((): void => {
      harness.queue.resume(held.id);
    }).toThrow(/nothing to resume/);
    expect((): void => {
      harness.queue.resume('99999');
    }).toThrow(/not found/);
  });
});

describe('LaneRunner + paused — the integration contract (cbAddAsStopped)', (): void => {
  let dir: string;
  let harness: QueueHarness;
  let runner: LaneRunner | undefined;

  beforeEach(() => {
    dir = mkTmpDir('queue-paused-runner');
    harness = openHarness(dir);
  });

  afterEach(async (): Promise<void> => {
    await runner?.stop();
    harness.queue.close();
    rmDir(dir);
  });

  it('a running lane never touches a paused job until resume — then it runs to done', async (): Promise<void> => {
    const { queue, clock } = harness;
    const handled: string[] = [];

    runner = new LaneRunner(queue, {
      clock,
      lanes: {
        download: {
          concurrency: 1,
          pollIntervalMs: 10,
          handler: async (job): Promise<{ type: 'done' }> => {
            handled.push(job.payload.type === 'download' ? job.payload.chapterLink : `unexpected:${job.payload.type}`);
            return { type: 'done' };
          },
        },
      },
    });
    runner.start();

    // Paused first (FIFO would take it first), then a live sibling.
    const paused = queue.enqueue(downloadPayload('/ch/paused'), { paused: true }).job;
    const live = queue.enqueue(downloadPayload('/ch/live')).job;
    await clock.advance(200);

    expect(handled).toEqual(['/ch/live']); // the held row was skipped
    expect(queue.get(paused.id)?.state).toBe('queued'); // queued, not auto-run
    expect(queue.get(live.id)?.state).toBe('done');

    // Lift the hold — the next poll claims and completes the row.
    queue.resume(paused.id);
    await clock.advance(200);
    expect(handled).toEqual(['/ch/live', '/ch/paused']);
    expect(queue.get(paused.id)?.state).toBe('done');
  });
});
