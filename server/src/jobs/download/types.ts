import type { PipelineWorkId } from '../../engine/facade.js';

/**
 * Download-job seams (DESIGN §7.1). The ChapterPipeline lives in
 * `engine/pipeline/chapter-pipeline.ts` (the 'W'/'D' resume contract);
 * the job codes against THREE interfaces — ImageWorkerPool
 * (MaxThreadPerTaskLimit threads per task), SiteLimiter (per-site
 * connection bounds, FMD2 `THTTPQueue`/`MaxConnectionLimit`) and the
 * ChapterModuleHooks module seam (the §5.2 download-event surface: the
 * future Lua adapter binds TASK/HTTP/WORKID/URL per call; tests double
 * it with a hook-call log).
 */

/**
 * Release one acquired limiter slot.
 */
export type LimiterRelease = () => void;

/**
 * Per-site connection limiter. `acquire` resolves with the release
 * function, or null when the job was cancelled before a slot was
 * granted (queued-but-unstarted → fail fast, §4).
 */
export interface SiteLimiter {
  /** Configure one host's concurrency bound (0 = unlimited). */
  setHostLimit(host: string, limit: number): void;
  /** The effective limit for `url`'s host. */
  limitFor(url: string): number;
  /** Active (granted, unreleased) slot count for `url`'s host. */
  activeFor(url: string): number;
  /**
   * Acquire one connection slot for `url`'s host; FIFO-queued while the
   * host is at its limit. Resolves null on cancellation (§4 fail fast).
   */
  acquire(url: string, isCancelled: () => boolean): Promise<LimiterRelease | null>;
  /** Fail every queued waiter fast (job cancellation; terminal — the
   *  limiter is single-job: after cancelAll every acquire fails fast). */
  cancelAll(): void;
}

/**
 * ImageWorkerPool — the download-phase thread pool (FMD2
 * `TDownloadThreads`, uDownloadsManager.pas:870-920). Drives `workIds`
 * FIFO through `worker` with at most `maxThreads` concurrent items;
 * `shouldStop` (the job cancel flag) stops scheduling queued-but-unstarted
 * items. In-flight items settle on their own (the abort signal handles
 * them); a throwing worker is isolated and reported per item.
 */
export interface ImageWorkerPool {
  run(
    workIds: readonly PipelineWorkId[],
    maxThreads: number,
    worker: (workId: PipelineWorkId) => Promise<void>,
    shouldStop?: () => boolean,
  ): Promise<readonly PoolItemFailure[]>;
}

/** One isolated worker failure (workId + message). */
export interface PoolItemFailure {
  readonly workId: PipelineWorkId;
  readonly error: string;
}

// ─────────────────────────────────────────────────────────────────
// ENGINE-SIDE PORTS (engine-boundary story, tsk-linear-varnish-restricts):
// the §7.1 download-event surface (ChapterModuleHooks/TaskWriter — the
// module seam), the image-fetch view types and the cancellation handle
// moved INTO the engine (server/src/engine/services/download-ports.ts)
// because the engine implements them; this jobs module re-exports the
// facade's domain types so jobs-internal imports stay local.
// ─────────────────────────────────────────────────────────────────
export type {
  ChapterModuleHooks,
  TaskWriter,
  FetchedImage,
  ImageFetchResult,
  ImageDownloader,
  CancelToken,
} from '../../engine/facade.js';
