import { CELL_SLEEP_NOTIFY } from '../lua/abort.js';

/**
 * Per-host connection gate (DESIGN §5.4 "per-host connection limits +
 * delays host-level"; mirrors `THTTPQueue.AddConnection`'s
 * MaxConnections wait — httpsendthread.pas:419-432 — with an added
 * host-level minimum-start-interval). Queued-but-unstarted requests
 * fail fast on abort: the wait loop re-checks the abort handle every
 * chunk and wakes instantly on the abort cells' notify.
 */

export interface HostGatePort {
  /**
   * Acquire one connection slot for `url`'s host. Blocks while the
   * host is at its limit / inside its start-interval delay. Returns
   * the release function, or null when `isTerminated` became true
   * before the slot was granted (queued-but-unstarted → fail fast).
   */
  acquire(url: string, isTerminated: () => boolean): (() => void) | null;
}

export interface HostGateOptions {
  /** Per-host concurrency limit (0/undefined = unlimited, FMD2 default). */
  readonly limit?: number;
  /** Minimum interval between two connection starts to the same host (ms). */
  readonly delayMs?: number;
  /** Abort cells for instant wake on abort (DeadlineAbortHandle.cells). */
  readonly abortCells?: Int32Array;
  /** Poll chunk while queued/delayed (ms); small for test determinism. */
  readonly chunkMs?: number;
}

interface HostState {
  active: number;
  queue: Array<() => void>;
  lastStart: number;
}

const CLOCK_EPOCH = 1700000000000;

/** monotonic-ish clock immune to wall-clock jumps inside one process. */
function nowMs(): number {
  return performance.now() + CLOCK_EPOCH;
}

export class SyncHostGate implements HostGatePort {
  private readonly hosts = new Map<string, HostState>();
  private readonly limit: number;
  private readonly delayMs: number;
  private readonly chunkMs: number;
  private readonly abortCells: Int32Array | undefined;

  constructor(options: HostGateOptions = {}) {
    this.limit = Math.max(0, Math.trunc(options.limit ?? 0));
    this.delayMs = Math.max(0, Math.trunc(options.delayMs ?? 0));
    this.chunkMs = Math.max(1, Math.trunc(options.chunkMs ?? 25));
    this.abortCells = options.abortCells;
  }

  private hostOf(url: string): string {
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
    const authority = m?.[1] ?? '';
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    const start = hostPort.startsWith('[') ? hostPort.indexOf(']') : 0;
    const colon = hostPort.indexOf(':', start);
    return (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
  }

  private state(host: string): HostState {
    let st = this.hosts.get(host);
    if (st === undefined) {
      st = { active: 0, queue: [], lastStart: 0 };
      this.hosts.set(host, st);
    }
    return st;
  }

  activeFor(url: string): number {
    return this.state(this.hostOf(url)).active;
  }

  queuedFor(url: string): number {
    return this.state(this.hostOf(url)).queue.length;
  }

  acquire(url: string, isTerminated: () => boolean): (() => void) | null {
    if (this.limit <= 0 && this.delayMs <= 0) {
      return () => undefined;
    }
    const host = this.hostOf(url);
    const st = this.state(host);
    if (isTerminated()) {
      return null; // queued-but-unstarted → fail fast, nothing sent
    }
    // FIFO queue while the host is at its concurrency limit
    // (THTTPQueue.AddConnection's Sleep(HeartBeatRate) loop, :425-431)
    if (this.limit > 0 && st.active >= this.limit) {
      const token = { granted: false };
      const push = (): void => {
        token.granted = true;
      };
      st.queue.push(push);
      while (!token.granted) {
        if (isTerminated()) {
          const i = st.queue.indexOf(push);
          if (i !== -1) {
            st.queue.splice(i, 1);
          }
          return null;
        }
        this.waitChunk();
      }
      // slot handed off directly — the active count never changed;
      // lastStart was stamped by the releasing hop (start interval)
      return this.makeRelease(host);
    }
    // host-level start interval: minimum spacing between connection
    // starts to the same host
    while (this.delayMs > 0) {
      const remaining = this.delayMs - (nowMs() - st.lastStart);
      if (remaining <= 0) {
        break;
      }
      if (isTerminated()) {
        return null;
      }
      this.waitChunk(Math.min(this.chunkMs, remaining));
    }
    if (isTerminated()) {
      return null;
    }
    st.lastStart = nowMs();
    st.active += 1;
    return this.makeRelease(host);
  }

  private makeRelease(host: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const st = this.state(host);
      const next = st.queue.shift();
      if (next !== undefined) {
        // slot transfers directly to the next waiter (active unchanged);
        // stamp the start interval so handoffs space out too
        st.lastStart = nowMs();
        next();
        return;
      }
      st.active = Math.max(0, st.active - 1);
    };
  }

  private waitChunk(ms?: number): void {
    if (this.abortCells !== undefined) {
      Atomics.wait(this.abortCells, CELL_SLEEP_NOTIFY, 0, ms ?? this.chunkMs);
      return;
    }
    const deadline = Date.now() + (ms ?? this.chunkMs);
    const buf = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      Atomics.wait(buf, 0, 0, Math.max(1, Math.min(remaining, 20)));
    }
  }
}
