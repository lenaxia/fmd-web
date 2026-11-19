// @vitest-environment node
/**
 * [triage] Retry-all pacing acceptance (D1 §2 TRIAGE: "a paced
 * retry-all — per-host pacing applies to retries exactly as to fresh
 * work; retry-all is never an instant fan-out"; tsk-granite-crown-
 * orders AC1): failed jobs re-enqueued by TriageService.retryGroup
 * re-enter the download lane and their module sessions start ≥
 * intervalMs apart on ONE host, while a DIFFERENT host's retry starts
 * immediately — never blocked by the busy bucket.
 *
 * The pin is the END-TO-END composition the charter names: real
 * SQLite queue rows driven to the REAL `failed` terminal state (typed
 * kind + error text), classified by the triage snapshot (429
 * vocabulary → throttled), re-enqueued by retryGroup through the
 * SAME per-job retry action the downloads tab uses, then run by the
 * download lane with the shared per-host pacer attached. The
 * acquire→module-hop seam (createHooks call time = post-pacing start)
 * is the observable, exactly like download-lane-pacing.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FixtureMangaSite } from '../jobs/download/fixture-site.js';
import { WsHub } from '../../src/api/ws/hub.js';
import { ActiveDownloadRegistry, downloadLane, RuntimeJobService } from '../../src/runtime/download-lane.js';
import type { DownloadLaneDeps } from '../../src/runtime/download-lane.js';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import { ModuleHostPacer, type HostPacingClock } from '../../src/jobs/host-pacing.js';
import { TriageService } from '../../src/runtime/triage.js';
import type { OutputDefaultsT } from '../../src/api/schemas.js';
import type { ChapterModuleHooks, TaskWriter } from '../../src/jobs/download/types.js';
import type { EngineDownloadOptions, ModuleDownloadHooks } from '../../src/engine/facade.js';
import { mkTmpDir, openHarness, rmDir } from '../jobs/helpers.js';

const MODULE_A = 'a'.repeat(32);
const MODULE_B = 'b'.repeat(32);
const PAGE_COUNT = 2;
const CHAPTER_PATH = '/manga/chapter-1';
const INTERVAL_MS = 500;
/** The seeded 429-flavored failure text (the classifier input). */
const RATE_LIMITED_ERROR = '2 image(s) failed — #0: HTTP 429 too many requests';
/** A cause-less net failure (lands in `other`). */
const OTHER_ERROR = '1 image(s) failed — #0: connection reset';

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

/** Deterministic virtual clock (same discipline as download-lane-pacing.test.ts). */
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
        task.pageLinks[i] = `${base}/img/p${String(i)}`;
      }
      return true;
    },
    getImageURL: async (): Promise<boolean> => true,
    dispose: async (): Promise<void> => undefined,
  } as unknown as ChapterModuleHooks;
}

describe('triage retry-all — per-host pacing (pipe-health + triage acceptance)', (): void => {
  let site: FixtureMangaSite;
  let base = '';
  let dir = '';
  let queue: ReturnType<typeof openHarness>['queue'];
  let db: InstanceType<typeof Database>;

  beforeEach((): void => {
    site = new FixtureMangaSite({ minImageMs: 1 });
    dir = mkTmpDir('triage-pacing-');
  });

  afterEach((): void => {
    void site.stop();
    db.close();
    queue.close();
    rmDir(dir);
  });

  it('retryGroup re-enqueues through the SAME paced lane: one host spaced ≥ intervalMs, the other immediate', async (): Promise<void> => {
    base = await site.start();
    const clock = new FakeClock();
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
        starts.push({ moduleId, at: clock.now() });
        return Promise.resolve(fixtureSiteHooks(base) as ModuleDownloadHooks);
      },
      active: new ActiveDownloadRegistry(),
      log: (): void => undefined,
      outputDefaults: (): OutputDefaultsT => OUTPUT,
      pacer,
    };
    const lane = downloadLane(deps);

    // ── seed: REAL failed rows (queued → running → failed, typed kind
    // + error text) — three 429s on host A, one unclassified net
    // failure on host B.
    const seedFailed = (moduleId: string, key: string, error: string): void => {
      const { job } = queue.enqueue(
        {
          type: 'download',
          moduleId,
          mangaUrl: `https://${moduleId === MODULE_A ? 'a' : 'b'}.example/manga/x`,
          mangaTitle: 'Paced Quest',
          chapterLink: `${base}${CHAPTER_PATH}`,
          chapterName: 'Chapter 1',
        } as never,
        { idempotencyKey: key },
      );
      queue.transition(job.id, 'running');
      queue.transition(job.id, 'failed', { failureKind: 'net', error });
    };
    seedFailed(MODULE_A, 'k-a1', RATE_LIMITED_ERROR);
    seedFailed(MODULE_A, 'k-a2', RATE_LIMITED_ERROR);
    seedFailed(MODULE_A, 'k-a3', RATE_LIMITED_ERROR);
    seedFailed(MODULE_B, 'k-b1', OTHER_ERROR);

    // ── the attention surface: classification over the REAL rows
    // (3 × throttled on A, 1 × other on B — the vocabulary pins).
    const jobs = new RuntimeJobService(queue, (): boolean => false);
    const triage = new TriageService({ jobs });
    const snap = triage.snapshot();
    expect(snap.failedTotal).toBe(4);
    expect(snap.groups.find((group): boolean => group.cause === 'throttled')?.count).toBe(3);
    expect(snap.groups.find((group): boolean => group.cause === 'other')?.count).toBe(1);

    // ── the retry-alls: BOTH groups, routed through the SAME per-job
    // retry action the downloads tab uses (fresh chained attempts).
    const rateLimited = triage.retryGroup('throttled');
    const other = triage.retryGroup('other');
    expect(rateLimited.affected).toBe(3);
    expect(other.affected).toBe(1);
    expect(rateLimited.jobs.every((job): boolean => job.moduleId === MODULE_A)).toBe(true);
    expect(rateLimited.jobs.map((job): string => job.state)).toEqual(['queued', 'queued', 'queued']);

    // ── the paced lane runs the re-enqueued rows: one concurrent
    // sweep over the retryGroup-created queued set, no serialization.
    const retriedRows = queue
      .list({ lane: 'download' })
      .filter((row): boolean => row.state === 'queued' && (row.idempotencyKey ?? '').startsWith('k-'));
    expect(retriedRows).toHaveLength(4);
    const runs = retriedRows.map(
      (row): Promise<{ type: string }> =>
        lane
          .handler(row as never, { setProgress: (): void => undefined } as never)
          .then((outcome) => outcome as { type: string }),
    );
    // Drive the bucket: A tokens open at t=0, 500, 1000 (virtual time).
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
