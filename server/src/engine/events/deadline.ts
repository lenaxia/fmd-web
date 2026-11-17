import { Worker } from 'node:worker_threads';
import type { HttpAbortHandle } from '../contract.js';
import type { EventDeadlineController } from '../contract.js';
import { CELL_CANCEL_REQUEST, CELL_EXPIRED_TOKEN } from '../lua/abort.js';

/**
 * Per-event wall-clock deadline controller (§4, §5.12): the deadline is
 * enforced by a watchdog thread so it can interrupt a Lua thread blocked
 * in `sleep` (which blocks synchronously). On expiry the watchdog writes
 * the expired token + Terminated flag into the shared cells and wakes the
 * sleeper; the controller then invokes the injected abort handle so
 * `HTTP.Terminated` semantics are set for the run and the event fails.
 */

const WATCHDOG_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const cells = new Int32Array(workerData.cells);
parentPort.on('message', (msg) => {
  if (msg.type !== 'arm') {
    return;
  }
  const token = msg.token;
  const end = Date.now() + (msg.deadlineMs || 0);
  let expired = false;
  // Chunked wait: immune to lost cancel wakeups (cell 3 checked each chunk).
  for (;;) {
    if (Date.now() >= end) {
      expired = true;
      break;
    }
    if (Atomics.load(cells, 3) !== 0) {
      break;
    }
    const remaining = end - Date.now();
    Atomics.wait(cells, 1, 0, Math.min(Math.max(remaining, 1), 5));
  }
  if (expired) {
    Atomics.store(cells, 2, token);
    Atomics.store(cells, 4, 1);
    Atomics.notify(cells, 0);
  }
  Atomics.store(cells, 3, 0);
  parentPort.postMessage({ type: expired ? 'expired' : 'cancelled', token });
});
`;

export class WatchdogDeadlineController implements EventDeadlineController {
  readonly cells: Int32Array;
  private worker: Worker | null = null;
  private nextToken = 1;

  constructor(cells: Int32Array) {
    this.cells = cells;
  }

  run<T>(deadlineMs: number, abort: HttpAbortHandle, fn: () => T): {
    readonly value: T | undefined;
    readonly threw: boolean;
    readonly error: unknown;
    readonly timedOut: boolean;
  } {
    const worker = this.ensureWorker();
    const token = this.nextToken;
    this.nextToken += 1;

    // clear per-run shared state, then arm
    Atomics.store(this.cells, CELL_EXPIRED_TOKEN, 0);
    Atomics.store(this.cells, CELL_CANCEL_REQUEST, 0);
    Atomics.store(this.cells, 4, 0);
    worker.postMessage({ type: 'arm', token, deadlineMs });

    let value: T | undefined;
    let threw = false;
    let error: unknown;
    try {
      value = fn();
    } catch (err) {
      threw = true;
      error = err;
    }

    // detect expiry: the watchdog may have fired while fn was blocked
    const expiredToken = Atomics.load(this.cells, CELL_EXPIRED_TOKEN);
    const timedOut = expiredToken === token;
    if (timedOut) {
      // expiry invokes the injected abort handle (Terminated semantics, §4)
      abort.abort(abort.reason ?? 'event deadline exceeded');
      if (!threw) {
        threw = true;
        error = new Error('event deadline exceeded');
      }
    }

    // cancel the armed watchdog (notify + flag; chunked polling covers races)
    Atomics.store(this.cells, CELL_CANCEL_REQUEST, 1);
    Atomics.notify(this.cells, 1);

    return { value, threw, error, timedOut };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker === null) {
      this.worker = new Worker(WATCHDOG_SCRIPT, {
        eval: true,
        workerData: { cells: this.cells.buffer },
      });
      this.worker.unref();
    }
    return this.worker;
  }
}

export function createDeadlineController(cells: Int32Array): WatchdogDeadlineController {
  return new WatchdogDeadlineController(cells);
}
