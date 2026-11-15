import type { PipelineWorkId } from '../../engine/pipeline/chapter-pipeline.js';

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

/** The bytes + type of one fetched image (the §5.4 HTTP.Document view). */
export interface FetchedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * The §5.2 download-event module surface, host-driven. Each method maps
 * one FMD2 Do* dispatcher (LuaWebsiteModules.pas); `undefined` method =
 * the module did not bind the handler (FMD2 checks `Assigned(OnX)`).
 */
export interface ChapterModuleHooks {
  /** `DoTaskStart` — optional; false aborts the chapter. */
  taskStart?(task: TaskWriter): Promise<boolean>;
  /** `DoGetPageNumber` — module sets task.pageNumber + task.pageLinks[]. */
  getPageNumber(task: TaskWriter, url: string): Promise<boolean>;
  /**
   * `DoGetImageURL` (the CS_GETPAGELINK phase) — module resolves the
   * real image URL for `workId` by writing task.pageLinks[workId].
   * `url` is the chapter link (FMD2 passes the chapter URL, :421-432).
   */
  getImageURL(task: TaskWriter, workId: number, url: string): Promise<boolean>;
  /**
   * `DoBeforeDownloadImage` (:328-348) — side-effect/rewrite hook. FMD2
   * pushes URL push-only (never read back); the fmd-web seam returns
   * the (possibly rewritten) download URL — undefined keeps `url`.
   */
  beforeDownloadImage?(workId: number, url: string): Promise<string | undefined>;
  /**
   * `DoSaveImage` (:382-392) — returns the saved path; '' = failure.
   * Receives PATH + FILENAME + the fetched image (FMD2 reaches the same
   * bytes via the HTTP global). Absent → the host default writer.
   */
  saveImage?(dir: string, fileName: string, image: FetchedImage): Promise<string>;
  /** `DoAfterImageSaved` (:408-410) — false fails the image. */
  afterImageSaved?(savedPath: string): Promise<boolean>;
}

/**
 * The module-writable TASK view (LuaDownloadTask.pas:21-32): the module
 * writes image URLs / filenames through these arrays; the host syncs
 * into the ChapterPipeline after each event.
 */
export interface TaskWriter {
  /** PageLinks — real URLs and 'W'/'D' markers, index = workId. */
  readonly pageLinks: string[];
  /** PageContainerLinks (container-override URLs, DownloadImage :375-379). */
  readonly pageContainerLinks: string[];
  /** Optional module-written filenames (§7.1 assembly order). */
  readonly fileNames: string[];
  /** PageNumber — module writes the page count. */
  pageNumber: number;
  /** The chapter link (read-only for the module). */
  readonly link: string;
}

/** Result of one image download hop (transport view). */
export interface ImageFetchResult {
  /** A response was read (any status); false on transport error. */
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** True when the fetch was aborted by job cancellation (§4). */
  readonly cancelled: boolean;
}

/**
 * The per-image HTTP download step (§7.1: AcceptImage header set,
 * per-site limiter, retry budget; FMD2 `HTTP.Reset; HTTP.AcceptImage;
 * HTTP.GET(workURL)`, :367-378).
 */
export interface ImageDownloader {
  download(url: string): Promise<ImageFetchResult>;
}

/** Cancellation handle (§4: job flag → HTTP.Terminated → aborts). */
export interface CancelToken {
  readonly cancelled: boolean;
  readonly reason: string | undefined;
  readonly signal: AbortSignal;
  cancel(reason?: string): void;
}
