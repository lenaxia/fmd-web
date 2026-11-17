/**
 * Downloads-parity job status mapping (tsk-retro-fountain-tasks).
 *
 * FMD2's downloads tab paints one status per task from the set
 * STOP/WAIT/PREPARE/DOWNLOAD/FINISH/CONVERT/COMPRESS/PROBLEM/FAILED
 * (uBaseUnit task states; the embedded progress bar uses the same
 * palette, pas:4516-4592). The web queue models this as §7.1 state ×
 * hold × progress.stage — this module is the ONE derivation:
 *
 *   STOP     ← cancelled, or queued+held (paused)
 *   WAIT     ← queued (claimable)
 *   PREPARE  ← running, stage 'prepare' (or no progress yet)
 *   DOWNLOAD ← running, stage 'download'
 *   COMPRESS ← running, stage 'compress' (zip/cbz pack)
 *   CONVERT  ← running, stage 'convert' (pdf/epub pack)
 *   FINISH   ← running, stage 'finalize' (finishing), or done
 *   PROBLEM  ← retry (errors hit, another attempt comes)
 *   FAILED   ← failed
 *
 * Each status maps onto the semantic job-state design tokens (both
 * themes) — no FMD2 hex colors are copied; the PALETTE maps, the TOKEN
 * paints.
 */
import type { JobStateT, JobT } from '../api/hooks';

/** The FMD2 status palette, web-named. */
export type JobStatusKind =
  | 'waiting'
  | 'preparing'
  | 'downloading'
  | 'compressing'
  | 'converting'
  | 'finishing'
  | 'finished'
  | 'stopped'
  | 'problem'
  | 'failed';

export interface JobStatus {
  readonly kind: JobStatusKind;
  /** Display label (badge text). */
  readonly label: string;
  /** Semantic state token (design-system `state-*` classes). */
  readonly token: 'queued' | 'running' | 'retry' | 'done' | 'failed' | 'cancelled';
}

const LABELS: Record<JobStatusKind, string> = {
  waiting: 'waiting',
  preparing: 'preparing',
  downloading: 'downloading',
  compressing: 'compressing',
  converting: 'converting',
  finishing: 'finishing',
  finished: 'finished',
  stopped: 'stopped',
  problem: 'problem',
  failed: 'failed',
};

const TOKENS: Record<JobStatusKind, JobStatus['token']> = {
  waiting: 'queued',
  preparing: 'running',
  downloading: 'running',
  compressing: 'running',
  converting: 'running',
  finishing: 'done',
  finished: 'done',
  stopped: 'cancelled',
  problem: 'retry',
  failed: 'failed',
};

function stageOf(job: JobT): string | undefined {
  const stage = job.progress?.['stage'];
  return typeof stage === 'string' ? stage : undefined;
}

/** Derive the FMD2-palette status from state × hold × progress stage. */
export function jobStatus(job: JobT): JobStatus {
  let kind: JobStatusKind;
  if (job.state === 'queued') {
    kind = job.paused === true ? 'stopped' : 'waiting';
  } else if (job.state === 'running') {
    const stage = stageOf(job);
    if (stage === 'download') {
      kind = 'downloading';
    } else if (stage === 'compress') {
      kind = 'compressing';
    } else if (stage === 'convert') {
      kind = 'converting';
    } else if (stage === 'finalize') {
      kind = 'finishing';
    } else {
      kind = 'preparing'; // 'prepare' or no progress snapshot yet
    }
  } else if (job.state === 'retry') {
    kind = 'problem';
  } else if (job.state === 'done') {
    kind = 'finished';
  } else if (job.state === 'failed') {
    kind = 'failed';
  } else {
    kind = 'stopped'; // cancelled
  }
  return { kind, label: LABELS[kind], token: TOKENS[kind] };
}

// ── progress payload extraction (WS carries the same shape as REST) ──

export interface JobProgressView {
  /** Images done (markers 'D'). */
  readonly done: number;
  /** Images total for the chapter. */
  readonly total: number;
  /** Transfer rate while downloading (bytes/second, WS progress rate). */
  readonly rateBytesPerSecond?: number;
  /** Finalized artifact path (present once the job finishes). */
  readonly libraryPath?: string;
}

/** Pull the images-done/total + rate view out of a job's progress. */
export function jobProgressView(job: JobT): JobProgressView | undefined {
  const progress = job.progress;
  if (progress === undefined) {
    return undefined;
  }
  const done = progress['done'];
  const total = progress['total'];
  if (typeof done !== 'number' || typeof total !== 'number') {
    return undefined;
  }
  const rate = progress['rate'];
  const libraryPath = progress['libraryPath'];
  return {
    done,
    total,
    ...(typeof rate === 'number' ? { rateBytesPerSecond: rate } : {}),
    ...(typeof libraryPath === 'string' ? { libraryPath } : {}),
  };
}

/** Percent for the progress bar (0–100; indeterminate → undefined). */
export function jobPercent(view: JobProgressView): number {
  if (view.total <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((view.done / view.total) * 100));
}

/** Human transfer rate (FMD2 shows KB/s; binary KiB/MiB here). */
export function formatBytesPerSecond(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MiB/s`;
  }
  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
  }
  return `${String(Math.max(0, Math.round(bytesPerSecond)))} B/s`;
}
