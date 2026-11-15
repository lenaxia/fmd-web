import { PackError } from './errors.js';

/**
 * Pack watchdog (DESIGN.md §7.3): every pack runs under a 120 s default
 * deadline. The watchdog races the pack work — when the deadline fires,
 * the pack rejects immediately as `pack` (retryable) and the abort
 * signal tears down the in-flight streams. A stalled input (fake-slow
 * site, hung disk) therefore fails the pack at the deadline instead of
 * wedging the download lane.
 */

export const DEFAULT_WATCHDOG_MS: number = 120_000;

function saneDeadline(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return DEFAULT_WATCHDOG_MS;
  }
  // setTimeout overflows past 2^31-1 — clamp to a sane ceiling (24 h).
  return Math.min(Math.floor(deadlineMs), 24 * 60 * 60 * 1000);
}

export class PackWatchdog {
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private readonly deadlineMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rejectFn: ((error: PackError) => void) | undefined;
  private rejectionPromise: Promise<never> | undefined;
  private fired = false;

  constructor(deadlineMs?: number) {
    this.deadlineMs = saneDeadline(deadlineMs);
    this.controller = new AbortController();
    this.signal = this.controller.signal;
  }

  /** Arm the deadline; `race()` surfaces the rejection to the pack. */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.rejectionPromise = new Promise<never>((_resolve, reject) => {
      this.rejectFn = reject;
    });
    // The losing side of the race is silenced (no unhandled rejection).
    this.rejectionPromise.catch(() => undefined);
    this.timer = setTimeout(() => {
      this.fired = true;
      const error = new PackError(
        'pack-watchdog-timeout',
        `pack watchdog deadline exceeded after ${this.deadlineMs} ms`,
        { recoveryHint: 'retry' },
      );
      this.controller.abort(error);
      this.rejectFn?.(error);
    }, this.deadlineMs);
  }

  /** Race `work` against the armed deadline. */
  race<T>(work: Promise<T>): Promise<T> {
    if (this.rejectionPromise === undefined) {
      return work;
    }
    return Promise.race([work, this.rejectionPromise]);
  }

  /** Cheap synchronous probe between item appends. */
  checkAlive(): void {
    if (this.fired) {
      throw new PackError('pack-watchdog-timeout', 'pack watchdog deadline exceeded', {
        recoveryHint: 'retry',
      });
    }
  }

  /** Disarm. Pending race rejection (already-settled races) is silenced. */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
