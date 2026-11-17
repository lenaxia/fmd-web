import { existsSync } from 'node:fs';
import { ChapterPipeline, NO_WORK } from '../../engine/facade.js';
import { PAGE_LINK_WAITING, isDoneMarker, isWaitingMarker } from '../../engine/facade.js';
import type { PipelineWorkId } from '../../engine/facade.js';
import { composeFileName } from './filenames.js';
import { findImageFile, saveImageStreamToFile } from './image-files.js';
import { ModuleImageDownloader } from '../../engine/facade.js';
import type {
  CancelToken,
  ChapterModuleHooks,
  ImageDownloader,
  ImageWorkerPool,
  SiteLimiter,
  TaskWriter,
} from './types.js';

/** §5.8 + §7.1 boundary: engine-harvested links may be host-removed
 * (uData.pas:64 — isRemoveHostFromChapterLinks defaults True, so
 * /api/info and the page links the module writes are origin-relative).
 * The runner is the fetch boundary — resolve every link it dispatches
 * or downloads against the chapter's absolute base (the manga URL).
 * Absolute links pass through; '' stays '' (FMD2 empty-link semantics). */
function resolveUrl(link: string, base: string): string {
  if (link === '' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link)) {
    return link;
  }
  try {
    return new URL(link, base).href;
  } catch {
    return link;
  }
}

/**
 * The §7.1 chapter pipeline (DESIGN.md; FMD2 `TTaskThread.Execute`,
 * uDownloadsManager.pas:975-1340): TaskStart? → GetPageNumber (module
 * sets TASK.PageNumber + PageLinks[]) → host iterates WorkId honoring
 * 'W'/'D' markers (CS_GETPAGELINK resolves waiting slots via
 * GetImageURL; CS_DOWNLOAD downloads the rest) → per image:
 * BeforeDownloadImage → HTTP download (AcceptImage set; per-site
 * limiter; per-image retry budget) → SaveImage/default writer → file
 * write → AfterImageSaved(FILENAME). Assembly keeps module FileNames[]
 * order (workId-aligned savedFiles). Cancellation: the job flag →
 * HTTP.Terminated semantics (in-flight aborts, queued limiter waiters
 * and pool items fail fast, §4). 'W'/'D' markers persist through the
 * injectable persistMarkers hook — the resume contract.
 */

export type DownloadChapterState = 'done' | 'cancelled' | 'failed';

export interface DownloadChapterFailure {
  readonly workId: number;
  readonly reason: string;
}

export interface DownloadChapterResult {
  readonly state: DownloadChapterState;
  /** PageLinks marked 'D' (downloaded or resumed from disk). */
  readonly done: number;
  readonly total: number;
  /** Saved paths aligned to WorkId / FileNames[] order ('' = missing). */
  readonly savedFiles: readonly string[];
  readonly failures: readonly DownloadChapterFailure[];
  readonly reason?: string;
}

export interface DownloadChapterOptions {
  readonly moduleId: string;
  readonly mangaUrl: string;
  readonly chapterLink: string;
  readonly chapterName?: string;
  /** Chapter working dir (PATH for SaveImage). */
  readonly workDir: string;
  /** The custom-rename template ('' = '%FILENAME%', :1112-1114). */
  readonly customFileNameTemplate?: string;
  /** CurrentMaxFileNameLength (0 = no limit, D5). */
  readonly maxFileNameLength?: number;
  /** MaxThreadPerTaskLimit (FMD2 default 1; pool bound). */
  readonly maxThreadPerTaskLimit?: number;
  /** DynamicPageLink: skip the pagelink phase (re-resolve every run). */
  readonly dynamicPageLink?: boolean;
  /** Persisted 'W'/'D' markers loaded from the previous attempt. */
  readonly resumeMarkers?: readonly string[];
  /** Called whenever a marker changes (persist the resume contract). */
  readonly persistMarkers?: (pageLinks: readonly string[]) => void;
  /**
   * Downloads parity: called after each NEWLY downloaded image is
   * saved (workId + byte length) — the lane's transfer-rate source.
   */
  readonly onImageSaved?: (workId: number, byteLength: number) => void;
  /** Extra request headers (module-set, e.g. Referer). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Downloader override (tests); default ModuleImageDownloader. */
  readonly downloader?: ImageDownloader;
  /** Per-image retry budget (transport/5xx). */
  readonly imageRetryBudget?: number;
}

export interface DownloadChapterDeps {
  readonly module: ChapterModuleHooks;
  readonly pool: ImageWorkerPool;
  readonly limiter: SiteLimiter;
}

export class JobCancelToken implements CancelToken {
  private flag = false;
  private why: string | undefined;
  private readonly controller = new AbortController();

  get cancelled(): boolean {
    return this.flag;
  }

  get reason(): string | undefined {
    return this.why;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason?: string): void {
    if (!this.flag) {
      this.flag = true;
      this.why = reason ?? 'cancelled';
      this.controller.abort(new Error(this.why));
    }
  }
}

export class DownloadChapterRunner {
  readonly cancelToken = new JobCancelToken();
  private readonly downloader: ImageDownloader;
  private readonly maxThreads: number;

  constructor(
    private readonly deps: DownloadChapterDeps,
    private readonly options: DownloadChapterOptions,
  ) {
    this.maxThreads = Math.max(1, Math.trunc(options.maxThreadPerTaskLimit ?? 1));
    this.downloader =
      options.downloader ??
      new ModuleImageDownloader({
        limiter: deps.limiter,
        cancel: this.cancelToken,
        ...(options.imageRetryBudget !== undefined
          ? { retryCount: options.imageRetryBudget }
          : {}),
        ...(options.extraHeaders !== undefined ? { extraHeaders: options.extraHeaders } : {}),
      });
  }

  /** §4 cancellation: job flag → in-flight aborts + queued fail fast. */
  cancel(reason?: string): void {
    this.cancelToken.cancel(reason);
    this.deps.limiter.cancelAll();
  }

  async run(): Promise<DownloadChapterResult> {
    const pipeline = new ChapterPipeline();
    const failures: DownloadChapterFailure[] = [];
    const savedFiles: string[] = [];
    const writer: TaskWriter = {
      pageLinks: [],
      pageContainerLinks: [],
      fileNames: [],
      pageNumber: 0,
      link: this.options.chapterLink,
    };
    const persist = (): void => {
      this.options.persistMarkers?.(pipeline.pageLinks);
    };
    const cancelledResult = (reason: string): DownloadChapterResult => {
      persist();
      return this.result(pipeline, savedFiles, failures, 'cancelled', reason);
    };

    // 1. TaskStart? (DoTaskStart; optional handler)
    if (this.deps.module.taskStart !== undefined) {
      const started = await this.deps.module.taskStart(writer);
      if (!started) {
        return this.result(pipeline, savedFiles, failures, 'failed', 'TaskStart returned false');
      }
      if (this.cancelToken.cancelled) {
        return cancelledResult(this.cancelToken.reason ?? 'cancelled');
      }
    }

    // 2. GetPageNumber — module sets TASK.PageNumber + PageLinks[]
    const chapterUrl = resolveUrl(this.options.chapterLink, this.options.mangaUrl);
    const gotPages = await this.deps.module.getPageNumber(writer, chapterUrl);
    if (!gotPages) {
      return this.result(pipeline, savedFiles, failures, 'failed', 'GetPageNumber failed');
    }
    if (!pipeline.prepareFromPageNumber(writer.pageLinks, writer.pageNumber)) {
      return this.result(pipeline, savedFiles, failures, 'failed', 'GetPageNumber produced no pages');
    }
    // PageNumber := PageLinks.Count (:1196-1198) + container-link adoption
    pipeline.pageNumber = pipeline.pageLinks.length;
    for (const containerLink of writer.pageContainerLinks) {
      pipeline.pageContainerLinks.push(containerLink.trim());
    }

    // 3. resume: overlay persisted 'D' markers, then CheckForExists
    //    (:1040-1063 — files on disk are the truth)
    const markers = this.options.resumeMarkers;
    if (markers !== undefined) {
      const shared = Math.min(markers.length, pipeline.pageLinks.length);
      for (let i = 0; i < shared; i += 1) {
        if (markers[i] === 'D') {
          pipeline.pageLinks[i] = 'D';
        }
      }
    }
    const fileNameFor = (workId: number): string =>
      composeFileName(
        workId,
        writer.fileNames,
        pipeline.pageNumber,
        this.options.customFileNameTemplate ?? '',
        this.options.maxFileNameLength ?? 0,
      );
    pipeline.reconcileWithFiles(
      (workId) => findImageFile(this.options.workDir, fileNameFor(workId)) !== '',
      this.options.dynamicPageLink ?? false,
    );
    // assembly completeness: every already-done slot contributes its
    // on-disk file (the Compress phase packs the whole chapter,
    // uDownloadsManager.pas:552+ FindImageFile-based file list)
    for (let workId = 0; workId < pipeline.pageLinks.length; workId += 1) {
      if (isDoneMarker(pipeline.pageLinks[workId] ?? '')) {
        const existing = findImageFile(this.options.workDir, fileNameFor(workId));
        if (existing !== '') {
          savedFiles[workId] = existing;
        }
      }
    }

    // 4. CS_GETPAGELINK phase (:1230-1250) — resolve waiting slots
    pipeline.beginPhase();
    if (!this.options.dynamicPageLink && pipeline.needsPagelinkPhase()) {
      const pagelinkIds = this.drain(() => pipeline.nextPagelinkWork());
      const poolFailures = await this.deps.pool.run(
        pagelinkIds,
        this.maxThreads,
        async (workId) => {
          if (this.cancelToken.cancelled) {
            return;
          }
          const resolved = await this.deps.module.getImageURL(
            writer,
            workId,
            chapterUrl,
          );
          if (resolved) {
            pipeline.applyPagelink(workId, writer.pageLinks[workId] ?? '');
          }
          persist();
        },
        () => this.cancelToken.cancelled,
      );
      failures.push(...poolFailures.map((f) => ({ workId: f.workId, reason: `getImageURL: ${f.error}` })));
      if (this.cancelToken.cancelled) {
        return cancelledResult(this.cancelToken.reason ?? 'cancelled');
      }
    }

    // 5. CS_DOWNLOAD phase (:1268-1296 — `WorkCounter := 0; DownCounter := 0`
    //    at the phase transition) — per image:
    //    BeforeDownloadImage → HTTP download → SaveImage → file →
    //    AfterImageSaved
    pipeline.beginPhase();
    const downloadIds = this.drain(() => pipeline.nextDownloadWork());
    const poolFailures = await this.deps.pool.run(
      downloadIds,
      this.maxThreads,
      (workId) => this.processImage(pipeline, fileNameFor(workId), savedFiles, failures, workId, chapterUrl),
      () => this.cancelToken.cancelled,
    );
    failures.push(...poolFailures.map((f) => ({ workId: f.workId, reason: f.error })));
    persist();

    // 6. verdict (CheckForFinish :1067-1111)
    if (pipeline.isFinished()) {
      return this.result(pipeline, savedFiles, failures, 'done', undefined);
    }
    if (this.cancelToken.cancelled) {
      return cancelledResult(this.cancelToken.reason ?? 'cancelled');
    }
    return this.result(pipeline, savedFiles, failures, 'failed', 'not all images downloaded');
  }

  /** One DownloadImage attempt (uDownloadsManager.pas:334-412, async). */
  private async processImage(
    pipeline: ChapterPipeline,
    fileName: string,
    savedFiles: string[],
    failures: DownloadChapterFailure[],
    workId: number,
    chapterUrl: string,
  ): Promise<void> {
    const fail = (reason: string): void => {
      failures.push({ workId, reason });
    };

    // :351-359 — the marker short-circuits
    const workUrl = pipeline.workUrl(workId);
    if (workUrl === '') {
      pipeline.pageLinks[workId] = PAGE_LINK_WAITING;
      return;
    }
    if (isWaitingMarker(workUrl)) {
      return; // unresolved pagelink — failed slot (chapter finishes not done)
    }
    if (isDoneMarker(workUrl)) {
      return;
    }
    if (this.cancelToken.cancelled) {
      return; // queued-but-unstarted → fail fast (§4)
    }

    const url = resolveUrl(pipeline.effectiveUrl(workId), chapterUrl);

    // resume probe — FindImageFile (the image already on disk)
    const existing = findImageFile(this.options.workDir, fileName);
    if (existing !== '') {
      pipeline.markDone(workId);
      savedFiles[workId] = existing;
      this.options.persistMarkers?.(pipeline.pageLinks);
      return;
    }

    try {
      // :370-371 — OnBeforeDownloadImage (URL rewrite via the seam return)
      const rewritten = await this.deps.module.beforeDownloadImage?.(workId, url);
      if (this.cancelToken.cancelled) {
        return;
      }
      const targetUrl = rewritten === undefined || rewritten === '' ? url : rewritten;

      // :373-378 — HTTP.GET (AcceptImage + limiter + retry inside)
      const fetched = await this.downloader.download(targetUrl);
      if (fetched.cancelled) {
        return; // §4 aborted in-flight
      }
      if (!fetched.ok || fetched.bytes.length === 0) {
        fail(`download failed (${fetched.status})`);
        return;
      }

      // :382-392 — OnSaveImage, else SaveImageStreamToFile
      const savedPath =
        (await this.deps.module.saveImage?.(this.options.workDir, fileName, {
          bytes: fetched.bytes,
          contentType: fetched.contentType,
        })) ?? saveImageStreamToFile(this.options.workDir, fileName, fetched.bytes, fetched.contentType);
      if (savedPath === '') {
        fail('save failed');
        return;
      }
      // :403-404 — FileExists(savedFilename) re-check
      if (!existsSync(savedPath)) {
        fail('saved file missing');
        return;
      }

      // :406-410 — PageLinks[WorkId] := 'D', then OnAfterImageSaved
      pipeline.markDone(workId);
      savedFiles[workId] = savedPath;
      this.options.persistMarkers?.(pipeline.pageLinks);
      // Downloads parity: per-image byte tick — the lane's transfer-rate
      // meter feeds on these (NEW downloads only; resumed-from-disk
      // images transfer nothing).
      this.options.onImageSaved?.(workId, fetched.bytes.length);
      const after = await this.deps.module.afterImageSaved?.(savedPath);
      if (after === false) {
        fail('afterImageSaved returned false');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  private drain(next: () => PipelineWorkId): PipelineWorkId[] {
    const ids: PipelineWorkId[] = [];
    for (;;) {
      const id = next();
      if (id === NO_WORK) {
        return ids;
      }
      ids.push(id);
    }
  }

  private result(
    pipeline: ChapterPipeline,
    savedFiles: string[],
    failures: DownloadChapterFailure[],
    state: DownloadChapterState,
    reason: string | undefined,
  ): DownloadChapterResult {
    const done = pipeline.pageLinks.filter((marker) => isDoneMarker(marker)).length;
    for (let i = 0; i < pipeline.pageLinks.length; i += 1) {
      // sparse-array holes (parallel completion order) assemble as ''
      if (savedFiles[i] === undefined) {
        savedFiles[i] = '';
      }
    }
    return {
      state,
      done,
      total: pipeline.pageLinks.length,
      savedFiles,
      failures,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}
