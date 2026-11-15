import type { LimiterRelease, SiteLimiter } from './types.js';

/** Lowercased URL host (host:port kept — different ports limit apart). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

interface HostState {
  active: number;
  queue: Array<{ grant: (r: LimiterRelease) => void; fail: () => void }>;
}

interface HostLimit {
  limit: number;
  state: HostState;
}

/**
 * Per-site connection limiter (DESIGN §7.1 "per-site limiter"; FMD2
 * `THTTPQueue` / `ModuleContainer.MaxConnectionLimit` — a limit of 0
 * means no limit). FIFO slot queue per host with direct hand-off on
 * release, and §4 cancellation: `cancelAll()` resolves every queued
 * waiter with null (queued-but-unstarted → fail fast) while granted
 * slots are untouched; releases keep decrementing normally.
 */
export class PerHostSiteLimiter implements SiteLimiter {
  private readonly hosts = new Map<string, HostLimit>();
  private cancelled = false;

  constructor(private defaultLimit = 0) {}

  setHostLimit(host: string, limit: number): void {
    this.entry(host).limit = Math.max(0, Math.trunc(limit));
  }

  limitFor(url: string): number {
    return this.entry(hostOf(url)).limit;
  }

  activeFor(url: string): number {
    return this.entry(hostOf(url)).state.active;
  }

  async acquire(url: string, isCancelled: () => boolean): Promise<LimiterRelease | null> {
    const entry = this.entry(hostOf(url));
    if (entry.limit <= 0) {
      return () => undefined; // unlimited: nothing to count (FMD2 limit 0)
    }
    if (this.cancelled || isCancelled()) {
      return null; // cancelled before start (§4 fail fast)
    }
    const st = entry.state;
    if (st.active < entry.limit) {
      st.active += 1;
      return this.makeRelease(st);
    }
    return new Promise<LimiterRelease | null>((resolve) => {
      st.queue.push({
        grant: (release) => resolve(release),
        fail: () => resolve(null),
      });
    });
  }

  cancelAll(): void {
    this.cancelled = true;
    for (const entry of this.hosts.values()) {
      const waiters = entry.state.queue.splice(0, entry.state.queue.length);
      for (const w of waiters) {
        w.fail();
      }
    }
  }

  private makeRelease(st: HostState): LimiterRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = st.queue.shift();
      if (next !== undefined) {
        next.grant(this.makeRelease(st)); // slot transfers; active unchanged
        return;
      }
      st.active = Math.max(0, st.active - 1);
    };
  }

  private entry(host: string): HostLimit {
    const key = host === '' ? '(invalid-url)' : host;
    let entry = this.hosts.get(key);
    if (entry === undefined) {
      entry = { limit: this.defaultLimit, state: { active: 0, queue: [] } };
      this.hosts.set(key, entry);
    }
    return entry;
  }
}
