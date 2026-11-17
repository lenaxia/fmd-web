import type { HttpAbortHandle } from '../contract.js';

/**
 * Deadline/abort machinery shared by `sleep()` and the watchdog (§4, §5.12).
 *
 * The cells live in one SharedArrayBuffer so the deadline watchdog worker
 * can signal the Lua thread synchronously — the Lua thread is blocked in
 * `Atomics.wait` while `sleep` runs, so postMessage alone cannot reach it.
 */
export const CELL_SLEEP_NOTIFY = 0;
export const CELL_TIMER_CANCEL_NOTIFY = 1;
export const CELL_EXPIRED_TOKEN = 2;
export const CELL_CANCEL_REQUEST = 3;
export const CELL_TERMINATED = 4;
export const CELL_COUNT = 5;

export function createDeadlineCells(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(CELL_COUNT * Int32Array.BYTES_PER_ELEMENT));
}

/**
 * Concrete abort handle (§4): `abort()` sets Terminated semantics, stores
 * the flag in shared memory (readable by a thread blocked in `sleep`) and
 * wakes any sleeper on the interrupt cell.
 */
export class DeadlineAbortHandle implements HttpAbortHandle {
  private localTerminated = false;
  private localReason: string | undefined;

  constructor(private readonly cells: Int32Array) {}

  abort(reason?: string): void {
    this.localTerminated = true;
    if (reason !== undefined && this.localReason === undefined) {
      this.localReason = reason;
    }
    Atomics.store(this.cells, CELL_TERMINATED, 1);
    Atomics.notify(this.cells, CELL_SLEEP_NOTIFY);
  }

  get terminated(): boolean {
    return this.localTerminated || Atomics.load(this.cells, CELL_TERMINATED) === 1;
  }

  get reason(): string | undefined {
    if (this.localReason !== undefined) {
      return this.localReason;
    }
    return this.terminated ? 'deadline exceeded' : undefined;
  }
}

/**
 * Real blocking `sleep(ms)` (§5.1, LuaBase.pas:72-76): blocks the calling
 * thread with chunked `Atomics.wait`, cooperative-cancelled through
 * `HTTP.Terminated` (`cloudflare.lua:26-33`) and hard-interruptible by
 * the deadline watchdog's notify on `CELL_SLEEP_NOTIFY`. Interrupts throw
 * a Lua error so the surrounding event call fails.
 */
export function blockingSleep(ms: number, abort: HttpAbortHandle, cells: Int32Array, chunkMs = 50): void {
  const end = Date.now() + Math.max(0, ms);
  for (;;) {
    if (abort.terminated) {
      throw new Error(abort.reason ?? 'aborted during sleep');
    }
    const remaining = end - Date.now();
    if (remaining <= 0) {
      return;
    }
    Atomics.wait(cells, CELL_SLEEP_NOTIFY, 0, Math.min(remaining, chunkMs));
  }
}
