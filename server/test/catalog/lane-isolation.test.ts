/**
 * §6.8/§4 scrape isolation under concurrent load: the live-scrape
 * walks run on the UPDATE lane's slot budget (UpdateLaneScrapeGate)
 * while downloads run the real download lane (LaneRunner over the
 * SQLite queue). Saturating the scrape slots queues further scrapes
 * FIFO but NEVER delays downloads — and a busy download lane never
 * blocks a scrape. Deterministic (manual walkers, event-loop polling,
 * no wall-clock sleeps).
 */
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@fmd/contract';
import { LiveScrapeCatalogStore } from '../../src/catalog/live-scrape-store.js';
import { UpdateLaneScrapeGate } from '../../src/catalog/update-lane-gate.js';
import { LaneRunner, type LaneHandlerOutcome } from '../../src/jobs/queue/queue.js';
import { downloadPayload, mkTmpDir, openHarness, rmDir } from '../jobs/helpers.js';
import { makeRegistration } from '../api/helpers.js';

const MODULE_A = 'b'.repeat(32);
const MODULE_B = 'e'.repeat(32);
const MODULE_C = '9'.repeat(32);

function entry(link: string): CatalogEntry {
  return {
    link,
    title: link,
    alttitles: '',
    authors: '',
    artists: '',
    genres: '',
    status: '',
    summary: '',
    numChapter: 0,
    jdn: 0,
  };
}

/** Manual walker: every walk parks on a promise the test resolves. */
class ManualWalker {
  private readonly resolvers: Array<(entries: readonly CatalogEntry[]) => void> = [];

  get started(): number {
    return this.resolvers.length;
  }

  walk(_moduleId: string): Promise<readonly CatalogEntry[]> {
    return new Promise<readonly CatalogEntry[]>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  finish(index: number): void {
    this.resolvers[index]?.([entry('/manga/resolved')]);
  }
}

/** Bounded event-loop poll (deterministic; no sleeps). */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1); // yield to timers (lane poll quantum)
    });
  }
  throw new Error(`condition not met: ${what}`);
}

function makeStore(walker: ManualWalker, gate: UpdateLaneScrapeGate): LiveScrapeCatalogStore {
  return new LiveScrapeCatalogStore({
    walk: { walk: (id: string): Promise<readonly CatalogEntry[]> => walker.walk(id) },
    modules: (): readonly ReturnType<typeof makeRegistration>[] => [
      makeRegistration({ id: MODULE_A, name: 'LiveSourceA' }),
      makeRegistration({ id: MODULE_B, name: 'LiveSourceB' }),
      makeRegistration({ id: MODULE_C, name: 'LiveSourceC' }),
    ],
    laneGate: gate,
    ttlMs: 0, // every request re-walks (isolation tests control walks manually)
  });
}

describe('§4 lane isolation: update-lane scrapes vs download lane (concurrent load)', (): void => {
  it('saturated scrape slots queue scrapes FIFO while downloads complete unblocked', async (): Promise<void> => {
    const dir = mkTmpDir('scrape-isolation');
    const harness = openHarness(dir);
    try {
      const gate = new UpdateLaneScrapeGate(1);
      const walker = new ManualWalker();
      const store = makeStore(walker, gate);

      // Download lane: real SQLite queue, 2 slots, fast handlers.
      const completed: string[] = [];
      // Download lane: real SQLite queue, 2 slots, fast handlers.
      // (Constructed up front but STARTED only after the enqueue below,
      // so the first synchronous claim picks the jobs up immediately.)
      const runner = new LaneRunner(harness.queue, {
        lanes: {
          download: {
            concurrency: 2,
            pollIntervalMs: 1,
            handler: async (job): Promise<LaneHandlerOutcome> => {
              completed.push(job.id);
              return { type: 'done' };
            },
          },
        },
      });

      // Saturate the update-lane scrape budget: 1 slot, 3 cold scrapes
      // (different modules — independent walks, no single-flight joins).
      const s1 = store.latest(MODULE_A);
      const s2 = store.latest(MODULE_B);
      const s3 = store.byTitle(MODULE_C);
      await until((): boolean => gate.active === 1 && gate.queued === 2, 'scrape queue saturation');
      expect(walker.started).toBe(1); // only scrape 1 walks

      // Downloads enqueue + run WHILE all scrape work is parked.
      for (const chapter of ['/ch/1', '/ch/2', '/ch/3']) {
        harness.queue.enqueue(downloadPayload(`https://site.example/manga/x${chapter}`));
      }
      runner.start();
      await until((): boolean => completed.length === 3, 'download lane drained');
      // THE ISOLATION PROOF: downloads finished end-to-end while the
      // update-lane scrapes were still parked/queued — the download
      // lane's slots were never touched by scrape saturation.
      expect(completed).toHaveLength(3);
      expect(gate.queued).toBe(2);
      expect(walker.started).toBe(1);

      // Release scrape 1 → the slot hands off FIFO (scrape 2 walks next).
      walker.finish(0);
      expect(await s1).toBeDefined();
      await until((): boolean => walker.started === 2, 'scrape 2 claimed the slot');
      expect(gate.active).toBe(1);
      walker.finish(1);
      expect(await s2).toBeDefined();
      await until((): boolean => walker.started === 3, 'scrape 3 claimed the slot');
      walker.finish(2);
      expect(await s3).toBeDefined();
      expect(completed).toHaveLength(3); // downloads never re-ordered or lost
      expect(gate.active).toBe(0);
      expect(gate.queued).toBe(0);

      await runner.stop();
    } finally {
      harness.queue.close();
      rmDir(dir);
    }
  });

  it('a busy download lane never blocks an update-lane scrape', async (): Promise<void> => {
    const dir = mkTmpDir('scrape-isolation-inverse');
    const harness = openHarness(dir);
    try {
      const gate = new UpdateLaneScrapeGate(1);
      const walker = new ManualWalker();
      const store = makeStore(walker, gate);

      // Download lane: one slot parked on a manual promise (worst case:
      // a wedged chapter download).
      let finishDownload: (() => void) | undefined;
      // Enqueue BEFORE start: the first synchronous claim parks the
      // handler on the manual release.
      harness.queue.enqueue(downloadPayload('https://site.example/manga/y/ch/1'));
      const runner = new LaneRunner(harness.queue, {
        lanes: {
          download: {
            concurrency: 1,
            pollIntervalMs: 1,
            handler: async (): Promise<LaneHandlerOutcome> =>
              new Promise<LaneHandlerOutcome>((resolve) => {
                finishDownload = (): void => {
                  resolve({ type: 'done' });
                };
              }),
          },
        },
      });
      runner.start();
      await until((): boolean => finishDownload !== undefined, 'download handler parked');

      // The scrape proceeds (walk starts, slot held) DESPITE the parked
      // download — independent lanes, independent slot budgets.
      const scrape = store.latest(MODULE_A);
      await until((): boolean => walker.started === 1, 'scrape walk started');
      expect(gate.active).toBe(1);
      walker.finish(0);
      expect(await scrape).toBeDefined();
      expect(finishDownload).toBeDefined(); // download still parked

      finishDownload?.();
      await until((): boolean => runner.activeCount('download') === 0, 'download lane drained');
      await runner.stop();
    } finally {
      harness.queue.close();
      rmDir(dir);
    }
  });
});
