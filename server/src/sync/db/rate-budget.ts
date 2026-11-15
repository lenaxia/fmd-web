/**
 * Token-bucket rate budget for catalog blob fetches (DESIGN.md §6.1):
 * 10 requests/s sustained, burst 50. The bucket is fully deterministic
 * under an injected {@link SyncClock} — unit tests drive virtual time
 * and prove refill pacing, burst capacity and FIFO gate order without
 * wall-clock sleeps.
 */

/** Time source + delay primitive the bucket runs on. Production uses
 * {@link systemClock}; tests inject a {@link FakeClock}. */
export interface SyncClock {
  /** Current time in ms (arbitrary epoch). */
  now(): number;
  /** Resolve after `ms` of clock time. Virtual clocks advance this via
   * their `advance` control; the system clock uses a timer. */
  delay(ms: number): Promise<void>;
}

/** Wall-clock implementation. */
export const systemClock: SyncClock = {
  now(): number {
    return Date.now();
  },
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
}

interface Timer {
  /** Absolute deadline (ms). */
  readonly at: number;
  readonly resolve: () => void;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Deterministic virtual clock: time moves only inside {@link advance},
 * which resolves pending {@link delay} timers in deadline order (FIFO
 * on ties) and lets their continuations run before continuing — so
 * `advance(5000)` completes every acquire whose waits fit into 5 s of
 * virtual time.
 */
export class FakeClock implements SyncClock {
  private t: number = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const at: number = this.t + ms;
      // Sorted insert: deadline order, ties FIFO.
      let i: number = 0;
      while (i < this.timers.length && this.timers[i]!.at <= at) {
        i += 1;
      }
      this.timers.splice(i, 0, { at, resolve });
    });
  }

  /** Move time forward by `ms`, resolving every timer that comes due
   * (including ones scheduled by resolved timers' continuations). */
  async advance(ms: number): Promise<void> {
    const target: number = this.t + ms;
    // First let pending continuations (acquire chains) run so timers
    // registered by them use the CURRENT time, not the advanced one.
    await flushMicrotasks();
    for (;;) {
      const next: Timer | undefined = this.timers[0];
      if (next === undefined || next.at > target) {
        break;
      }
      this.t = next.at;
      this.timers.shift();
      next.resolve();
      // Let the timer's continuation run to completion before picking
      // the next deadline (it may schedule a new delay).
      await flushMicrotasks();
    }
    this.t = Math.max(this.t, target);
  }

  /** Run pending continuations without moving time (test helper). */
  async drain(): Promise<void> {
    await flushMicrotasks();
  }
}

/**
 * Refillable token bucket: tokens accrue continuously at
 * `refillPerSecond` up to `capacity`; {@link acquire} resolves once
 * `cost` tokens are (or become) available and deducts them atomically.
 * Concurrent acquires are served strictly FIFO.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(
    public readonly capacity: number,
    public readonly refillPerSecond: number,
    private readonly clock: SyncClock,
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new Error('TokenBucket requires capacity > 0 and refillPerSecond > 0');
    }
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /** Tokens available right now (after lazy refill) — test observability. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Take `cost` tokens without waiting; false when the budget is spent. */
  tryTake(cost: number = 1): boolean {
    if (cost > this.capacity) {
      throw new Error(`cost ${cost} exceeds bucket capacity ${this.capacity}`);
    }
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Take `cost` tokens, waiting (via the clock) until they accrue.
   * Concurrent acquires cross the gate strictly in call order. */
  acquire(cost: number = 1): Promise<void> {
    const run: Promise<void> = this.queueTail.then(() => this.takeWhenAvailable(cost));
    // Keep the FIFO chain alive when an acquire rejects (invalid cost).
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async takeWhenAvailable(cost: number): Promise<void> {
    if (cost > this.capacity) {
      throw new Error(`cost ${cost} exceeds bucket capacity ${this.capacity}`);
    }
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      // Continuous refill: time until `cost - tokens` tokens accrue.
      const needed: number = cost - this.tokens;
      const waitMs: number = Math.max(1, Math.ceil((needed * 1000) / this.refillPerSecond));
      await this.clock.delay(waitMs);
    }
  }

  /** Lazy continuous refill since the last take/check. */
  private refill(): void {
    const now: number = this.clock.now();
    const elapsed: number = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillPerSecond) / 1000);
      this.lastRefill = now;
    }
  }
}

/** §6.1 budget constants: 10 requests/s, burst 50. */
export const CATALOG_RATE_BUDGET = {
  requestsPerSecond: 10,
  burst: 50,
} as const;
