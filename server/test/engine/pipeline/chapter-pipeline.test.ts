import { describe, expect, it } from 'vitest';
import { ChapterPipeline, NO_WORK } from '../../../src/engine/pipeline/chapter-pipeline.js';
import type { ImageWorkerHooks } from '../../../src/engine/pipeline/image-worker.js';
import { ImageWorker } from '../../../src/engine/pipeline/image-worker.js';
import {
  CHAPTER_DONE,
  CHAPTER_PENDING,
  PAGE_LINK_DONE,
  PAGE_LINK_DYNAMIC,
  PAGE_LINK_WAITING,
  isReadyMarker,
  isWaitingMarker,
} from '../../../src/engine/pipeline/markers.js';

/**
 * 'W'/'D' PageLinks marker semantics (uDownloadsManager.pas:350-407,
 * :930-968, :1040-1111) unit-tested on the ChapterPipeline/ImageWorker
 * abstractions — the resume contract: skip (markers short-circuit),
 * resume (padding, reconcile-with-files, chapter skip), recount (skipped
 * work counts toward progress), finish (missing count).
 */

describe('ChapterPipeline — prepare + padding (uDownloadsManager.pas:849-856)', () => {
  it('pads PageLinks to PageNumber with W and trims fetched links', () => {
    const pipeline = new ChapterPipeline();
    const ok = pipeline.prepareFromPageNumber([' a.jpg ', 'b.jpg'], 5);

    expect(ok).toBe(true);
    expect(pipeline.pageLinks).toEqual(['a.jpg', 'b.jpg', 'W', 'W', 'W']);
    expect(pipeline.pageNumber).toBe(5);
    expect(isWaitingMarker('W')).toBe(true);
    expect(isWaitingMarker('')).toBe(true); // '' behaves like 'W' (:994)
    expect(isReadyMarker('https://x/a.jpg')).toBe(true);
  });

  it('fails preparation when the module reports zero pages', () => {
    const pipeline = new ChapterPipeline();
    expect(pipeline.prepareFromPageNumber([], 0)).toBe(false);
    expect(pipeline.pageLinks).toEqual([]);
  });

  it('accepts links with PageNumber unset — FanFox newImgs shape (:1196-1198)', () => {
    const pipeline = new ChapterPipeline();
    // modules that fill TASK.PageLinks directly may legally leave
    // PageNumber at 0; FMD2 assigns PageNumber := PageLinks.Count right
    // after DoGetPageNumber (the runner does the same)
    const ok = pipeline.prepareFromPageNumber(['//h/1.jpg', '//h/2.jpg', '//h/3.jpg', '//h/4.jpg'], 0);
    expect(ok).toBe(true);
    expect(pipeline.pageLinks).toEqual(['//h/1.jpg', '//h/2.jpg', '//h/3.jpg', '//h/4.jpg']);
  });

  it('no links but PageNumber declared → all-W placeholders (dynamic GetImageURL flow)', () => {
    const pipeline = new ChapterPipeline();
    expect(pipeline.prepareFromPageNumber([], 3)).toBe(true);
    expect(pipeline.pageLinks).toEqual(['W', 'W', 'W']);
  });

  it('a fresh chapter without page links gets one W placeholder (:1205-1211)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.preparePlaceholder();
    expect(pipeline.pageLinks).toEqual(['W']);
    expect(pipeline.pageNumber).toBe(1);
  });
});

describe('ChapterPipeline — CS_GETPAGELINK scan (:930-949)', () => {
  it('hands out only waiting slots and counts resolved slots (recount)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 4);
    pipeline.pageLinks[2] = 'https://x/3.jpg'; // already resolved on resume
    pipeline.beginPhase();

    // slot 0 holds a real URL → skipped and counted; slots 1, 3 are 'W'
    expect(pipeline.nextPagelinkWork()).toBe(1);
    expect(pipeline.nextPagelinkWork()).toBe(3);
    expect(pipeline.nextPagelinkWork()).toBe(NO_WORK);
    expect(pipeline.progress()).toEqual({ done: 2, total: 4 }); // slots 0+2 recounted
  });

  it('re-marks empty pagelink resolutions as W (:1236-1243)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber([], 3);
    pipeline.applyPagelink(0, ' https://x/1.jpg ');
    pipeline.applyPagelink(1, '   '); // "some script return ''" (:1236)
    pipeline.applyPagelink(2, '');

    expect(pipeline.pageLinks[0]).toBe('https://x/1.jpg');
    expect(pipeline.pageLinks[1]).toBe(PAGE_LINK_WAITING);
    expect(pipeline.pageLinks[2]).toBe(PAGE_LINK_WAITING);
  });

  it('needsPagelinkPhase reports whether any slot still waits (:994-1012)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 2);
    expect(pipeline.needsPagelinkPhase()).toBe(true); // slot 1 is 'W'
    pipeline.applyPagelink(1, 'https://x/2.jpg');
    expect(pipeline.needsPagelinkPhase()).toBe(false);
  });
});

describe('ChapterPipeline — CS_DOWNLOAD scan (:951-968)', () => {
  it('hands out every non-D slot; D slots are skipped and recounted', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber([], 3);
    pipeline.applyPagelink(0, 'https://x/1.jpg');
    pipeline.applyPagelink(1, 'https://x/2.jpg');
    pipeline.applyPagelink(2, 'https://x/3.jpg');
    pipeline.pageLinks[1] = PAGE_LINK_DONE; // resumed, already downloaded
    pipeline.beginPhase();

    expect(pipeline.nextDownloadWork()).toBe(0);
    expect(pipeline.nextDownloadWork()).toBe(2); // slot 1 ('D') skipped
    expect(pipeline.nextDownloadWork()).toBe(NO_WORK);
    expect(pipeline.progress()).toEqual({ done: 1, total: 3 });
  });

  it('markDone flips the slot to D (:407) and finish checks work', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber([], 2);
    pipeline.applyPagelink(0, 'https://x/1.jpg');
    pipeline.applyPagelink(1, 'https://x/2.jpg');

    expect(pipeline.isFinished()).toBe(false);
    expect(pipeline.missingCount()).toBe(2);
    pipeline.markDone(0);
    expect(pipeline.missingCount()).toBe(1);
    pipeline.markDone(1);
    expect(pipeline.isFinished()).toBe(true);
  });
});

describe('ChapterPipeline — resume reconciliation (CheckForExists :1040-1063)', () => {
  function resumedPipeline(): ChapterPipeline {
    const pipeline = new ChapterPipeline();
    // persisted state: [real url, 'D', 'D', 'W'] from a previous run
    pipeline.prepareFromPageNumber(['https://x/1.jpg', 'D', 'D', 'W'], 4);
    return pipeline;
  }

  it('marks file-exists slots D (recount) and demotes D-without-file to W', () => {
    const pipeline = resumedPipeline();
    // files on disk for slots 0 and 2 only; slot 1 claims 'D' but is gone
    const newlyDone = pipeline.reconcileWithFiles((i) => i === 0 || i === 2);

    expect(newlyDone).toBe(1); // slot 0 newly marked (slot 2 was already 'D')
    expect(pipeline.pageLinks[0]).toBe(PAGE_LINK_DONE);
    expect(pipeline.pageLinks[1]).toBe(PAGE_LINK_WAITING); // 'D' lost its file
    expect(pipeline.pageLinks[2]).toBe(PAGE_LINK_DONE);
    expect(pipeline.pageLinks[3]).toBe(PAGE_LINK_WAITING);
    expect(pipeline.missingCount()).toBe(2);
  });

  it('dynamic modules demote lost D slots to G (re-resolve every run)', () => {
    const pipeline = resumedPipeline();
    pipeline.reconcileWithFiles((i) => i === 2, true);
    expect(pipeline.pageLinks[1]).toBe(PAGE_LINK_DYNAMIC); // 'D' lost its file
    expect(pipeline.pageLinks[0]).toBe('https://x/1.jpg'); // real URL, no file: untouched
    expect(pipeline.pageLinks[2]).toBe(PAGE_LINK_DONE); // file exists → stays done
    expect(pipeline.pageLinks[3]).toBe(PAGE_LINK_WAITING); // plain 'W' stays 'W'
    // dynamic slots are handed out by the page-link scan again
    pipeline.beginPhase();
    expect(pipeline.nextPagelinkWork()).toBe(1);
    expect(pipeline.nextPagelinkWork()).toBe(3);
  });

  it('G demotes back to W for non-dynamic modules', () => {
    const pipeline = resumedPipeline();
    pipeline.pageLinks[1] = PAGE_LINK_DYNAMIC;
    pipeline.reconcileWithFiles(() => false, false);
    expect(pipeline.pageLinks[1]).toBe(PAGE_LINK_WAITING);
  });
});

describe('ChapterPipeline — chapter-level resume (:1133-1136, :1119-1318)', () => {
  it('pads chapter status with P and skips already-done chapters', () => {
    const pipeline = new ChapterPipeline();
    pipeline.ensureChapterStatus(4);
    expect(pipeline.chaptersStatus).toEqual(['P', 'P', 'P', 'P']);
    pipeline.markChapterDone(0);
    pipeline.markChapterDone(1);
    pipeline.markChapterFailed(2);

    expect(pipeline.firstPendingChapter()).toBe(2); // 'D' chapters skipped
    pipeline.markChapterDone(2);
    expect(pipeline.firstPendingChapter()).toBe(3);
    pipeline.markChapterDone(3);
    expect(pipeline.firstPendingChapter()).toBe(NO_WORK);
    expect(CHAPTER_PENDING).toBe('P');
    expect(CHAPTER_DONE).toBe('D');
  });
});

describe('ImageWorker — DownloadImage marker contract (:350-407)', () => {
  function makeWorker(
    pipeline: ChapterPipeline,
    hooks: Partial<ImageWorkerHooks> = {},
  ): { worker: ImageWorker; calls: string[] } {
    const calls: string[] = [];
    const worker = new ImageWorker(pipeline, {
      downloadImage: (url) => {
        calls.push(`download:${url}`);
        return true;
      },
      saveImage: (workId) => {
        calls.push(`save:${String(workId)}`);
        return `/library/${String(workId)}.jpg`;
      },
      ...hooks,
    });
    return { worker, calls };
  }

  it('empty slot → marks W and skips without downloading (:352-355)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber([], 2);
    pipeline.pageLinks[0] = ''; // an unset slot (CheckForPrepare treats '' as waiting)
    const { worker, calls } = makeWorker(pipeline);

    const result = worker.processImage(0);
    expect(result).toEqual({ kind: 'skipped-waiting', marked: true });
    expect(pipeline.pageLinks[0]).toBe('W');
    expect(calls).toEqual([]); // no download attempted
  });

  it('W slot skips (waiting for its page link) (:356-357)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber([], 2);
    pipeline.pageLinks[0] = 'W';
    const { worker, calls } = makeWorker(pipeline);

    expect(worker.processImage(0)).toEqual({ kind: 'skipped-waiting', marked: false });
    expect(calls).toEqual([]);
  });

  it('D slot skips with success (resume recount) (:358-359)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber([], 2);
    pipeline.pageLinks[0] = 'D';
    const { worker, calls } = makeWorker(pipeline);

    expect(worker.processImage(0)).toEqual({ kind: 'skipped-done' });
    expect(calls).toEqual([]);
    expect(pipeline.isFinished()).toBe(false); // slot 1 still pending
  });

  it('a ready URL downloads, saves, marks D and runs AfterImageSaved (:370-410)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 1);
    const { worker, calls } = makeWorker(pipeline, {
      afterImageSaved: () => true,
      beforeDownloadImage: () => {
        calls.push('before');
        return false; // FMD2 discards this result (:370-378)
      },
    });

    const result = worker.processImage(0);
    expect(result).toEqual({ kind: 'downloaded', savedPath: '/library/0.jpg' });
    expect(calls).toEqual(['before', 'download:https://x/1.jpg', 'save:0']);
    expect(pipeline.pageLinks[0]).toBe('D');
    expect(pipeline.isFinished()).toBe(true);
  });

  it('a failed download leaves the slot untouched (retried by the next scan)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 1);
    const { worker } = makeWorker(pipeline, {
      downloadImage: () => false,
    });

    expect(worker.processImage(0)).toEqual({ kind: 'failed', reason: 'download failed' });
    expect(pipeline.pageLinks[0]).toBe('https://x/1.jpg'); // not 'D', retried later
    expect(pipeline.missingCount()).toBe(1);
  });

  it('a failed save fails the slot and does not mark D (:382-392)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 1);
    const { worker } = makeWorker(pipeline, {
      saveImage: () => '',
    });

    expect(worker.processImage(0)).toEqual({ kind: 'failed', reason: 'save failed' });
    expect(pipeline.pageLinks[0]).toBe('https://x/1.jpg');
  });

  it('AfterImageSaved returning false fails the slot even after marking D (:408-410)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 1);
    const { worker } = makeWorker(pipeline, {
      afterImageSaved: () => false,
    });

    expect(worker.processImage(0)).toEqual({
      kind: 'failed',
      reason: 'afterImageSaved returned false',
    });
    expect(pipeline.pageLinks[0]).toBe('D'); // FMD2 marks D before the hook
  });

  it('uses the PageContainerLinks override when counts align (:375-379)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/direct.jpg'], 1);
    pipeline.pageContainerLinks.push('https://cdn/container/0.bin');
    const { worker, calls } = makeWorker(pipeline);

    worker.processImage(0);
    expect(calls).toContain('download:https://cdn/container/0.bin');
  });

  it('a hook exception surfaces as a failed attempt, never a throw', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 1);
    const { worker } = makeWorker(pipeline, {
      downloadImage: () => {
        throw new Error('socket blew up');
      },
    });

    expect(worker.processImage(0)).toEqual({ kind: 'failed', reason: 'socket blew up' });
  });

  it('Terminated after save fails the slot (:403-404)', () => {
    const pipeline = new ChapterPipeline();
    pipeline.prepareFromPageNumber(['https://x/1.jpg'], 1);
    const { worker } = makeWorker(pipeline, {
      terminated: () => true,
    });

    expect(worker.processImage(0)).toEqual({ kind: 'failed', reason: 'terminated' });
    expect(pipeline.pageLinks[0]).toBe('https://x/1.jpg');
  });
});

describe('full resume scenario — a restart mid-chapter (skip/resume/recount)', () => {
  it('a killed run resumes: done slots skip, lost files redo, the rest download', () => {
    // Run 1: 5 pages, 3 downloaded, process killed.
    const state = new ChapterPipeline();
    state.prepareFromPageNumber([], 5);
    for (const [i, url] of ['https://x/1', 'https://x/2', 'https://x/3', 'https://x/4', 'https://x/5'].entries()) {
      state.applyPagelink(i, url);
      if (i < 3) {
        state.markDone(i);
      }
    }
    expect(state.pageLinks).toEqual(['D', 'D', 'D', 'https://x/4', 'https://x/5']);

    // Run 2: rebuild from the persisted PageLinks; files 1-3 exist on disk.
    const resumed = new ChapterPipeline();
    resumed.prepareFromPageNumber([...state.pageLinks], 5);
    const recounted = resumed.reconcileWithFiles((i) => i < 3);
    expect(recounted).toBe(0); // already 'D' — pure recount
    resumed.beginPhase();

    const downloads: string[] = [];
    const worker = new ImageWorker(resumed, {
      downloadImage: (url) => {
        downloads.push(url);
        return true;
      },
      saveImage: () => '/library/img.jpg',
    });
    for (;;) {
      const workId = resumed.nextDownloadWork();
      if (workId === NO_WORK) {
        break;
      }
      worker.processImage(workId);
    }

    expect(downloads).toEqual(['https://x/4', 'https://x/5']); // 1-3 skipped ('D')
    expect(resumed.isFinished()).toBe(true);
    expect(resumed.pageLinks).toEqual(['D', 'D', 'D', 'D', 'D']);
  });

  it('a file deleted between runs is re-resolved then re-downloaded (D → W → pagelink phase)', () => {
    const resumed = new ChapterPipeline();
    resumed.prepareFromPageNumber(['https://x/1', 'https://x/2'], 2);
    resumed.pageLinks[1] = 'D'; // claimed done, but...
    resumed.reconcileWithFiles((i) => i === 0); // ...file 2 is gone → 'W' (URL lost)
    expect(resumed.pageLinks[1]).toBe('W');

    // FMD2 resume dance: the page-link phase re-resolves waiting slots
    // (OnGetImageURL via GetLinkPageFromURL, :415-427), then downloads.
    resumed.beginPhase();
    for (;;) {
      const workId = resumed.nextPagelinkWork();
      if (workId === NO_WORK) {
        break;
      }
      resumed.applyPagelink(workId, 'https://x/2-fresh');
    }
    expect(resumed.pageLinks[1]).toBe('https://x/2-fresh');

    const downloads: string[] = [];
    const worker = new ImageWorker(resumed, {
      downloadImage: (url) => {
        downloads.push(url);
        return true;
      },
      saveImage: () => '/library/img.jpg',
    });
    resumed.beginPhase();
    for (;;) {
      const workId = resumed.nextDownloadWork();
      if (workId === NO_WORK) {
        break;
      }
      worker.processImage(workId);
    }
    expect(downloads).toEqual(['https://x/2-fresh']);
    expect(resumed.isFinished()).toBe(true);
  });
});
