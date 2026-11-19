// @vitest-environment node
/**
 * Favorites scheduler tests (DESIGN §7.2 item 5) — bounded concurrency
 * (`OptionMaxFavoriteThreads` analog), per-favorite interval
 * (`OptionAutoCheckFavIntervalMinutes` analog) + jitter, under a
 * deterministic FakeClock: time moves only inside `advance`, so every
 * claim/wake decision is observable without wall-clock sleeps.
 *
 * Pinned properties:
 *   - at most `maxConcurrent` checks in flight, ever;
 *   - freed slots immediately serve the next due favorite — a slow
 *     favorite blocks only ITS slot (no head-of-line starvation);
 *   - the next due time lands in `[interval, interval + jitter)` after
 *     the completion time (deterministic jitter source);
 *   - a failing check feeds `onError` and never breaks the loop;
 *   - favorites created after `start()` are picked up (rescan).
 */
import { describe, expect, it } from 'vitest';
import {
  FavoriteScheduler,
  DEFAULT_INTERVAL_MS,
  DEFAULT_JITTER_MS,
  DEFAULT_MAX_CONCURRENT,
  type FavoriteClock,
  type SchedulerFavorite,
} from '../../../src/jobs/favorites/scheduler.js';

interface Timer {
  readonly at: number;
  readonly resolve: () => void;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Several macrotask turns — the scheduler chain (timer wake → dispatch →
 * claim → completion → re-dispatch → re-arm) spans multiple promise hops,
 * each needing a turn to settle before the clock's bookkeeping runs. */
async function settle(turns: number = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await flushMicrotasks();
  }
}

/** Deterministic virtual clock — same discipline as the §6.1 SyncClock. */
class FakeClock implements FavoriteClock {
  private t = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const at = this.t + ms;
      let i = 0;
      while (i < this.timers.length && this.timers[i]!.at <= at) {
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
    await settle();
  }
}

/** Manual-gate check: each favorite's check resolves via `release(key)`. */
class GatedChecks {
  readonly started: string[] = [];
  readonly gates = new Map<string, () => void>();
  readonly errors: Array<{ favorite: SchedulerFavorite; error: unknown }> = [];

  run(favorite: SchedulerFavorite): Promise<void> {
    this.started.push(favorite.mangaKey);
    return new Promise((resolve) => {
      this.gates.set(favorite.mangaKey, resolve);
    });
  }

  release(key: string): void {
    this.gates.get(key)?.();
    this.gates.delete(key);
  }
}

function favorites(...keys: string[]): SchedulerFavorite[] {
  return keys.map((mangaKey) => ({ mangaKey }));
}

describe('FavoriteScheduler — bounded concurrency under a fake clock', (): void => {
  it('starts at most maxConcurrent checks among due favorites (FMD2 default 1)', async (): Promise<void> => {
    const clock = new FakeClock();
    const checks = new GatedChecks();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a', 'b', 'c'),
      check: (favorite): Promise<void> => checks.run(favorite),
      clock,
      maxConcurrent: 2,
      intervalMs: 60_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();

    // due order ties break by key: 'a' and 'b' claim, 'c' waits
    expect(checks.started.sort()).toEqual(['a', 'b']);
    expect([...scheduler.stats().running].sort()).toEqual(['a', 'b']);
    expect(scheduler.stats().pending).toEqual(['c']);
    expect(DEFAULT_MAX_CONCURRENT).toBe(1);
    scheduler.stop();
  });

  it('a freed slot immediately serves the next due favorite (a slow favorite does not starve others)', async (): Promise<void> => {
    const clock = new FakeClock();
    const checks = new GatedChecks();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('slow', 'b', 'c', 'd'),
      check: (favorite): Promise<void> => checks.run(favorite),
      clock,
      maxConcurrent: 2,
      intervalMs: 60_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    // due order ties break by key: 'b' and 'c' claim ('slow'/'d' wait)
    expect(checks.started.sort()).toEqual(['b', 'c']);

    // 'slow' never resolves; completing 'b' frees a slot → 'd' starts
    // (key order), then completing 'c' frees the last slot for 'slow' —
    // the slow favorite starves nobody.
    checks.release('b');
    await settle();
    expect(checks.started.sort()).toEqual(['b', 'c', 'd']);
    checks.release('c');
    await settle();
    expect(checks.started.sort()).toEqual(['b', 'c', 'd', 'slow']);
    expect([...scheduler.stats().running].sort()).toEqual(['d', 'slow']);
    scheduler.stop();
    checks.release('slow');
    checks.release('d');
  });

  it('reschedules into [interval, interval + jitter) after completion (deterministic jitter)', async (): Promise<void> => {
    const clock = new FakeClock();
    const ran: string[] = [];
    let nextJitter = 0.5;
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a'),
      check: async (favorite): Promise<void> => {
        ran.push(favorite.mangaKey);
      },
      clock,
      maxConcurrent: 1,
      intervalMs: 100_000,
      jitterMs: 1_000,
      jitter: (): number => nextJitter,
    });
    scheduler.start();
    await settle();
    expect(ran).toEqual(['a']);

    // completion at t≈0 → next due ≈ 100_000 + floor(0.5*1000) = 100_500
    expect(scheduler.stats().nextWakeAt).toBe(100_500);
    // waking just BEFORE the due point does nothing
    await clock.advance(100_499);
    expect(ran).toEqual(['a']);
    // waking past it reruns; run #2 completes at t=100_500
    await clock.advance(2);
    expect(ran).toEqual(['a', 'a']);
    // next due = completion(100_500) + interval + jitter = 201_000 —
    // short of it nothing reruns
    await clock.advance(99_000);
    expect(ran).toEqual(['a', 'a']);
    expect(scheduler.stats().nextWakeAt).toBe(201_000);

    // jitter 0.0 → the next due lands EXACTLY interval after the wake
    nextJitter = 0;
    await clock.advance(2_000);
    expect(ran).toEqual(['a', 'a', 'a']);
    expect(scheduler.stats().nextWakeAt).toBe(301_000);
    expect(DEFAULT_INTERVAL_MS).toBe(60 * 60 * 1_000);
    expect(DEFAULT_JITTER_MS).toBeGreaterThan(0);
    scheduler.stop();
  });

  it('per-favorite interval overrides the scheduler default; interval <= 0 never auto-reruns', async (): Promise<void> => {
    const clock = new FakeClock();
    const ran: string[] = [];
    const rows: SchedulerFavorite[] = [
      { mangaKey: 'fast', intervalMs: 10_000 },
      { mangaKey: 'manual', intervalMs: 0 },
    ];
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => rows,
      check: async (favorite): Promise<void> => {
        ran.push(favorite.mangaKey);
      },
      clock,
      intervalMs: 999_999,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    // interval <= 0 favorites are check-now only: 'manual' is never
    // auto-scheduled, 'fast' runs immediately
    expect(ran).toEqual(['fast']);

    await clock.advance(10_000);
    expect(ran.filter((k) => k === 'fast').length).toBe(2);
    // 'manual' stays out of the schedule entirely; nothing is running
    expect(scheduler.stats().running).toEqual([]);
    expect(ran.filter((k) => k === 'manual').length).toBe(0);
    scheduler.stop();
  });

  it('a failing check feeds onError and the loop continues', async (): Promise<void> => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const ran: string[] = [];
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a', 'b'),
      check: async (favorite): Promise<void> => {
        if (favorite.mangaKey === 'a') {
          throw new Error('boom');
        }
        ran.push(favorite.mangaKey);
      },
      onError: (_favorite, error): void => {
        errors.push(error);
      },
      clock,
      maxConcurrent: 1,
      intervalMs: 50_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    expect(errors).toEqual([new Error('boom')]);
    expect(ran).toEqual(['b']);
    // 'a' is scheduled again for its next interval
    expect(scheduler.stats().nextWakeAt).toBe(50_000);
    scheduler.stop();
  });

  it('favorites created after start() are picked up by the rescan', async (): Promise<void> => {
    const clock = new FakeClock();
    const checks = new GatedChecks();
    const rows: SchedulerFavorite[] = favorites('a');
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => rows,
      check: (favorite): Promise<void> => checks.run(favorite),
      clock,
      maxConcurrent: 1,
      intervalMs: 60_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    expect(checks.started).toEqual(['a']);

    rows.push({ mangaKey: 'new' });
    checks.release('a');
    await settle();
    expect(checks.started).toEqual(['a', 'new']);
    scheduler.stop();
    checks.release('new');
  });

  it('drain() resolves when the last in-flight check settles', async (): Promise<void> => {
    const clock = new FakeClock();
    const checks = new GatedChecks();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a', 'b'),
      check: (favorite): Promise<void> => checks.run(favorite),
      clock,
      maxConcurrent: 2,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    expect(scheduler.stats().running).toHaveLength(2);

    let drained = false;
    void scheduler.drain().then((): void => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    checks.release('a');
    await settle();
    expect(drained).toBe(false);
    checks.release('b');
    await settle();
    expect(drained).toBe(true);
    scheduler.stop();
  });
});

describe('FavoriteScheduler.setDefaultIntervalMs — runtime interval (Settings → Updates parity)', (): void => {
  it('a shorter interval re-arms idle favorites due-now and they are checked immediately', async (): Promise<void> => {
    const clock = new FakeClock();
    const checks = new GatedChecks();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a'),
      check: (favorite): Promise<void> => checks.run(favorite),
      clock,
      maxConcurrent: 1,
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    expect(checks.started).toEqual(['a']);
    checks.release('a');
    await settle();
    // next due = +3_600_000 — nothing fires before that.
    await clock.advance(60_000);
    expect(checks.started).toEqual(['a']);

    scheduler.setDefaultIntervalMs(1_000);
    expect(scheduler.defaultIntervalMs()).toBe(1_000);
    await settle();
    // 'a' re-armed due-now under the new cadence → claimed again.
    expect(checks.started).toEqual(['a', 'a']);
    checks.release('a');
    await settle();
    scheduler.stop();
  });

  it('interval 0 (scheduled checks off) clears every pending wake — no future check fires', async (): Promise<void> => {
    const clock = new FakeClock();
    const checks = new GatedChecks();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a'),
      check: (favorite): Promise<void> => checks.run(favorite),
      clock,
      maxConcurrent: 1,
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    expect(checks.started).toEqual(['a']);
    checks.release('a');
    await settle();
    // 'a' re-armed at +3_600_000 — flipping the interval off mid-flight
    // must clear that wake, not just future completions.
    scheduler.setDefaultIntervalMs(0);
    expect(scheduler.defaultIntervalMs()).toBe(0);
    expect(scheduler.stats().nextWakeAt).toBeUndefined();
    await clock.advance(100_000_000);
    expect(checks.started).toEqual(['a']);
    scheduler.stop();
  });
});

describe('FavoriteScheduler — onSweepIdle (the favorites.digest boundary)', (): void => {
  /** Immediate checks (no gates): every claimed check settles at once. */
  function immediateScheduler(
    opts: { keys: string[]; onSweepIdle: () => void },
  ): { scheduler: FavoriteScheduler; clock: FakeClock } {
    const clock = new FakeClock();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites(...opts.keys),
      check: (): Promise<void> => Promise.resolve(),
      onSweepIdle: opts.onSweepIdle,
      clock,
      maxConcurrent: 1,
      intervalMs: 60 * 60_000,
      jitterMs: 0,
    });
    return { scheduler, clock };
  }

  it('ONE sweep of many back-to-back checks fires onSweepIdle exactly once', async (): Promise<void> => {
    let sweeps = 0;
    const { scheduler, clock } = immediateScheduler({
      keys: ['a', 'b', 'c', 'd', 'e'],
      onSweepIdle: (): void => {
        sweeps += 1;
      },
    });
    scheduler.start();
    await settle();
    expect(sweeps).toBe(1);
    // Nothing further until the next interval — still one sweep.
    await clock.advance(30 * 60_000);
    expect(sweeps).toBe(1);
    scheduler.stop();
  });

  it('the next interval is a NEW sweep (a second firing)', async (): Promise<void> => {
    let sweeps = 0;
    const { scheduler, clock } = immediateScheduler({
      keys: ['a', 'b'],
      onSweepIdle: (): void => {
        sweeps += 1;
      },
    });
    scheduler.start();
    await settle();
    expect(sweeps).toBe(1);
    await clock.advance(60 * 60_000);
    await settle();
    expect(sweeps).toBe(2);
    scheduler.stop();
  });

  it('a zero-favorite scheduler never fires (nothing due, nothing ran)', async (): Promise<void> => {
    let sweeps = 0;
    const { scheduler, clock } = immediateScheduler({
      keys: [],
      onSweepIdle: (): void => {
        sweeps += 1;
      },
    });
    scheduler.start();
    await clock.advance(120 * 60_000);
    expect(sweeps).toBe(0);
    scheduler.stop();
  });

  it('a throwing onSweepIdle consumer never breaks the loop', async (): Promise<void> => {
    const started: string[] = [];
    const clock = new FakeClock();
    const scheduler = new FavoriteScheduler({
      list: (): SchedulerFavorite[] => favorites('a', 'b'),
      check: (favorite): Promise<void> => {
        started.push(favorite.mangaKey);
        return Promise.resolve();
      },
      onSweepIdle: (): void => {
        throw new Error('digest consumer exploded');
      },
      clock,
      maxConcurrent: 1,
      intervalMs: 60_000,
      jitterMs: 0,
    });
    scheduler.start();
    await settle();
    expect(started.sort()).toEqual(['a', 'b']);
    // And the next sweep still runs — the loop survived the throw.
    await clock.advance(60_000);
    await settle();
    expect(started.length).toBe(4);
    scheduler.stop();
  });
});
