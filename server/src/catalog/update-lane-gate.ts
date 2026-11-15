import type { UpdateLaneGate } from '@fmd/contract';

/**
 * §4 job-lane isolation for the §6.8 live-scrape fallback: browse-
 * triggered directory walks run under THIS gate's slot budget — the
 * update lane's — while downloads claim from the separate `download`
 * lane (LaneRunner independent per-lane concurrency). Saturating the
 * gate therefore queues further scrapes (FIFO) but can never delay a
 * download; the download lane's own slots are untouched by construction
 * (the gate is a distinct resource, proven under concurrent load by
 * test/catalog/lane-isolation.test.ts).
 *
 * FIFO semaphore with direct hand-off on release (the same release
 * shape as PerHostSiteLimiter); `close()` fails every queued waiter
 * fast (§4) — callers map the null grant onto the typed
 * `lane_closed` envelope. Never share one gate instance across
 * lanes: the slot budget IS the isolation.
 */
export class UpdateLaneScrapeGate implements UpdateLaneGate {
  private readonly capacity: number;
  private activeCount = 0;
  private readonly queue: Array<{ grant: (release: () => void) => void; fail: () => void }> = [];
  private closed = false;

  constructor(capacity = 2) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('update-lane gate capacity must be an integer >= 1');
    }
    this.capacity = capacity;
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  async acquire(): Promise<(() => void) | null> {
    if (this.closed) {
      return null;
    }
    if (this.activeCount < this.capacity) {
      this.activeCount += 1;
      return this.makeRelease();
    }
    return new Promise<(() => void) | null>((resolve) => {
      this.queue.push({
        grant: (release) => {
          resolve(release);
        },
        fail: () => {
          resolve(null);
        },
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const waiters = this.queue.splice(0, this.queue.length);
    for (const waiter of waiters) {
      waiter.fail();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      // A lane close fails the queued waiters; held slots just drain
      // (no hand-off to a queue that no longer exists).
      const next = this.closed ? undefined : this.queue.shift();
      if (next !== undefined) {
        next.grant(this.makeRelease()); // slot transfers; active unchanged
        return;
      }
      this.activeCount = Math.max(0, this.activeCount - 1);
    };
  }
}
