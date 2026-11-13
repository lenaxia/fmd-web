import {
  CHAPTER_DONE,
  CHAPTER_FAILED,
  CHAPTER_PENDING,
  PAGE_LINK_DONE,
  PAGE_LINK_DYNAMIC,
  PAGE_LINK_WAITING,
  isDoneMarker,
  isDynamicMarker,
  isWaitingMarker,
} from './markers.js';

/**
 * ChapterPipeline — the fmd-web equivalent of FMD2's TTaskThread +
 * TTaskContainer PageLinks bookkeeping for ONE chapter
 * (uDownloadsManager.pas Execute :1130-1330, GetWorkId scans :902-969,
 * DownloadImage markers :350-407). It owns the 'W'/'D' PageLinks state —
 * the resume contract the image workers and Phase-3 pipeline build on.
 */

/** Work handed to a page-link resolver / image worker. */
export type PipelineWorkId = number;

/** Sentinel for "no more work" (FMD2 `GetWorkId` returns -1). */
export const NO_WORK: PipelineWorkId = -1;

export class ChapterPipeline {
  /** The PageLinks state — the persisted resume state of the chapter. */
  readonly pageLinks: string[] = [];
  /** The page-container links (override URLs for container-based sites, :375-379). */
  readonly pageContainerLinks: string[] = [];
  /** ChapterLinks-aligned chapter status (ChaptersStatus, :1119-1318). */
  readonly chaptersStatus: string[] = [];

  pageNumber = 0;
  private workCounter = 0;
  private downCounter = 0;

  /**
   * After DoGetPageNumber (:849-856): adopt the fetched links (trimmed),
   * then pad to the reported PageNumber with `'W'`. Fails when the module
   * reported no pages (success := False branch).
   */
  prepareFromPageNumber(fetchedLinks: readonly string[], pageNumber: number): boolean {
    if (!(pageNumber > 0)) {
      return false;
    }
    this.pageLinks.length = 0;
    for (const link of fetchedLinks) {
      this.pageLinks.push(link.trim());
    }
    while (this.pageLinks.length < pageNumber) {
      this.pageLinks.push(PAGE_LINK_WAITING);
    }
    this.pageNumber = pageNumber;
    return true;
  }

  /**
   * Fresh chapter with no page links (:1205-1211): one `'W'` placeholder,
   * PageNumber := PageLinks.Count.
   */
  preparePlaceholder(): void {
    this.pageLinks.length = 0;
    this.pageLinks.push(PAGE_LINK_WAITING);
    this.pageNumber = this.pageLinks.length;
  }

  /**
   * Resume reconciliation — CheckForExists (:1040-1063): a file on disk
   * marks the slot `'D'` (recount); a `'D'` slot without its file goes
   * back to `'W'` (or `'G'` for dynamic modules). Returns how many slots
   * were newly marked done.
   */
  reconcileWithFiles(fileExists: (workId: number) => boolean, dynamicPageLink = false): number {
    let newlyDone = 0;
    for (let i = 0; i < this.pageLinks.length; i += 1) {
      const marker = this.pageLinks[i] ?? '';
      if (fileExists(i)) {
        if (!isDoneMarker(marker)) {
          newlyDone += 1;
        }
        this.pageLinks[i] = PAGE_LINK_DONE;
      } else if (isDoneMarker(marker)) {
        this.pageLinks[i] = dynamicPageLink ? PAGE_LINK_DYNAMIC : PAGE_LINK_WAITING;
      } else if (isDynamicMarker(marker)) {
        this.pageLinks[i] = dynamicPageLink ? PAGE_LINK_DYNAMIC : PAGE_LINK_WAITING;
      }
    }
    return newlyDone;
  }

  /** CheckForPrepare (:994-1012): any slot still waiting for its real URL. */
  needsPagelinkPhase(): boolean {
    return this.pageLinks.some((marker) => isWaitingMarker(marker));
  }

  /** Phase prologue (:1181-1182, :1224-1225): the counters reset per phase. */
  beginPhase(): void {
    this.workCounter = 0;
    this.downCounter = 0;
  }

  /**
   * CS_GETPAGELINK scan — InternalGetPageLinkWorkId (:930-949): hand out
   * waiting slots; already-resolved slots are counted as done (the recount
   * that drives Progress). Returns NO_WORK when exhausted.
   */
  nextPagelinkWork(): PipelineWorkId {
    while (this.workCounter < this.pageLinks.length) {
      const workId = this.workCounter;
      this.workCounter += 1;
      const marker = this.pageLinks[workId] ?? '';
      if (isWaitingMarker(marker) || isDynamicMarker(marker)) {
        return workId;
      }
      this.downCounter += 1;
    }
    return NO_WORK;
  }

  /**
   * Page-link result (:1236-1243): an empty resolution means the module
   * script produced nothing — the slot goes back to `'W'`; otherwise the
   * real URL replaces the marker.
   */
  applyPagelink(workId: number, url: string): void {
    const trimmed = url.trim();
    this.pageLinks[workId] = trimmed === '' ? PAGE_LINK_WAITING : trimmed;
  }

  /**
   * CS_DOWNLOAD scan — InternalGetDownloadWorkId (:951-968): hand out every
   * slot that is not `'D'` (waiting slots included — DownloadImage's marker
   * short-circuits decide at execution time); `'D'` slots are counted.
   */
  nextDownloadWork(): PipelineWorkId {
    while (this.workCounter < this.pageLinks.length) {
      const workId = this.workCounter;
      this.workCounter += 1;
      const marker = this.pageLinks[workId] ?? '';
      if (!isDoneMarker(marker)) {
        return workId;
      }
      this.downCounter += 1;
    }
    return NO_WORK;
  }

  /** DownloadImage success (:407): `PageLinks[WorkId] := 'D'`. */
  markDone(workId: number): void {
    this.pageLinks[workId] = PAGE_LINK_DONE;
  }

  /** The trimmed PageLinks entry (DownloadImage :351). */
  workUrl(workId: number): string {
    return (this.pageLinks[workId] ?? '').trim();
  }

  /**
   * The container-link override (DownloadImage :375-379): when
   * `PageNumber = PageContainerLinks.Count` and `WorkId < Count`, the
   * container link replaces the work URL.
   */
  effectiveUrl(workId: number): string {
    const base = this.workUrl(workId);
    if (
      this.pageNumber === this.pageContainerLinks.length &&
      workId < this.pageContainerLinks.length
    ) {
      const override = (this.pageContainerLinks[workId] ?? '').trim();
      if (override !== '') {
        return override;
      }
    }
    return base;
  }

  /** CheckForFinish (:1067-1111): slots that would keep the chapter from finishing. */
  missingCount(): number {
    return this.pageLinks.filter((marker) => !isDoneMarker(marker)).length;
  }

  isFinished(): boolean {
    return this.pageLinks.length > 0 && this.missingCount() === 0;
  }

  /** The `%d/%d` progress pair (DoSuccess :450-458). */
  progress(): { readonly done: number; readonly total: number } {
    return { done: this.downCounter, total: this.pageNumber };
  }

  /**
   * Chapter-level resume skip (:1133-1136): advance past `'D'` chapters.
   * Returns the first pending index, or NO_WORK when every chapter is done.
   */
  firstPendingChapter(): PipelineWorkId {
    let ptr = 0;
    while (ptr < this.chaptersStatus.length && this.chaptersStatus[ptr] === CHAPTER_DONE) {
      ptr += 1;
    }
    return ptr < this.chaptersStatus.length ? ptr : NO_WORK;
  }

  /** ChaptersStatus upkeep (:1119-1122): pad to the chapter count with `'P'`. */
  ensureChapterStatus(chapterCount: number): void {
    while (this.chaptersStatus.length < chapterCount) {
      this.chaptersStatus.push(CHAPTER_PENDING);
    }
  }

  markChapterDone(index: number): void {
    this.chaptersStatus[index] = CHAPTER_DONE;
  }

  markChapterFailed(index: number): void {
    this.chaptersStatus[index] = CHAPTER_FAILED;
  }
}
