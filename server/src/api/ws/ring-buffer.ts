/**
 * D19 per-job event ring buffer (DESIGN.md §10/D19): keeps the LAST
 * `capacity` events and drops buffered events older than `maxAgeMs`.
 *
 * Eviction bookkeeping: `lastEvictedId` records the highest id ever
 * evicted (by capacity OR age). The hub's reconnect decision is derived
 * from it — a client cursor below the watermark means the requested
 * window has a hole that can no longer be reconstructed → `resync`.
 *
 * The clock is injectable so boundary tests (exactly 15 min, exactly at
 * capacity) are deterministic.
 */

export interface RingEntry<T> {
  /** Monotonic event id (hub-assigned, strictly increasing). */
  readonly id: number;
  /** Enqueue time in clock ms — the age-sweep input. */
  readonly at: number;
  /** The wire-ready payload. */
  readonly value: T;
}

export interface RingBufferOptions {
  /** Maximum retained events (D19: 1000 per job). Must be >= 1. */
  readonly capacity: number;
  /** Maximum retention age in ms (D19: 15 min); age >= max is evicted. */
  readonly maxAgeMs: number;
  /** Injectable clock (default Date.now). */
  readonly now?: () => number;
}

export class JobEventRingBuffer<T> {
  private entries: RingEntry<T>[] = [];
  private evictedWatermark = 0;
  private readonly capacity: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;

  constructor(options: RingBufferOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error('ring buffer capacity must be an integer >= 1');
    }
    if (!Number.isInteger(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error('ring buffer maxAgeMs must be an integer >= 0');
    }
    this.capacity = options.capacity;
    this.maxAgeMs = options.maxAgeMs;
    this.clock = options.now ?? Date.now;
  }

  /** Highest id ever evicted (capacity or age) — 0 when none. */
  get lastEvictedId(): number {
    return this.evictedWatermark;
  }

  get size(): number {
    return this.entries.length;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Lowest retained id (undefined when empty). */
  get oldestId(): number | undefined {
    return this.entries[0]?.id;
  }

  /** Highest retained id (undefined when empty). */
  get newestId(): number | undefined {
    return this.entries.at(-1)?.id;
  }

  /**
   * Append one event. Ids must be strictly increasing (the hub's
   * monotonic assignment) — violations throw, they are caller bugs.
   * Capacity overflow evicts the OLDEST entries.
   */
  append(id: number, value: T, at: number = this.clock()): void {
    const newest = this.newestId;
    if (newest !== undefined && id <= newest) {
      throw new Error(`ring buffer ids must increase strictly (${String(id)} after ${String(newest)})`);
    }
    this.entries.push({ id, at, value });
    while (this.entries.length > this.capacity) {
      const evicted = this.entries.shift();
      if (evicted !== undefined) {
        this.evictedWatermark = Math.max(this.evictedWatermark, evicted.id);
      }
    }
  }

  /**
   * Age sweep: drop entries whose age is >= maxAgeMs (exactly at the
   * bound is evicted — retention is strictly UNDER the max age).
   * Returns the number of evicted entries.
   */
  sweep(now: number = this.clock()): number {
    let evicted = 0;
    for (;;) {
      const oldest = this.entries[0];
      if (oldest === undefined || now - oldest.at < this.maxAgeMs) {
        break;
      }
      this.entries.shift();
      this.evictedWatermark = Math.max(this.evictedWatermark, oldest.id);
      evicted += 1;
    }
    return evicted;
  }

  /**
   * Retained entries with id > afterId, in id order. Contiguity is the
   * CALLER's decision (via `lastEvictedId`) — replay alone never
   * silently skips: entries below the watermark are already gone.
   */
  replay(afterId: number): RingEntry<T>[] {
    return this.entries.filter((entry) => entry.id > afterId);
  }
}
