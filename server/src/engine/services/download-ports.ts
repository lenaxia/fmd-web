/**
 * The §7.1 download-event ports (DESIGN §7.1) — MOVED inside the engine
 * (engine-boundary story, tsk-linear-varnish-restricts): the module-side
 * hooks surface is ENGINE domain (each method maps one FMD2 Do*
 * dispatcher, LuaWebsiteModules.pas), so the port lives engine-side and
 * crosses to the jobs layer through the facade. `jobs/download/types.ts`
 * re-exports these; the job runner codes against them, the engine's
 * download-hooks service implements them, and a substitute substrate
 * implements them without touching jobs code.
 */
import type { PipelineWorkId } from '../pipeline/chapter-pipeline.js';

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
   * pushes URL push-only; the module may still rewrite the slot via
   * TASK.PageLinks[WORKID-1] (read back through the seam) and its HTTP
   * header side effects (Referer etc.) ride the seam's header map for
   * the image fetch — undefined keeps `url` and the default header set.
   */
  beforeDownloadImage?(
    workId: number,
    url: string,
  ): Promise<{ url?: string; headers?: Record<string, string> } | undefined>;
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
  download(url: string, extraHeaders?: Readonly<Record<string, string>>): Promise<ImageFetchResult>;
}

/** Cancellation handle (§4: job flag → HTTP.Terminated → aborts). */
export interface CancelToken {
  readonly cancelled: boolean;
  readonly reason: string | undefined;
  readonly signal: AbortSignal;
  cancel(reason?: string): void;
}

/** Re-exported alongside the ports (jobs' pool types reference it). */
export type { PipelineWorkId };
