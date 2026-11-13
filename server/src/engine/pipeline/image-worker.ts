import { PAGE_LINK_WAITING, isDoneMarker, isWaitingMarker } from './markers.js';
import { ChapterPipeline } from './chapter-pipeline.js';

/**
 * ImageWorker — the fmd-web equivalent of `TDownloadThread.DownloadImage`
 * (uDownloadsManager.pas:350-407). The 'W'/'D' PageLinks marker semantics
 * ARE the resume contract:
 *
 *   workURL := Trim(PageLinks[WorkId]);
 *   ''  → PageLinks[WorkId] := 'W'; Exit(False)   // resolve first
 *   'W' → Exit(False)                              // not resolved yet
 *   'D' → Exit(True)                               // already downloaded
 *   ...download + save; on success PageLinks[WorkId] := 'D' and
 *      OnAfterImageSaved runs.
 *
 * The full pipeline (HTTP, file IO, anti-bot) lands in Phase 3 — this is
 * the typed abstraction with injected hooks, so the marker semantics can
 * be unit-tested in isolation.
 */

export type ImageWorkResult =
  | { readonly kind: 'skipped-waiting'; readonly marked: boolean }
  | { readonly kind: 'skipped-done' }
  | { readonly kind: 'downloaded'; readonly savedPath: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** The FMD2 download-thread collaborators, injected for testability. */
export interface ImageWorkerHooks {
  /** OnDownloadImage, or HTTP.GET when the module has no handler (:373-378). */
  downloadImage(url: string): boolean;
  /** OnSaveImage / SaveImageStreamToFile (:382-392) — '' means failure. */
  saveImage(workId: number, url: string): string;
  /** OnBeforeDownloadImage (:370-371) — called for side effects; FMD2's
   *  Result is unconditionally overwritten by the download step. */
  beforeDownloadImage?(url: string): boolean;
  /** OnAfterImageSaved (:408-410) — its result is DownloadImage's Result. */
  afterImageSaved?(savedPath: string): boolean;
  /** Terminated / HTTP.Terminated check (:403). */
  terminated?(): boolean;
}

export class ImageWorker {
  constructor(
    private readonly pipeline: ChapterPipeline,
    private readonly hooks: ImageWorkerHooks,
  ) {}

  /**
   * One DownloadImage attempt for `workId` — the :350-407 marker contract.
   * Never throws: hook failures surface as `{kind:'failed'}`.
   */
  processImage(workId: number): ImageWorkResult {
    const workUrl = this.pipeline.workUrl(workId);

    // :352-355 — empty slot: mark 'W' and skip (the page link must be
    // resolved by the CS_GETPAGELINK phase first)
    if (workUrl === '') {
      this.pipeline.pageLinks[workId] = PAGE_LINK_WAITING;
      return { kind: 'skipped-waiting', marked: true };
    }
    // :356-357 — already waiting: nothing to do
    if (isWaitingMarker(workUrl)) {
      return { kind: 'skipped-waiting', marked: false };
    }
    // :358-359 — already downloaded: skip with success (the resume recount)
    if (isDoneMarker(workUrl)) {
      return { kind: 'skipped-done' };
    }

    if (this.hooks.terminated?.() === true) {
      return { kind: 'failed', reason: 'terminated' };
    }

    // :375-379 — the container-link override
    const url = this.pipeline.effectiveUrl(workId);

    try {
      // :370-371 — OnBeforeDownloadImage (side-effect hook; FMD2 ignores
      // its Result — the download result below overwrites it)
      this.hooks.beforeDownloadImage?.(url);

      // :373-378 — OnDownloadImage, else HTTP.GET
      const downloaded = this.hooks.downloadImage(url);
      if (!downloaded) {
        return { kind: 'failed', reason: 'download failed' };
      }

      // :382-392 — OnSaveImage / SaveImageStreamToFile; '' = failure
      const savedPath = this.hooks.saveImage(workId, url);
      if (savedPath === '') {
        return { kind: 'failed', reason: 'save failed' };
      }

      // :403-404 — FileExists(savedFilename) re-check
      if (this.hooks.terminated?.() === true) {
        return { kind: 'failed', reason: 'terminated after save' };
      }

      // :406-410 — success: mark 'D', then OnAfterImageSaved decides the result
      this.pipeline.markDone(workId);
      const after = this.hooks.afterImageSaved?.(savedPath) ?? true;
      return after
        ? { kind: 'downloaded', savedPath }
        : { kind: 'failed', reason: 'afterImageSaved returned false' };
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
