/**
 * Lock primitives for the shared module state service (DESIGN.md §5.3) —
 * the JS mirrors of the locked Pascal objects (`LuaStringsStorage.pas:17,75`,
 * `httpcookiemanager.pas:46`, `WebsiteModules.pas:90`). Locking policy (D12):
 * same-module events MAY run concurrently across workers; ONLY the state
 * objects lock, never a whole event. Locks are promise-queued: a holder that
 * crosses an `await` keeps the lock, waiters queue FIFO.
 *
 * Every hold is reported to an optional {@link LockHoldTracker} — the test
 * detector that proves NO lock is held across an injected user callback
 * (§5.3: "only the state objects are locked").
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type HoldMap = Map<string, number>;

/**
 * Shared hold-accounting sink for the lock-held-during-callback detector.
 * Holds are tracked PER ASYNC CONTEXT (AsyncLocalStorage): a concurrent
 * worker legitimately holding a lock must never fail ANOTHER worker's
 * assertion — §5.3's invariant is "this execution path holds no lock while
 * user code runs", not "the process is lock-free".
 */
export class LockHoldTracker {
  private readonly als = new AsyncLocalStorage<HoldMap>();
  private globalHolds: HoldMap = new Map();
  private allTimeTotal = 0;

  enter(label: string): void {
    this.allTimeTotal += 1;
    const store = this.als.getStore();
    const target = store ?? this.globalHolds;
    target.set(label, (target.get(label) ?? 0) + 1);
  }

  exit(label: string): void {
    this.allTimeTotal = Math.max(0, this.allTimeTotal - 1);
    const store = this.als.getStore();
    const target = store ?? this.globalHolds;
    const n = (target.get(label) ?? 0) - 1;
    if (n > 0) {
      target.set(label, n);
    } else {
      target.delete(label);
    }
  }

  /** Live lock holds on the CURRENT async context (diagnostics). */
  activeLabels(): string[] {
    const store = this.als.getStore();
    return [...(store ?? this.globalHolds).keys()];
  }

  /** Live lock holds process-wide (every enter has a matching exit ⇒ 0). */
  activeCount(): number {
    return this.allTimeTotal;
  }

  /** Run `fn` in its own tracking context (test harnesses wrap events with this). */
  async inContext<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.als.run(new Map(), async () => fn());
  }

  /**
   * The detector itself: assert THIS async context holds no lock right now.
   * Wrap every injection point where control crosses into user (module/Lua)
   * code — a violation means the calling path leaked a lock into user code.
   */
  assertIdle(where: string): void {
    const store = this.als.getStore();
    const holds = store ?? this.globalHolds;
    if (holds.size !== 0) {
      throw new Error(
        `lock held across user callback at ${where}: [${[...holds.keys()].join(', ')}] — ` +
          'DESIGN.md §5.3 forbids holding a state lock across user code',
      );
    }
  }

  /** No lock leaked anywhere in the process (call at quiescence). */
  assertGloballyIdle(where: string): void {
    if (this.allTimeTotal !== 0 || this.globalHolds.size !== 0) {
      throw new Error(
        `lock leaked at ${where}: [${[...this.globalHolds.keys()].join(', ')}] ` +
          `(unbalanced hold count ${this.allTimeTotal})`,
      );
    }
  }
}

type Waiter = { resolve: () => void };

/**
 * Promise mutex with TryEnter semantics (FMD2 TryEnterCriticalSection).
 * Hold tracking discipline: `enter` ALWAYS runs in the acquiring context —
 * immediately for uncontended takes, in the waiter's own continuation
 * (`.then` attached at acquire time) for queued grants — so a hold never
 * straddles two async contexts.
 */
export class AsyncMutex {
  private locked = false;
  private readonly queue: Waiter[] = [];

  constructor(private readonly tracker?: LockHoldTracker, private readonly label = 'mutex') {}

  get isLocked(): boolean {
    return this.locked;
  }

  /** Waiters waiting behind the current holder (observable for tests). */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * TryEnterCriticalSection semantics: take the lock NOW if free, else
   * `null` — the caller NEVER waits (LuaWebsiteBypass.pas:161 fallthrough).
   */
  tryAcquire(): (() => void) | null {
    if (this.locked) {
      return null;
    }
    this.locked = true;
    this.tracker?.enter(this.label);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.tracker?.exit(this.label);
      this.handOff();
    };
  }

  /** Acquire, waiting for the current holder to release (FIFO). */
  acquire(): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate !== null) {
      return Promise.resolve(immediate);
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve: () => resolve() });
    }).then(() => {
      // waiter-side context: the hold enters where the await resumes
      this.tracker?.enter(this.label);
      return this.makeQueuedRelease();
    });
  }

  /** Run `fn` under the mutex; the lock NEVER spans the returned promise's consumers — only `fn`. */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeQueuedRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.tracker?.exit(this.label);
      this.handOff();
    };
  }

  private handOff(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.locked = false;
      return;
    }
    next.resolve();
  }
}

/**
 * RW lock for the cookie jar (§5.3: cookie jar = RW lock). Concurrent
 * readers; writers are exclusive and FIFO-queued; a queued writer bars
 * NEW readers (write-preferring, so readers cannot starve a writer).
 * `hold` callbacks run synchronously inside the hold window — user
 * (async) callbacks must stay OUTSIDE these scopes; the tracker proves it.
 */
export class AsyncRWLock {
  private readers = 0;
  private writer: Waiter | null = null;
  private readonly readerQueue: Waiter[] = [];
  private readonly writerQueue: Waiter[] = [];

  constructor(private readonly tracker?: LockHoldTracker, private readonly label = 'rwlock') {}

  get readerCount(): number {
    return this.readers;
  }

  get writerQueued(): boolean {
    return this.writer !== null || this.writerQueue.length > 0;
  }

  /** Shared access — granted immediately unless a writer holds/queues. */
  read(): Promise<() => void> {
    if (this.writer === null && this.writerQueue.length === 0) {
      this.readers += 1;
      this.tracker?.enter(this.label);
      let released = false;
      return Promise.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.tracker?.exit(this.label);
        this.releaseReader();
      });
    }
    return new Promise<void>((resolve) => {
      this.readerQueue.push({ resolve: () => resolve() });
    }).then(() => {
      // waiter-side context: the hold enters where the await resumes
      this.tracker?.enter(this.label);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        this.tracker?.exit(this.label);
        this.releaseReader();
      };
    });
  }

  /** Exclusive access — waits for all current readers to drain (FIFO writers). */
  write(): Promise<() => void> {
    if (this.readers === 0 && this.writer === null) {
      this.writer = { resolve: () => undefined };
      this.tracker?.enter(this.label);
      let released = false;
      return Promise.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.tracker?.exit(this.label);
        this.releaseWriter();
      });
    }
    return new Promise<void>((resolve) => {
      this.writerQueue.push({ resolve: () => resolve() });
    }).then(() => {
      this.tracker?.enter(this.label);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        this.tracker?.exit(this.label);
        this.releaseWriter();
      };
    });
  }

  async runRead<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.read();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async runWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.write();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaseReader(): void {
    this.readers -= 1;
    this.grant();
  }

  private releaseWriter(): void {
    this.writer = null;
    this.grant();
  }

  /** Grant the next batch: a queued writer, else every queued reader (no tracker calls — owners self-register). */
  private grant(): void {
    if (this.readers > 0 || this.writer !== null) {
      return;
    }
    const writer = this.writerQueue.shift();
    if (writer !== undefined) {
      this.writer = writer;
      writer.resolve();
      return;
    }
    while (this.readerQueue.length > 0) {
      const reader = this.readerQueue.shift();
      if (reader === undefined) {
        break;
      }
      this.readers += 1;
      reader.resolve();
    }
  }
}

/**
 * Storage KV = per-key mutex (§5.3). Mutexes are created lazily per key and
 * persist for the key's lifetime (no cross-key serialization): operations on
 * key A never wait behind key B — that granularity is what the tests assert.
 */
export class PerKeyMutexPool {
  private readonly mutexes = new Map<string, AsyncMutex>();

  constructor(private readonly tracker?: LockHoldTracker) {}

  forKey(key: string): AsyncMutex {
    let m = this.mutexes.get(key);
    if (m === undefined) {
      m = new AsyncMutex(this.tracker, `storage:${key}`);
      this.mutexes.set(key, m);
    }
    return m;
  }

  runExclusive<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    return this.forKey(key).runExclusive(fn);
  }
}

/** Extract the host (lowercased, no port) from a URL — limiter + bypass keys. */
export function hostOf(url: string): string {
  let host = url;
  if (host.startsWith('//')) {
    host = host.slice(2);
  } else {
    const scheme = host.indexOf('://');
    if (scheme >= 0) {
      host = host.slice(scheme + 3);
    }
  }
  const slash = host.search(/[/?#]/);
  if (slash >= 0) {
    host = host.slice(0, slash);
  }
  const at = host.lastIndexOf('@');
  if (at >= 0) {
    host = host.slice(at + 1);
  }
  const colon = host.indexOf(':');
  if (colon >= 0) {
    host = host.slice(0, colon);
  }
  return host.toLowerCase();
}
