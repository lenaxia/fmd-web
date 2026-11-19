/**
 * Per-site failure coalescing for `failure.digest` (charter-pinned):
 * check failures accumulate per SITE inside a 15-minute digest window
 * keyed on the FIRST failure; when the window closes, ONE digest entry
 * is emitted for that site. A dead site with 50 favorites therefore
 * produces ONE entry per digest window — never 50 notifications. A
 * failure arriving after the close opens a fresh window.
 *
 * "Site" is the module id (one module = one site = one origin; the
 * same taxonomy TRIAGE and the availability record use).
 *
 * Deterministic by construction: the window timer is an injected
 * scheduling seam (tests drive it manually; production uses unref'd
 * setTimeout — a pending digest never holds the process open).
 */

import type { FailureDigestData } from '@fmd/contract';

/** The digest window length (ms) — 15 minutes per site, charter-frozen. */
export const FAILURE_DIGEST_WINDOW_MS = 15 * 60 * 1000;

/** Cap on the affected-favorites sample riding a digest entry. */
export const FAILURE_DIGEST_SAMPLE_CAP = 5;

/** Cancellation handle for one armed window-flush timer. */
export interface FailureWindowTimer {
  cancel(): void;
}

/** Scheduling seam (production: unref'd setTimeout; tests: manual). */
export type ScheduleFlush = (fire: () => void, ms: number) => FailureWindowTimer;

export const setTimeoutFlush: ScheduleFlush = (fire, ms): FailureWindowTimer => {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return {
    cancel: (): void => {
      clearTimeout(timer);
    },
  };
};

export interface SiteFailureCoalescerDeps {
  /** Digest-window length override (tests shrink it; default 15 min). */
  readonly windowMs?: number;
  /** Wall clock (default Date.now). */
  readonly now?: () => number;
  /** Timer scheduling (default unref'd setTimeout). */
  readonly schedule?: ScheduleFlush;
  /** The ONE emission sink — the notifier's fire-and-forget emit. */
  readonly onDigest: (entry: FailureDigestData) => void;
}

interface OpenWindow {
  readonly moduleId: string;
  readonly startedAt: number;
  readonly favorites: Set<string>;
  failureCount: number;
  firstError: string;
  lastError: string;
  timer: FailureWindowTimer;
}

export class SiteFailureCoalescer {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: ScheduleFlush;

  public constructor(private readonly deps: SiteFailureCoalescerDeps) {
    this.windowMs = deps.windowMs ?? FAILURE_DIGEST_WINDOW_MS;
    this.now = deps.now ?? ((): number => Date.now());
    this.schedule = deps.schedule ?? setTimeoutFlush;
  }

  /**
   * Record one check failure against its site. Opens the site's window
   * on first sight (arming the flush timer for the window's full
   * length from the FIRST failure — later failures never extend it);
   * coalesces otherwise. Never throws (a notification path must never
   * take the pipe down).
   */
  public record(moduleId: string, mangaKey: string, error: unknown, at?: number): void {
    const now = at ?? this.now();
    const message = error instanceof Error ? error.message : String(error);
    const messageTruncated = message.slice(0, 500);
    const open = this.windows.get(moduleId);
    if (open !== undefined) {
      open.failureCount += 1;
      open.favorites.add(mangaKey);
      open.lastError = messageTruncated;
      return;
    }
    const moduleIdSafe = moduleId;
    const timer = this.schedule((): void => this.flush(moduleIdSafe), this.windowMs);
    this.windows.set(moduleIdSafe, {
      moduleId: moduleIdSafe,
      startedAt: now,
      favorites: new Set([mangaKey]),
      failureCount: 1,
      firstError: messageTruncated,
      lastError: messageTruncated,
      timer,
    });
  }

  /**
   * Close one site's window and emit its single coalesced entry. The
   * timer calls this; tests may call it directly at a chosen clock
   * time (pass `at` to stamp the window end deterministically).
   */
  public flush(moduleId: string, at?: number): void {
    const open = this.windows.get(moduleId);
    if (open === undefined) {
      return;
    }
    open.timer.cancel();
    this.windows.delete(moduleId);
    const endedAt = at ?? this.now();
    this.deps.onDigest({
      moduleId: open.moduleId,
      windowStartedAt: new Date(open.startedAt).toISOString(),
      windowEndedAt: new Date(endedAt).toISOString(),
      failureCount: open.failureCount,
      affectedFavoritesCount: open.favorites.size,
      affectedFavoritesSample: [...open.favorites].slice(0, FAILURE_DIGEST_SAMPLE_CAP),
      firstError: open.firstError,
      lastError: open.lastError,
    });
  }

  /** Sites with an open window right now (test/observability seam). */
  public openSites(): readonly string[] {
    return [...this.windows.keys()].sort();
  }

  /** Drop every open window WITHOUT emitting (shutdown path). */
  public dispose(): void {
    for (const open of this.windows.values()) {
      open.timer.cancel();
    }
    this.windows.clear();
  }

  private readonly windows = new Map<string, OpenWindow>();
}
