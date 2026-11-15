/**
 * Favorites scheduler (DESIGN §7.2 item 5) — the `OptionMaxFavoriteThreads`
 * / `OptionAutoCheckFavIntervalMinutes` analogs (FMDOptions.pas:130,
 * :153-154; uFavoritesManager.pas:717, :737): favorites are checked on a
 * per-favorite interval with AT MOST `maxConcurrent` checks in flight
 * (FMD2 default: 1 thread), each dispatch delayed by a jitter term so
 * sweeps spread out, and a slow favorite's check blocks ONLY its own
 * slot — the dispatch loop runs again after every completion, so the
 * remaining slots keep serving the other due favorites (no head-of-line
 * starvation).
 *
 * Fully deterministic under an injected {@link FavoriteClock} (the same
 * `now()/delay()` shape as the §6.1 `SyncClock`): unit tests drive
 * virtual time with a `FakeClock` and prove the concurrency bound, the
 * interval+jitter scheduling and the no-starvation property without any
 * wall-clock sleeps.
 */

/** Time source + delay primitive the scheduler runs on. */
export interface FavoriteClock {
  /** Current time in ms (arbitrary epoch). */
  now(): number;
  /** Resolve after `ms` of clock time (cancellation is by flag). */
  delay(ms: number): Promise<void>;
}

/** Wall-clock implementation (production). */
export const systemFavoriteClock: FavoriteClock = {
  now(): number {
    return Date.now();
  },
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

/** The scheduler's view of one favorite (identity + cadence). */
export interface SchedulerFavorite {
  /** `LowerCase(ModuleID+Link)` — the stable identity. */
  readonly mangaKey: string;
  /** Per-favorite override of the scheduler default interval. */
  readonly intervalMs?: number;
}

export interface FavoriteSchedulerOptions {
  /** Max checks in flight (`OptionMaxFavoriteThreads`; FMD2 default 1). */
  readonly maxConcurrent?: number;
  /** Default per-favorite interval (`OptionAutoCheckFavIntervalMinutes`). */
  readonly intervalMs?: number;
  /** Random extra delay added to every computed interval (>= 0). */
  readonly jitterMs?: number;
  /** Jitter source in [0,1) — inject a deterministic one in tests. */
  readonly jitter?: () => number;
  readonly clock?: FavoriteClock;
  /** Failure sink — a failed check must never break the loop. */
  readonly onError?: (favorite: SchedulerFavorite, error: unknown) => void;
}

export interface SchedulerStats {
  /** Manga keys with a check in flight right now. */
  readonly running: readonly string[];
  /** Keys past their due time, waiting for a free slot. */
  readonly pending: readonly string[];
  /** Next wake time among idle favorites (undefined = nothing armed). */
  readonly nextWakeAt: number | undefined;
}

/** FMD2 defaults (FMDOptions.pas:130, :153-154). */
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_JITTER_MS = 30_000;

export class FavoriteScheduler {
  private readonly clock: FavoriteClock;
  private readonly maxConcurrent: number;
  private readonly defaultIntervalMs: number;
  private readonly jitterMs: number;
  private readonly jitter: () => number;
  private readonly onError: (favorite: SchedulerFavorite, error: unknown) => void;

  private readonly nextDue = new Map<string, number>();
  private readonly running = new Set<string>();
  private stopped = true;
  /** Set while a dispatch is walking the queue (re-entrancy guard). */
  private dispatching = false;
  /** The wake time the pending delay timer targets (dedupe). */
  private armedAt: number | undefined;
  private drained: (() => void) | undefined;

  public constructor(
    private readonly deps: {
      readonly list: () => readonly SchedulerFavorite[];
      readonly check: (favorite: SchedulerFavorite) => Promise<void>;
    } & FavoriteSchedulerOptions,
  ) {
    this.clock = deps.clock ?? systemFavoriteClock;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.defaultIntervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.jitterMs = Math.max(0, deps.jitterMs ?? DEFAULT_JITTER_MS);
    this.jitter = deps.jitter ?? Math.random;
    this.onError = deps.onError ?? ((): void => {});
  }

  /**
   * Start the loop: every favorite is due immediately (FMD2 checks all
   * favorites when the timer enables), bounded by the slot count. The
   * first dispatch runs synchronously; the wake timer arms for the
   * following due points.
   */
  public start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    const now = this.clock.now();
    for (const favorite of this.deps.list()) {
      if (!this.nextDue.has(favorite.mangaKey) && this.intervalFor(favorite) > 0) {
        this.nextDue.set(favorite.mangaKey, now);
      }
    }
    this.dispatch();
  }

  /** Stop accepting favorites; in-flight checks settle via {@link drain}. */
  public stop(): void {
    this.stopped = true;
  }

  /** Resolve once every in-flight check has settled (no new claims). */
  public async drain(): Promise<void> {
    if (this.running.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.drained = resolve;
    });
    this.drained = undefined;
  }

  /**
   * Dispatch pass: claim every due favorite while free slots remain,
   * then re-arm the wake timer. Public so tests (and `fire`) can drive
   * dispatches manually at a fixed clock time.
   */
  public dispatch(): void {
    if (this.stopped || this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      const now = this.clock.now();
      this.rescan(now);
      const due = [...this.nextDue.entries()]
        .filter(([key, at]) => at <= now && !this.running.has(key))
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
      for (const [key] of due) {
        if (this.running.size >= this.maxConcurrent) {
          break;
        }
        this.claim(key, now);
      }
    } finally {
      this.dispatching = false;
    }
    void this.arm();
  }

  /** Scheduling snapshot (test/observability seam). */
  public stats(): SchedulerStats {
    const now = this.clock.now();
    const pending = [...this.nextDue.entries()]
      .filter(([key, at]) => at <= now && !this.running.has(key))
      .map(([key]) => key)
      .sort();
    const idle = [...this.nextDue.entries()]
      .filter(([key]) => !this.running.has(key))
      .map(([, at]) => at);
    return {
      running: [...this.running].sort(),
      pending,
      nextWakeAt: idle.length > 0 ? Math.min(...idle) : undefined,
    };
  }

  /** Interval for one favorite: override > scheduler default (<= 0 = never auto). */
  private intervalFor(favorite: SchedulerFavorite): number {
    return favorite.intervalMs ?? this.defaultIntervalMs;
  }

  /** interval + jitter — the next check lands in `[I, I+J)` after this one. */
  private nextDelayMs(favorite: SchedulerFavorite): number {
    const base = this.intervalFor(favorite);
    if (base <= 0) {
      return base;
    }
    return base + (this.jitterMs > 0 ? Math.floor(this.jitter() * this.jitterMs) : 0);
  }

  /** Add new favorites (due now, when their interval allows auto-checks);
   * drop deleted ones (unless running). Interval <= 0 favorites are
   * check-now only — the scheduler must NEVER schedule them, or the
   * rescan loop would re-add and re-check them forever. */
  private rescan(now: number): void {
    const live = new Set(this.deps.list().map((f) => f.mangaKey));
    for (const key of [...this.nextDue.keys()]) {
      if (!live.has(key) && !this.running.has(key)) {
        this.nextDue.delete(key);
      }
    }
    for (const favorite of this.deps.list()) {
      if (!this.nextDue.has(favorite.mangaKey) && this.intervalFor(favorite) > 0) {
        this.nextDue.set(favorite.mangaKey, now);
      }
    }
  }

  /** Claim one slot and run the check; completion re-dispatches. */
  private claim(key: string, startedAt: number): void {
    const favorite = this.deps.list().find((f) => f.mangaKey === key);
    if (favorite === undefined) {
      this.nextDue.delete(key);
      return;
    }
    this.running.add(key);
    void this.deps
      .check(favorite)
      .catch((error: unknown): void => {
        this.onError(favorite, error);
      })
      .then((): void => {
        this.running.delete(key);
        // Next due = completion time + interval + jitter (:376 parity —
        // the check stamps lastCheck, the cadence counts from it).
        const delayMs = this.nextDelayMs(favorite);
        if (delayMs > 0) {
          this.nextDue.set(key, this.clock.now() + delayMs);
        } else {
          this.nextDue.delete(key);
        }
        const resolveDrain = this.drained;
        if (this.running.size === 0 && resolveDrain !== undefined) {
          resolveDrain();
        }
        this.dispatch();
      });
    void startedAt;
  }

  /**
   * Arm the wake timer for the earliest due idle favorite. When the
   * earliest idle favorite is ALREADY due the slots are necessarily
   * full (dispatch just claimed everything it could) — the completion
   * continuation re-dispatches, so no timer is armed (this is what
   * keeps a full scheduler from busy-looping on delay(0) fires).
   */
  private async arm(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const now = this.clock.now();
    const idle = [...this.nextDue.entries()]
      .filter(([key]) => !this.running.has(key))
      .map(([, at]) => at);
    if (idle.length === 0) {
      return;
    }
    const wake = Math.min(...idle);
    if (wake <= now) {
      return;
    }
    if (this.armedAt === wake) {
      return;
    }
    this.armedAt = wake;
    await this.clock.delay(wake - now);
    this.armedAt = undefined;
    if (this.stopped) {
      return;
    }
    this.dispatch();
  }
}
