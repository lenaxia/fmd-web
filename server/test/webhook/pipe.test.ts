// @vitest-environment node
/**
 * The pipe-level webhook pin (webhook story, acceptance-shaped): the
 * PRODUCTION wiring shape — FavoritesEngine → FavoriteScheduler (with
 * the sweep + failure seams) → SweepAccumulator/SiteFailureCoalescer →
 * WebhookNotifier — over a real SqliteLibraryStore, a scripted info
 * service (one DEAD site, one healthy site) and a counting fake
 * transport. Pinned:
 *
 * - a dead site with N favorites produces exactly ONE failure.digest
 *   delivery per digest window (never N), plus ONE favorites.digest
 *   per completed sweep summarizing every favorite it checked;
 * - the next sweep produces the NEXT favorites.digest (one per sweep,
 *   not one per check);
 * - muted event classes produce nothing (the toggle gate rides the
 *   same wiring).
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FailureDigestData, WebhookEnvelope } from '@fmd/contract';
import { FavoritesEngine, type FavoriteDownloadQueue } from '../../src/jobs/favorites/engine.js';
import { FavoriteScheduler, type FavoriteClock } from '../../src/jobs/favorites/scheduler.js';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import type { NormalizedInfo } from '../../src/api/services.js';
import { WebhookNotifier, type WebhookPostFn } from '../../src/webhook/delivery.js';
import { SiteFailureCoalescer, type ScheduleFlush } from '../../src/webhook/digest.js';
import { SweepAccumulator } from '../../src/webhook/sweep.js';
import type { WebhookSettingsT } from '../../src/api/schemas.js';
import { mkTmpDir, rmDir } from '../jobs/helpers.js';

const DEAD_MODULE = 'a'.repeat(32);
const LIVE_MODULE = 'b'.repeat(32);
const DEAD_URL = 'https://dead.example/manga/x';
const LIVE_URL = 'https://live.example/manga/y';

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

/** Virtual clock (the scheduler-test discipline — time moves only here). */
class FakeClock implements FavoriteClock {
  private t = 0;
  private readonly timers: { at: number; resolve: () => void }[] = [];

  now(): number {
    return this.t;
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve): void => {
      this.timers.push({ at: this.t + Math.max(0, ms), resolve });
    });
  }

  async advance(ms: number): Promise<void> {
    this.t += ms;
    for (;;) {
      const due = this.timers.filter((timer): boolean => timer.at <= this.t);
      if (due.length === 0) {
        break;
      }
      for (const timer of due) {
        this.timers.splice(this.timers.indexOf(timer), 1);
        timer.resolve();
      }
      await settle(2);
    }
  }
}

async function settle(turns: number = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve): void => {
      setImmediate(resolve);
    });
  }
}

/** Dead site throws; healthy site serves two chapters, one already stored. */
class ScriptedInfo {
  public calls = 0;

  async getInfo(moduleId: string, _url: string): Promise<NormalizedInfo> {
    this.calls += 1;
    if (moduleId === DEAD_MODULE) {
      throw new Error('connection refused (dead site)');
    }
    const chapterLinks = ['https://live.example/ch/1', 'https://live.example/ch/2'];
    return {
      title: 'Live Series',
      altTitles: '',
      authors: '',
      artists: '',
      genres: '',
      status: 'Ongoing',
      summary: '',
      coverLink: '',
      url: LIVE_URL,
      link: LIVE_URL,
      chapterLinks,
      chapterNames: chapterLinks.map((_link, i) => `Chapter ${String(i + 1)}`),
      numChapter: chapterLinks.length,
    };
  }
}

class RecordingQueue implements FavoriteDownloadQueue {
  public created = 0;

  createDownload(): { jobId: string } {
    this.created += 1;
    return { jobId: `job-${String(this.created)}` };
  }
}

/** Counting fake transport: records every envelope by event class. */
class RecordingPost {
  public readonly attempts: { url: string; body: string }[] = [];

  public readonly post: WebhookPostFn = async (url, body): Promise<{ status: number }> => {
    this.attempts.push({ url, body });
    return { status: 200 };
  };

  public events(cls: string): WebhookEnvelope<unknown>[] {
    return this.attempts
      .map((a): WebhookEnvelope<unknown> => JSON.parse(a.body) as WebhookEnvelope<unknown>)
      .filter((env): boolean => env.event === cls);
  }
}

interface Pipe {
  clock: FakeClock;
  scheduler: FavoriteScheduler;
  post: RecordingPost;
  armedWindows: Set<() => void>;
  engine: FavoritesEngine;
}

/** The production wiring shape, miniaturized (see runtime/assembly.ts). */
function openPipe(webhook: WebhookSettingsT, favorites: { dead: number; live: number }): Pipe {
  const dir = mkTmpDir('webhook-pipe');
  dbFile = path.join(dir, 'app.db');
  const raw = new Database(dbFile);
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: path.join(dir, 'library') });
  const info = new ScriptedInfo();
  const queue = new RecordingQueue();
  const engine = new FavoritesEngine({ store, info, downloads: queue });
  for (let i = 0; i < favorites.dead; i += 1) {
    engine.createFavorite({ moduleId: DEAD_MODULE, url: `${DEAD_URL}/${String(i)}` });
  }
  for (let i = 0; i < favorites.live; i += 1) {
    const row = engine.createFavorite({ moduleId: LIVE_MODULE, url: `${LIVE_URL}/${String(i)}`, autoDownload: true });
    // One chapter already stored → the sweep finds exactly one new one.
    store.upsertFavorite({ ...row, downloadedChapterList: 'https://live.example/ch/1' });
  }

  const clock = new FakeClock();
  const post = new RecordingPost();
  const notifier = new WebhookNotifier({
    settings: (): WebhookSettingsT => webhook,
    post: post.post,
    backoffMs: (): number => 0,
  });
  const armedWindows = new Set<() => void>();
  const schedule: ScheduleFlush = (fire): { cancel(): void } => {
    armedWindows.add(fire);
    return {
      cancel: (): void => {
        armedWindows.delete(fire);
      },
    };
  };
  const coalescer = new SiteFailureCoalescer({
    schedule,
    onDigest: (entry: FailureDigestData): void => {
      notifier.emit('failure.digest', entry);
    },
  });
  const tally = new SweepAccumulator();
  const scheduler = new FavoriteScheduler({
    list: (): readonly { mangaKey: string }[] =>
      engine.listFavorites().map((row): { mangaKey: string } => ({ mangaKey: row.mangaKey })),
    check: async (favorite): Promise<void> => {
      const result = await engine.checkFavorite(favorite.mangaKey);
      tally.recordCheck(result, clock.now());
    },
    onError: (favorite, error): void => {
      tally.recordFailure(clock.now());
      const row = engine.listFavorites().find((r): boolean => r.mangaKey === favorite.mangaKey);
      if (row !== undefined) {
        coalescer.record(row.moduleId, favorite.mangaKey, error, clock.now());
      }
    },
    onSweepIdle: (): void => {
      const digest = tally.take();
      if (digest !== null) {
        notifier.emit('favorites.digest', digest);
      }
    },
    clock,
    intervalMs: 60 * 60_000,
    jitterMs: 0,
  });
  return { clock, scheduler, post, armedWindows, engine };
}

describe('pipe webhook wiring (scheduler → digests → notifier)', (): void => {
  it('dead site with 12 favorites: ONE failure.digest per window + ONE favorites.digest per sweep', async (): Promise<void> => {
    const pipe = openPipe(
      { url: 'http://receiver.example/hook', secret: 's3cret', events: { chapterDownloaded: true, favoritesDigest: true, failureDigest: true } },
      { dead: 12, live: 2 },
    );
    pipe.scheduler.start();
    await settle(10);

    // Sweep 1 done: exactly ONE favorites.digest — never per-check.
    const digests = pipe.post.events('favorites.digest');
    expect(digests.length).toBe(1);
    expect(digests[0]!.data).toMatchObject({ favoritesChecked: 2, checkFailures: 12, newChaptersFound: 2, downloadsQueued: 2 });
    // The failure window is still OPEN mid-window — no failure.digest yet.
    expect(pipe.post.events('failure.digest').length).toBe(0);

    // Window closes: exactly ONE failure.digest for the dead site —
    // 12 coalesced failures, never 12 deliveries.
    for (const fire of [...pipe.armedWindows]) {
      fire();
    }
    await settle(4);
    const failures = pipe.post.events('failure.digest');
    expect(failures.length).toBe(1);
    expect(failures[0]!.data).toMatchObject({ moduleId: DEAD_MODULE, failureCount: 12, affectedFavoritesCount: 12 });

    // Sweep 2 (interval passes): the NEXT favorites.digest.
    await pipe.clock.advance(60 * 60_000);
    await settle(10);
    expect(pipe.post.events('favorites.digest').length).toBe(2);
    // The dead site's SECOND window opens; still coalescing.
    expect(pipe.post.events('failure.digest').length).toBe(1);
  });

  it('muted digest classes deliver nothing; unmuted ones still do', async (): Promise<void> => {
    const pipe = openPipe(
      { url: 'http://receiver.example/hook', secret: '', events: { chapterDownloaded: true, favoritesDigest: false, failureDigest: false } },
      { dead: 3, live: 1 },
    );
    pipe.scheduler.start();
    await settle(10);
    for (const fire of [...pipe.armedWindows]) {
      fire();
    }
    await settle(4);
    expect(pipe.post.attempts.length).toBe(0);
  });

  it('webhook off (url "") — the whole pipe is silent', async (): Promise<void> => {
    const pipe = openPipe(
      { url: '', secret: '', events: { chapterDownloaded: true, favoritesDigest: true, failureDigest: true } },
      { dead: 2, live: 1 },
    );
    pipe.scheduler.start();
    await settle(10);
    for (const fire of [...pipe.armedWindows]) {
      fire();
    }
    await settle(4);
    expect(pipe.post.attempts.length).toBe(0);
  });
});
