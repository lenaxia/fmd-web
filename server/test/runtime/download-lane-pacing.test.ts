// @vitest-environment node
/**
 * [pipe-health] Download-lane pacing acceptance (DESIGN-NORTHSTAR §2
 * PIPE: "per-host pacing spreads checks and downloads per origin — no
 * synchronized fan-outs"): N download jobs whose modules share ONE
 * RootURL host, launched CONCURRENTLY in one sweep, start their
 * module sessions ≥ intervalMs apart (no burst), while a DIFFERENT
 * host's job starts immediately — never blocked by the busy bucket.
 *
 * The pin is the acquire→module-hop seam: the handler awaits the
 * shared pacer BEFORE building the module session, so the createHooks
 * call time IS the post-pacing start time. Deterministic FakeClock
 * drives the bucket (no wall-clock sleeps); the chapter bodies run
 * over the loopback fixture site exactly like the layout suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FixtureMangaSite } from '../jobs/download/fixture-site.js';
import { WsHub } from '../../src/api/ws/hub.js';
import { ActiveDownloadRegistry, downloadLane } from '../../src/runtime/download-lane.js';
import type { DownloadLaneDeps } from '../../src/runtime/download-lane.js';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import { ModuleHostPacer, type HostPacingClock } from '../../src/jobs/host-pacing.js';
import type { OutputDefaultsT } from '../../src/api/schemas.js';
import type { ChapterModuleHooks, TaskWriter } from '../../src/jobs/download/types.js';
import type { EngineDownloadOptions, ModuleDownloadHooks } from '../../src/engine/facade.js';
import { mkTmpDir, openHarness, rmDir } from '../jobs/helpers.js';

const MODULE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MODULE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAGE_COUNT = 2;
const CHAPTER_PATH = '/manga/chapter-1';
const INTERVAL_MS = 500;

const OUTPUT: OutputDefaultsT = {
  format: 'zip',
  chapterNameTemplate: '',
  unicodeReplacement: false,
  unicodeReplacementChar: '_',
  digitPadding: 0,
  removeMangaName: false,
};

interface Timer {
  readonly at: number;
  readonly resolve: () => void;
}

async function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await flushMicrotasks();
  }
}

/** Deterministic virtual clock (same discipline as host-pacing.test.ts). */
class FakeClock implements HostPacingClock {
  private t = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const at = this.t + ms;
      let i = 0;
      while (i < this.timers.length && this.timers[i] !== undefined && this.timers[i]!.at <= at) {
        i += 1;
      }
      this.timers.splice(i, 0, { at, resolve });
    });
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await settle();
    for (;;) {
      const next = this.timers[0];
      if (next === undefined || next.at > target) {
        break;
      }
      this.t = Math.max(this.t, next.at);
      this.timers.shift();
      next.resolve();
      await settle();
    }
    this.t = target;
  }
}

function fixtureSiteHooks(base: string): ChapterModuleHooks {
  return {
    getPageNumber: async (task: TaskWriter, url: string): Promise<boolean> => {
      const page = await fetch(url);
      if (!page.ok) {
        return false;
      }
      task.pageNumber = PAGE_COUNT;
      for (let i = 0; i < PAGE_COUNT; i += 1) {
        task.pageLinks[i] = `${base}/img/p${i}`;
      }
      return true;
    },
    getImageURL: async (): Promise<boolean> => true,
    dispose: async (): Promise<void> => undefined,
  } as unknown as ChapterModuleHooks;
}

describe('download lane — per-host pacing (pipe-health acceptance)', (): void => {
  let site: FixtureMangaSite;
  let base = '';
  let dir = '';
  let queue: ReturnType<typeof openHarness>['queue'];
  let db: InstanceType<typeof Database>;

  beforeEach((): void => {
    site = new FixtureMangaSite({ minImageMs: 1 });
    dir = mkTmpDir('lane-pacing-');
  });

  afterEach((): void => {
    void site.stop();
    db.close();
    queue.close();
    rmDir(dir);
  });

  it('N concurrent jobs on one host start spaced ≥ intervalMs; a different host starts immediately', async (): Promise<void> => {
    base = await site.start();
    const clock = new FakeClock();
    // Module → RootURL host: A's two jobs share a.example; B is its own origin.
    const pacer = new ModuleHostPacer({
      rootUrlOf: (moduleId): string | undefined =>
        moduleId === MODULE_A ? 'https://a.example/manga' : moduleId === MODULE_B ? 'https://b.example/manga' : undefined,
      intervalMs: INTERVAL_MS,
      clock,
    });
    /** Post-pacing module-session starts (the acquire→createHooks seam). */
    const starts: Array<{ moduleId: string; at: number }> = [];

    const harness = openHarness(dir);
    queue = harness.queue;
    db = new Database(path.join(dir, 'lib.db'));
    const library = new SqliteLibraryStore({ db, libraryRoot: path.join(dir, 'library') });
    const deps: DownloadLaneDeps = {
      queue,
      wsHub: new WsHub(),
      library,
      dataDir: dir,
      engine: { modules: (): readonly unknown[] => [] } as never,
      createHooks: (moduleId: string, _engine: EngineDownloadOptions): Promise<ModuleDownloadHooks> => {
        // THE observable: recorded the instant the pacing gate opened.
        starts.push({ moduleId, at: clock.now() });
        return Promise.resolve(fixtureSiteHooks(base) as ModuleDownloadHooks);
      },
      active: new ActiveDownloadRegistry(),
      log: (): void => undefined,
      outputDefaults: (): OutputDefaultsT => OUTPUT,
      // THE seam under test: the shared per-host pacer (§2 PIPE).
      pacer,
    };
    const lane = downloadLane(deps);

    const launch = (moduleId: string, mangaUrl: string): Promise<{ type: string }> => {
      const { job } = queue.enqueue({
        type: 'download',
        moduleId,
        mangaUrl,
        mangaTitle: 'Paced Quest',
        chapterLink: `${base}${CHAPTER_PATH}`,
        chapterName: 'Chapter 1',
      } as never);
      return lane
        .handler(job as never, { setProgress: (): void => undefined } as never)
        .then((outcome) => outcome as { type: string });
    };

    // ONE concurrent sweep: three A jobs + one B job, no serialization.
    const runs = [
      launch(MODULE_A, 'https://a.example/manga/one'),
      launch(MODULE_B, 'https://b.example/manga/solo'),
      launch(MODULE_A, 'https://a.example/manga/two'),
      launch(MODULE_A, 'https://a.example/manga/three'),
    ];
    // Drive the bucket: tokens open at t=0, 500, 1000 (virtual time).
    await clock.advance(4_000);
    // Let the (real, loopback-fast) chapter bodies finish.
    const outcomes = await Promise.all(runs);
    expect(outcomes.map((outcome): string => outcome.type)).toEqual(['done', 'done', 'done', 'done']);

    // Host A: strict spacing — [0, I, 2I], every gap ≥ interval (no burst).
    const aStarts = starts
      .filter((start): boolean => start.moduleId === MODULE_A)
      .map((start): number => start.at)
      .sort((x, y): number => x - y);
    expect(aStarts).toEqual([0, INTERVAL_MS, 2 * INTERVAL_MS]);
    for (let i = 1; i < aStarts.length; i += 1) {
      expect(aStarts[i]! - aStarts[i - 1]!).toBeGreaterThanOrEqual(INTERVAL_MS);
    }
    // Host B: never blocked by A's busy bucket — started at t=0.
    expect(starts.filter((start): boolean => start.moduleId === MODULE_B).map((start): number => start.at)).toEqual([0]);
  });
});
