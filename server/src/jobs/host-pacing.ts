/**
 * Per-host token-bucket pacing (DESIGN-NORTHSTAR §2 PIPE: "per-host
 * pacing spreads checks and downloads per origin — no synchronized
 * fan-outs"; §2 TRIAGE: "per-host pacing applies to retries exactly as
 * to fresh work").
 *
 * The favorites scheduler AND the download queue consult ONE shared
 * pacer: concurrent favorites checks / download jobs whose modules
 * resolve to the SAME RootURL host are spaced at least
 * `intervalMs` apart (burst capacity 1 by default — a strict
 * one-request-per-interval cadence that never trips anti-bot rate
 * shaping), while DIFFERENT hosts proceed fully in parallel (one
 * bucket per host, no cross-host coupling).
 *
 * Module → host mapping reuses the cover-proxy RootURL-reading
 * knowledge (`rootHost` in `api/cover-proxy.ts`): lowercase hostname
 * of the module's RootURL, scheme-agnostic, '' when unparseable.
 * Unknown modules and unparseable RootURLs are NOT paced — pacing is
 * politeness toward origins, never a gate on work (§3 "hints never
 * block" posture applied to the limiter itself; a module missing from
 * the registry cannot be allowed to stall the pipe).
 *
 * Conservative fixed defaults, deliberately NO user knobs in v1
 * (charter: no knobs; the seams exist for tests and future settings).
 *
 * Deterministic under an injected clock (the `SyncClock` /
 * `FavoriteClock` shape — `now()`/`delay(ms)`); unit tests pin the
 * inter-request spacing with a FakeClock and no wall-clock sleeps.
 */
import { rootHost } from '../api/cover-proxy.js';

/** Time source + delay primitive the pacer runs on (SyncClock-shaped). */
export interface HostPacingClock {
  /** Current time in ms (arbitrary epoch). */
  now(): number;
  /** Resolve after `ms` of clock time (virtual clocks drive via advance). */
  delay(ms: number): Promise<void>;
}

/** Wall-clock implementation (production). */
export const systemHostPacingClock: HostPacingClock = {
  now(): number {
    return Date.now();
  },
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

/** v1 conservative default: burst capacity 1 (a burst is what trips
 * anti-bot — capacity 1 makes the bucket a strict spacer). */
export const DEFAULT_PACING_CAPACITY = 1;

/** v1 conservative default: one paced request per host per 3 s. */
export const DEFAULT_PACING_INTERVAL_MS = 3_000;

/** The pacing port consumers depend on (favorites engine, download lane). */
export interface HostPacerPort {
  /**
   * Wait until the module's host may issue its next request. Resolves
   * immediately when the module is unknown/unparseable (never gates).
   */
  acquire(moduleId: string): Promise<void>;
}

interface BucketState {
  /** Fractional tokens, refilled continuously at 1/intervalMs (≤ capacity). */
  tokens: number;
  /** Last refill timestamp (ms). */
  lastRefillMs: number;
  /** FIFO waiters (fairness: an early waiter can never be overtaken). */
  queue: Array<() => void>;
  /** Whether a pump loop is draining this bucket (single-flight). */
  pumping: boolean;
}

export interface HostPacerOptions {
  /** module id → RootURL (the registry rows; re-read per acquire). */
  readonly rootUrlOf: (moduleId: string) => string | undefined;
  /** Bucket burst capacity (default 1 — strictly no burst). */
  readonly capacity?: number;
  /** Spacing between successive paced requests on one host. */
  readonly intervalMs?: number;
  readonly clock?: HostPacingClock;
}

/** One host's pacing snapshot (test/observability seam). */
export interface HostPacingStats {
  readonly host: string;
  readonly tokens: number;
  readonly waiting: number;
}

/**
 * Token-bucket per-host pacer. Capacity C + per-token refill interval
 * I: the bucket starts FULL (a cold host answers its first request
 * immediately), every acquire consumes one token and tokens refill
 * continuously at rate 1/I. With the default C=1 the observable is a
 * strict spacer: consecutive paced requests on one host complete ≥ I
 * apart — exactly the "no burst" the north-star demands.
 */
export class ModuleHostPacer implements HostPacerPort {
  private readonly rootUrlOf: (moduleId: string) => string | undefined;
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly clock: HostPacingClock;
  private readonly buckets = new Map<string, BucketState>();

  public constructor(opts: HostPacerOptions) {
    if (!Number.isInteger(opts.capacity ?? DEFAULT_PACING_CAPACITY) || (opts.capacity ?? DEFAULT_PACING_CAPACITY) < 1) {
      throw new Error(`pacing capacity must be an integer ≥ 1, got ${String(opts.capacity)}`);
    }
    if (!Number.isFinite(opts.intervalMs ?? DEFAULT_PACING_INTERVAL_MS) || (opts.intervalMs ?? DEFAULT_PACING_INTERVAL_MS) <= 0) {
      throw new Error(`pacing intervalMs must be > 0, got ${String(opts.intervalMs)}`);
    }
    this.rootUrlOf = opts.rootUrlOf;
    this.capacity = opts.capacity ?? DEFAULT_PACING_CAPACITY;
    this.intervalMs = opts.intervalMs ?? DEFAULT_PACING_INTERVAL_MS;
    this.clock = opts.clock ?? systemHostPacingClock;
  }

  public async acquire(moduleId: string): Promise<void> {
    const rootUrl = this.rootUrlOf(moduleId);
    if (rootUrl === undefined) {
      return; // unknown module — never gate work on registry absence
    }
    const host = rootHost(rootUrl);
    if (host === '') {
      return; // unparseable RootURL — nothing to pace against
    }
    await this.take(this.bucket(host));
  }

  /** Live pacing snapshot per host (sorted by host; tests + metrics). */
  public stats(): readonly HostPacingStats[] {
    return [...this.buckets.entries()]
      .sort(([a], [b]): number => (a < b ? -1 : 1))
      .map(([host, st]): HostPacingStats => ({ host, tokens: st.tokens, waiting: st.queue.length }));
  }

  private bucket(host: string): BucketState {
    let st = this.buckets.get(host);
    if (st === undefined) {
      // Full bucket: a host that has been quiet answers immediately.
      st = { tokens: this.capacity, lastRefillMs: this.clock.now(), queue: [], pumping: false };
      this.buckets.set(host, st);
    }
    return st;
  }

  private take(st: BucketState): Promise<void> {
    const immediate = st.queue.length === 0 && this.refill(st) >= 1;
    if (immediate) {
      st.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      st.queue.push(resolve);
      void this.pump(st);
    });
  }

  /** Continuous refill toward capacity; returns the token count. */
  private refill(st: BucketState): number {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - st.lastRefillMs);
    st.tokens = Math.min(this.capacity, st.tokens + elapsed / this.intervalMs);
    st.lastRefillMs = now;
    return st.tokens;
  }

  /**
   * Drain the FIFO queue: wait until the head waiter's token exists
   * (fractional refill makes the wait exact), hand it over, continue.
   * Single-flight per bucket — concurrent waiters all land in the
   * queue and are served strictly in arrival order.
   */
  private async pump(st: BucketState): Promise<void> {
    if (st.pumping) {
      return;
    }
    st.pumping = true;
    try {
      while (st.queue.length > 0) {
        const tokens = this.refill(st);
        if (tokens < 1) {
          // Time until one full token refills from the deficit.
          const waitMs = Math.ceil((1 - tokens) * this.intervalMs);
          await this.clock.delay(waitMs);
          continue;
        }
        st.tokens -= 1;
        const resolve = st.queue.shift();
        resolve?.();
      }
    } finally {
      st.pumping = false;
      // A waiter that enqueued while the pump was exiting (the final
      // delay resolved between the loop check and the finally block)
      // must not hang — re-pump once.
      if (st.queue.length > 0 && !st.pumping) {
        void this.pump(st);
      }
    }
  }
}
