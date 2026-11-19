// @vitest-environment node
/**
 * [pipe-health] Per-host token-bucket pacing tests (DESIGN-NORTHSTAR
 * §2 PIPE: "per-host pacing spreads checks and downloads per origin —
 * no synchronized fan-outs") under a deterministic FakeClock — no
 * wall-clock sleeps:
 *
 *   1. N requests on ONE host complete ≥ intervalMs apart (the
 *      acceptance pin: "N favorites on one host … are paced (test pins
 *      inter-request spacing; no burst)");
 *   2. DIFFERENT hosts proceed in parallel (no cross-host coupling);
 *   3. modules sharing a RootURL HOST share one bucket (scheme and
 *      path are irrelevant — the origin is the key);
 *   4. unknown modules / unparseable RootURLs are never gated;
 *   5. FIFO fairness: queued waiters are served strictly in arrival
 *      order (an early waiter can never be overtaken);
 *   6. the favorites SCHEDULER SWEEP over the REAL engine is paced per
 *      host while a different host's check proceeds in parallel.
 */
import { describe, expect, it } from 'vitest';
import {
  ModuleHostPacer,
  DEFAULT_PACING_CAPACITY,
  DEFAULT_PACING_INTERVAL_MS,
  type HostPacingClock,
} from '../../src/jobs/host-pacing.js';
import { FavoriteScheduler, type FavoriteClock } from '../../src/jobs/favorites/scheduler.js';
import { FavoritesEngine } from '../../src/jobs/favorites/engine.js';
import type { FavoriteRow, LibraryStore } from '../../src/jobs/library/store.js';
import type { NormalizedInfo } from '../../src/api/services.js';

interface Timer {
  readonly at: number;
  readonly resolve: () => void;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Several macrotask turns (the pump chain spans multiple promise hops). */
async function settle(turns: number = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await flushMicrotasks();
  }
}

/** Deterministic virtual clock (same discipline as scheduler.test.ts). */
class FakeClock implements HostPacingClock, FavoriteClock {
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

  /** Resolve every timer due within `ms`, letting continuations run. */
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

const ROOTS: Record<string, string> = {
  moduleA: 'https://a.example/manga',
  // Same HOST, different scheme + path: the mirror shares the bucket.
  moduleAmirror: 'http://a.example/other',
  moduleB: 'https://b.example/manga',
  broken: 'not a url',
};

function rootUrlOf(moduleId: string): string | undefined {
  return ROOTS[moduleId];
}

describe('ModuleHostPacer (token bucket per RootURL host)', (): void => {
  it('paces N requests on one host ≥ intervalMs apart — no burst', async (): Promise<void> => {
    const clock = new FakeClock();
    const pacer = new ModuleHostPacer({ rootUrlOf, intervalMs: 1_000, clock });
    const times: number[] = [];
    const launches = [1, 2, 3, 4].map(
      (turn) =>
        (async (): Promise<void> => {
          await settle(turn);
          await pacer.acquire('moduleA');
          times.push(clock.now());
        })(),
    );
    await clock.advance(10_000);
    await Promise.all(launches);
    // Bucket starts full (a quiet host answers immediately); every
    // subsequent paced request waits a FULL interval — [0, I, 2I, 3I].
    expect(times).toEqual([0, 1_000, 2_000, 3_000]);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('different hosts proceed in parallel (no cross-host coupling)', async (): Promise<void> => {
    const clock = new FakeClock();
    const pacer = new ModuleHostPacer({ rootUrlOf, intervalMs: 1_000, clock });
    const first = (async (): Promise<number> => {
      await settle(1);
      await pacer.acquire('moduleA');
      return clock.now();
    })();
    const otherHost = (async (): Promise<number> => {
      await settle(2);
      await pacer.acquire('moduleB');
      return clock.now();
    })();
    const second = (async (): Promise<number> => {
      await settle(3);
      await pacer.acquire('moduleA');
      return clock.now();
    })();
    await clock.advance(5_000);
    // B is NEVER blocked by A's busy bucket; A's own second request is.
    expect(await otherHost).toBe(0);
    expect(await first).toBe(0);
    expect(await second).toBe(1_000);
  });

  it('modules sharing a RootURL host share one bucket (origin-keyed)', async (): Promise<void> => {
    const clock = new FakeClock();
    const pacer = new ModuleHostPacer({ rootUrlOf, intervalMs: 500, clock });
    const times: number[] = [];
    const a = (async (): Promise<void> => {
      await settle(1);
      await pacer.acquire('moduleA');
      times.push(clock.now());
    })();
    const mirror = (async (): Promise<void> => {
      await settle(2);
      await pacer.acquire('moduleAmirror');
      times.push(clock.now());
    })();
    await clock.advance(2_000);
    await Promise.all([a, mirror]);
    expect(times).toEqual([0, 500]);
  });

  it('unknown modules and unparseable RootURLs are never gated', async (): Promise<void> => {
    const clock = new FakeClock();
    const pacer = new ModuleHostPacer({ rootUrlOf, intervalMs: 60_000, clock });
    // A busy bucket is draining…
    const paced = pacer.acquire('moduleA');
    // …yet an unknown module and a broken RootURL answer immediately.
    await expect(pacer.acquire('no-such-module')).resolves.toBeUndefined();
    await expect(pacer.acquire('broken')).resolves.toBeUndefined();
    await clock.advance(60_000);
    await paced;
    expect(pacer.stats().map((s): string => s.host)).toEqual(['a.example']);
  });

  it('serves queued waiters strictly in arrival order (FIFO)', async (): Promise<void> => {
    const clock = new FakeClock();
    const pacer = new ModuleHostPacer({ rootUrlOf, intervalMs: 100, clock });
    const order: string[] = [];
    const launches = ['first', 'second', 'third'].map(
      (label, index) =>
        (async (): Promise<void> => {
          await settle(index + 1);
          await pacer.acquire('moduleA');
          order.push(label);
        })(),
    );
    await clock.advance(1_000);
    await Promise.all(launches);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('exports the conservative v1 defaults (capacity 1, 3 s interval)', (): void => {
    expect(DEFAULT_PACING_CAPACITY).toBe(1);
    expect(DEFAULT_PACING_INTERVAL_MS).toBe(3_000);
  });
});

// ── scheduler-sweep integration (acceptance pin over the REAL engine) ──

/** In-memory favorites store (the engine's Pick over LibraryStore). */
class MapStore implements Pick<
  LibraryStore,
  | 'getFavorite'
  | 'listFavorites'
  | 'upsertFavorite'
  | 'setDownloadedChapters'
  | 'getFavoriteDownloadedList'
  | 'deleteFavorite'
> {
  private readonly rows = new Map<string, FavoriteRow>();

  getFavorite(key: string): FavoriteRow | undefined {
    return this.rows.get(key);
  }

  listFavorites(): FavoriteRow[] {
    return [...this.rows.values()];
  }

  upsertFavorite(row: FavoriteRow): void {
    this.rows.set(row.mangaKey, row);
  }

  setDownloadedChapters(): void {
    throw new Error('unexpected setDownloadedChapters in the pacing sweep test');
  }

  getFavoriteDownloadedList(): string {
    throw new Error('unexpected getFavoriteDownloadedList in the pacing sweep test');
  }

  deleteFavorite(key: string): void {
    this.rows.delete(key);
  }
}

/** GetInfo recorder: one entry per live fetch, key = moduleId. */
class RecordingInfo {
  readonly fetches: Array<{ moduleId: string; at: number }> = [];

  constructor(
    private readonly clock: { now(): number },
    private readonly liveFor: (moduleId: string) => string[],
  ) {}

  async getInfo(moduleId: string, url: string): Promise<NormalizedInfo> {
    const links = this.liveFor(moduleId);
    this.fetches.push({ moduleId, at: this.clock.now() });
    return {
      title: `Manga ${moduleId}`,
      altTitles: '',
      authors: '',
      artists: '',
      genres: '',
      status: 'Ongoing',
      summary: '',
      coverLink: '',
      url,
      link: url,
      chapterLinks: links,
      chapterNames: links.map((_, i) => `Ch. ${i + 1}`),
      numChapter: links.length,
    };
  }
}

function sweepFavorite(moduleId: string, url: string): FavoriteRow {
  return {
    mangaKey: `${moduleId}${url}`.toLowerCase(),
    moduleId,
    url,
    title: `Manga ${moduleId}`,
    autoDownload: false,
    newChapterCount: 0,
    downloadedChapterList: '',
  };
}

describe('favorites scheduler sweep is paced per host (acceptance)', (): void => {
  it('N favorites on one host are spaced; a different host proceeds in parallel', async (): Promise<void> => {
    const clock = new FakeClock();
    const store = new MapStore();
    const stored: FavoriteRow[] = [
      sweepFavorite('moduleA', 'https://a.example/manga/one'),
      sweepFavorite('moduleA', 'https://a.example/manga/two'),
      sweepFavorite('moduleA', 'https://a.example/manga/three'),
      sweepFavorite('moduleB', 'https://b.example/manga/solo'),
    ];
    for (const row of stored) {
      store.upsertFavorite(row);
    }
    const info = new RecordingInfo(clock, (): string[] => []);
    const engine = new FavoritesEngine({
      store,
      info,
      downloads: {
        createDownload: (): { jobId: string } => {
          throw new Error('no downloads in the pacing sweep test');
        },
      },
      // THE seam under test: the shared per-host pacer.
      pacer: new ModuleHostPacer({ rootUrlOf, intervalMs: 500, clock }),
    });
    const scheduler = new FavoriteScheduler({
      // maxConcurrent 4: WITHOUT pacing all four checks would hit the
      // modules simultaneously — pacing is the only spreader here.
      maxConcurrent: 4,
      intervalMs: 24 * 60 * 60 * 1_000, // each favorite checks once
      jitterMs: 0,
      clock,
      list: (): readonly { mangaKey: string }[] =>
        store.listFavorites().map((row): { mangaKey: string } => ({ mangaKey: row.mangaKey })),
      check: async (favorite): Promise<void> => {
        await engine.checkFavorite(favorite.mangaKey);
      },
    });
    scheduler.start();
    await clock.advance(5_000);
    await scheduler.drain();

    const aFetches = info.fetches
      .filter((fetch): boolean => fetch.moduleId === 'moduleA')
      .map((fetch): number => fetch.at)
      .sort((x, y): number => x - y);
    expect(aFetches).toEqual([0, 500, 1_000]);
    for (let i = 1; i < aFetches.length; i += 1) {
      expect(aFetches[i]! - aFetches[i - 1]!).toBeGreaterThanOrEqual(500);
    }
    // The OTHER host's check was never blocked by host A's busy bucket.
    expect(info.fetches.filter((fetch): boolean => fetch.moduleId === 'moduleB').map((f): number => f.at)).toEqual([0]);
  });
});
