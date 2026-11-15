import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FixtureMangaSite } from './fixture-site.js';
import { DownloadChapterRunner } from '../../../src/jobs/download/download-runner.js';
import { PerHostSiteLimiter } from '../../../src/jobs/download/site-limiter.js';
import { ConcurrentImageWorkerPool } from '../../../src/jobs/download/image-worker-pool.js';
import { readMarkers, writeMarkers } from '../../../src/jobs/download/marker-store.js';
import { extFromContentType } from '../../../src/jobs/download/image-files.js';
import { ACCEPT_IMAGE_VALUE } from '../../../src/engine/shims/http-headers.js';
import { mkTmpDir, rmDir } from '../helpers.js';
import type {
  ChapterModuleHooks,
  FetchedImage,
  TaskWriter,
} from '../../../src/jobs/download/types.js';

/**
 * §7.1 download-pipeline integration tests over a LOCAL fixture manga
 * site (node:http, loopback only — DESIGN §13): a recorded chapter
 * page, deterministic images, and deliberately misbehaving handlers
 * (flaky 500→200, route-changing, slow). The chapter module is the
 * §5.2 hook seam with a call log — every accepted criterion asserts a
 * different slice of the pipeline: happy-path hook order, cancel ≤
 * deadline + fail fast + 'D' persistence, resume fetch counts, the
 * per-site limiter bound under parallel chapters, URL rewrite, custom
 * SaveImage filenames, and the per-image retry budget.
 */

const PAGE_COUNT = 20;
const CHAPTER_PATH = '/manga/chapter-1';

type HookName =
  | 'taskStart'
  | 'getPageNumber'
  | 'getImageURL'
  | 'beforeDownloadImage'
  | 'saveImage'
  | 'afterImageSaved';

interface HookCall {
  readonly hook: HookName;
  readonly workId?: number;
  readonly url?: string;
  readonly fileName?: string;
  readonly savedPath?: string;
}

interface ModuleConfig {
  readonly base: string;
  readonly pageCount?: number;
  /** 'W' placeholders (pagelink phase) vs direct URLs (default: true). */
  readonly emitPlaceholders?: boolean;
  readonly bindTaskStart?: boolean;
  readonly bindBeforeDownload?: boolean;
  readonly bindSaveImage?: boolean;
  readonly bindAfterSaved?: boolean;
  readonly urlFor?: (workId: number) => string;
  readonly rewrite?: (workId: number, url: string) => string | undefined;
  readonly fileNames?: readonly string[];
  /** SaveImage returns a custom path for these composed names. */
  readonly customSaveFor?: (fileName: string) => string | undefined;
}

/** The §5.2 download-event module double with a full hook-call log. */
class HookLogModule implements ChapterModuleHooks {
  readonly log: HookCall[] = [];

  taskStart?: (task: TaskWriter) => Promise<boolean>;
  getPageNumber: (task: TaskWriter, url: string) => Promise<boolean>;
  getImageURL: (task: TaskWriter, workId: number, url: string) => Promise<boolean>;
  beforeDownloadImage?: (workId: number, url: string) => Promise<string | undefined>;
  saveImage?: (dir: string, fileName: string, image: FetchedImage) => Promise<string>;
  afterImageSaved?: (savedPath: string) => Promise<boolean>;

  private readonly pageCount: number;
  private readonly emitPlaceholders: boolean;
  private readonly urlFor: (workId: number) => string;

  constructor(cfg: ModuleConfig) {
    this.pageCount = cfg.pageCount ?? PAGE_COUNT;
    this.emitPlaceholders = cfg.emitPlaceholders ?? true;
    this.urlFor = cfg.urlFor ?? ((workId) => `${cfg.base}/img/p${workId}`);

    if (cfg.bindTaskStart !== false) {
      this.taskStart = async () => {
        this.log.push({ hook: 'taskStart' });
        return true;
      };
    }

    this.getPageNumber = async (task: TaskWriter, url: string): Promise<boolean> => {
      this.log.push({ hook: 'getPageNumber', url });
      // the recorded chapter page must be served by the fixture site
      const page = await fetch(url);
      if (!page.ok) {
        return false;
      }
      task.pageNumber = this.pageCount;
      for (let i = 0; i < this.pageCount; i += 1) {
        task.pageLinks[i] = this.emitPlaceholders ? 'W' : this.urlFor(i);
      }
      for (const name of cfg.fileNames ?? []) {
        task.fileNames.push(name);
      }
      return true;
    };

    this.getImageURL = async (task: TaskWriter, workId: number): Promise<boolean> => {
      this.log.push({ hook: 'getImageURL', workId });
      task.pageLinks[workId] = this.urlFor(workId);
      return true;
    };

    if (cfg.bindBeforeDownload !== false) {
      this.beforeDownloadImage = async (workId: number, url: string) => {
        this.log.push({ hook: 'beforeDownloadImage', workId, url });
        return cfg.rewrite?.(workId, url);
      };
    }

    if (cfg.bindSaveImage !== false) {
      this.saveImage = async (
        dir: string,
        fileName: string,
        image: FetchedImage,
      ): Promise<string> => {
        this.log.push({ hook: 'saveImage', fileName });
        const custom = cfg.customSaveFor?.(fileName);
        const target = custom ?? path.join(dir, `${fileName}.${extFromContentType(image.contentType)}`);
        writeFileSync(target, image.bytes);
        return target;
      };
    }

    if (cfg.bindAfterSaved !== false) {
      this.afterImageSaved = async (savedPath: string): Promise<boolean> => {
        this.log.push({ hook: 'afterImageSaved', savedPath });
        return true;
      };
    }
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 4000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeRunner(
  base: string,
  workDir: string,
  module: ChapterModuleHooks,
  options: {
    maxThreads?: number;
    resumeMarkers?: readonly string[];
    onMarkers?: (pageLinks: readonly string[]) => void;
  } = {},
): DownloadChapterRunner {
  const limiter = new PerHostSiteLimiter();
  limiter.setHostLimit(new URL(base).host, 3);
  return new DownloadChapterRunner(
    { module, pool: new ConcurrentImageWorkerPool(), limiter },
    {
      moduleId: 'fixturesite',
      mangaUrl: `${base}/`,
      chapterLink: `${base}${CHAPTER_PATH}`,
      workDir,
      maxThreadPerTaskLimit: options.maxThreads ?? 1,
      ...(options.resumeMarkers !== undefined ? { resumeMarkers: options.resumeMarkers } : {}),
      ...(options.onMarkers !== undefined
        ? { persistMarkers: (links: readonly string[]) => options.onMarkers?.(links) }
        : {}),
    },
  );
}

describe('download pipeline vs the local fixture manga site (§7.1)', () => {
  let site: FixtureMangaSite;
  let base = '';
  let dir = '';

  beforeEach(async () => {
    site = new FixtureMangaSite({ minImageMs: 15 });
    base = await site.start();
    dir = mkTmpDir('dl-');
  });

  afterEach(async () => {
    await site.stop();
    rmDir(dir);
  });

  it('happy path: a recorded 20-image chapter downloads in FileNames/PageLinks order with every module hook invoked', async () => {
    const fileNames = Array.from({ length: PAGE_COUNT }, (_, i) => `page-${String(i + 1).padStart(2, '0')}`);
    const module = new HookLogModule({ base, fileNames });
    const runner = makeRunner(base, dir, module, { maxThreads: 1 });

    const result = await runner.run();

    expect(result.state).toBe('done');
    expect(result.total).toBe(PAGE_COUNT);
    expect(result.done).toBe(PAGE_COUNT);
    expect(result.failures).toEqual([]);

    // hook-call log: TaskStart → GetPageNumber(chapter URL) → the two
    // host phases — CS_GETPAGELINK (GetImageURL per waiting slot, WorkId
    // order) then CS_DOWNLOAD (per image: BeforeDownloadImage →
    // SaveImage → AfterImageSaved, WorkId order)
    expect(module.log[0]).toEqual({ hook: 'taskStart' });
    expect(module.log[1]).toEqual({ hook: 'getPageNumber', url: `${base}${CHAPTER_PATH}` });
    const pagelinkPhase = module.log.slice(2, 2 + PAGE_COUNT);
    expect(pagelinkPhase).toHaveLength(PAGE_COUNT);
    for (let i = 0; i < PAGE_COUNT; i += 1) {
      expect(pagelinkPhase[i]).toEqual({ hook: 'getImageURL', workId: i });
    }
    const downloadPhase = module.log.slice(2 + PAGE_COUNT);
    expect(downloadPhase).toHaveLength(PAGE_COUNT * 3);
    for (let i = 0; i < PAGE_COUNT; i += 1) {
      const at = i * 3;
      expect(downloadPhase[at]).toEqual({
        hook: 'beforeDownloadImage',
        workId: i,
        url: `${base}/img/p${i}`,
      });
      expect(downloadPhase[at + 1]).toEqual({ hook: 'saveImage', fileName: fileNames[i] });
      expect(downloadPhase[at + 2]?.hook).toBe('afterImageSaved');
    }
    // AfterImageSaved received the assembled saved path of its image
    expect((downloadPhase[2] as HookCall).savedPath).toBe(result.savedFiles[0]);

    // assembly keeps module FileNames[] order
    for (let i = 0; i < PAGE_COUNT; i += 1) {
      expect(result.savedFiles[i]).toBe(path.join(dir, `${fileNames[i]}.jpg`));
      expect(fs.existsSync(result.savedFiles[i] ?? '')).toBe(true);
    }

    // exactly one image request per page, AcceptImage header set
    const imageRequests = site.requests.filter((r) => r.path.startsWith('/img/'));
    expect(imageRequests).toHaveLength(PAGE_COUNT);
    const seenPaths = new Set(imageRequests.map((r) => r.path));
    for (let i = 0; i < PAGE_COUNT; i += 1) {
      expect(seenPaths.has(`/img/p${i}`)).toBe(true);
    }
    for (const r of imageRequests) {
      expect(r.headers['accept']).toBe(ACCEPT_IMAGE_VALUE);
    }
    expect(site.countFor(CHAPTER_PATH)).toBe(1); // the recorded page fetch
  });

  it('BeforeDownloadImage URL rewrite routes the download to the changed route', async () => {
    const module = new HookLogModule({
      base,
      pageCount: 10,
      urlFor: (workId) =>
        workId === 7 || workId === 9 ? `${base}/img/route-a${workId}` : `${base}/img/p${workId}`,
      rewrite: (workId, url) => (workId === 7 || workId === 9 ? `${url}-v2` : undefined),
    });
    const runner = makeRunner(base, dir, module, { maxThreads: 2 });

    const result = await runner.run();

    expect(result.state).toBe('done');
    expect(result.done).toBe(10);
    // the original route-ghost paths were never requested; only the
    // rewritten (-v2) paths served images
    const originals = site.requests.filter((r) => r.path === '/img/route-a7' || r.path === '/img/route-a9');
    expect(originals).toEqual([]);
    expect(site.countFor('/img/route-a7-v2')).toBe(1);
    expect(site.countFor('/img/route-a9-v2')).toBe(1);
    expect(fs.existsSync(result.savedFiles[7] ?? '')).toBe(true);
    expect(fs.existsSync(result.savedFiles[9] ?? '')).toBe(true);
  });

  it('SaveImage custom filename is honored end-to-end (assembly + AfterImageSaved)', async () => {
    const module = new HookLogModule({
      base,
      pageCount: 8,
      bindBeforeDownload: false,
      customSaveFor: (fileName) => (fileName === '007' ? path.join(dir, 'custom-name-007.img') : undefined),
    });
    const runner = makeRunner(base, dir, module, { maxThreads: 2 });

    const result = await runner.run();

    expect(result.state).toBe('done');
    expect(result.done).toBe(8);
    // default names for everyone else (%.3d), the custom path for #007
    expect(result.savedFiles[0]).toBe(path.join(dir, '001.jpg'));
    expect(result.savedFiles[6]).toBe(path.join(dir, 'custom-name-007.img'));
    expect(fs.existsSync(path.join(dir, 'custom-name-007.img'))).toBe(true);
    const savedHook = module.log.find((c) => c.hook === 'afterImageSaved' && c.savedPath?.includes('custom-name-007'));
    expect(savedHook).toBeDefined();
  });

  it('a flaky image (500 then 200) succeeds via the per-image retry budget', async () => {
    const module = new HookLogModule({
      base,
      pageCount: 4,
      bindBeforeDownload: false,
      bindSaveImage: false,
      bindAfterSaved: false,
      urlFor: (workId) => `${base}/img/${workId === 2 ? 'flaky2' : `p${workId}`}`,
    });
    const runner = makeRunner(base, dir, module, { maxThreads: 1 });

    const result = await runner.run();

    expect(result.state).toBe('done');
    expect(result.done).toBe(4);
    expect(result.failures).toEqual([]);
    expect(site.countFor('/img/flaky2')).toBe(2); // first attempt 502, retry 200
  });

  it('cancel mid-download: workers stop within the deadline, queued work fails fast, D markers persist', async () => {
    const slowSite = new FixtureMangaSite({ slowDelayMs: 150, minImageMs: 40 });
    const slowBase = await slowSite.start();
    try {
      const module = new HookLogModule({
        base: slowBase,
        emitPlaceholders: false,
        bindTaskStart: false,
        bindBeforeDownload: false,
        bindSaveImage: false,
        bindAfterSaved: false,
      });
      const limiter = new PerHostSiteLimiter();
      limiter.setHostLimit(new URL(slowBase).host, 2); // queue at the limiter too
      const runner = new DownloadChapterRunner(
        { module, pool: new ConcurrentImageWorkerPool(), limiter },
        {
          moduleId: 'fixturesite',
          mangaUrl: `${slowBase}/`,
          chapterLink: `${slowBase}${CHAPTER_PATH}`,
          workDir: dir,
          maxThreadPerTaskLimit: 3,
          persistMarkers: (links) => writeMarkers(dir, links),
        },
      );

      const runPromise = runner.run();
      await waitFor(() => slowSite.countFor('/img/') >= 3); // mid-download
      const t0 = Date.now();
      const deadlineMs = 1500;
      runner.cancel('test cancel');
      const result = await runPromise;
      const elapsed = Date.now() - t0;

      expect(result.state).toBe('cancelled');
      expect(elapsed).toBeLessThan(deadlineMs); // workers stopped ≤ deadline
      expect(result.done).toBeGreaterThanOrEqual(1);
      expect(result.done).toBeLessThan(PAGE_COUNT);

      // settle the wire first: a cancelled in-flight request may still
      // cross to the server (the abort cannot unsend already-written
      // bytes); after waitSettled no further arrival can belong to run 1
      await slowSite.waitSettled();

      // no new image requests land after the cancel + grace window
      const afterCancelCount = slowSite.countFor('/img/');
      await sleep(300);
      expect(slowSite.countFor('/img/')).toBe(afterCancelCount);

      // 'D' markers persisted for every completed image
      const markers = readMarkers(dir);
      expect(markers).toBeDefined();
      const doneMarkers = (markers ?? []).filter((m) => m === 'D');
      expect(doneMarkers).toHaveLength(result.done);
      // completed files are on disk
      for (const saved of result.savedFiles) {
        if (saved !== '') {
          expect(fs.existsSync(saved)).toBe(true);
        }
      }
    } finally {
      await slowSite.stop();
    }
  });

  it('resume after cancel: only the remaining images are fetched (server request count)', async () => {
    const slowSite = new FixtureMangaSite({ slowDelayMs: 150, minImageMs: 40 });
    const slowBase = await slowSite.start();
    try {
      const firstModule = new HookLogModule({
        base: slowBase,
        emitPlaceholders: false,
        bindTaskStart: false,
        bindBeforeDownload: false,
        bindSaveImage: false,
        bindAfterSaved: false,
      });
      const limiter = new PerHostSiteLimiter();
      limiter.setHostLimit(new URL(slowBase).host, 2);
      const firstRunner = new DownloadChapterRunner(
        { module: firstModule, pool: new ConcurrentImageWorkerPool(), limiter },
        {
          moduleId: 'fixturesite',
          mangaUrl: `${slowBase}/`,
          chapterLink: `${slowBase}${CHAPTER_PATH}`,
          workDir: dir,
          maxThreadPerTaskLimit: 3,
          persistMarkers: (links) => writeMarkers(dir, links),
        },
      );
      const firstRun = firstRunner.run();
      await waitFor(() => slowSite.countFor('/img/') >= 3);
      firstRunner.cancel('cancel for resume test');
      const firstResult = await firstRun;
      expect(firstResult.state).toBe('cancelled');
      const doneFirst = firstResult.done;
      expect(doneFirst).toBeGreaterThan(0);

      // settle the wire before sampling the baseline: a cancelled
      // in-flight request (the image dispatched right at cancel) can
      // still arrive at the server a few turns after the run settles;
      // after waitSettled every future arrival belongs to the resume run
      await slowSite.waitSettled();

      // restart: a fresh runner over the same work dir + persisted markers
      // (a new job — a fresh limiter; a cancelled limiter is terminal)
      const requestsBeforeResume = slowSite.countFor('/img/');
      const resumedModule = new HookLogModule({
        base: slowBase,
        emitPlaceholders: false,
        bindTaskStart: false,
        bindBeforeDownload: false,
        bindSaveImage: false,
        bindAfterSaved: false,
      });
      const resumeLimiter = new PerHostSiteLimiter();
      resumeLimiter.setHostLimit(new URL(slowBase).host, 2);
      const resumeRunner = new DownloadChapterRunner(
        { module: resumedModule, pool: new ConcurrentImageWorkerPool(), limiter: resumeLimiter },
        {
          moduleId: 'fixturesite',
          mangaUrl: `${slowBase}/`,
          chapterLink: `${slowBase}${CHAPTER_PATH}`,
          workDir: dir,
          maxThreadPerTaskLimit: 3,
          resumeMarkers: readMarkers(dir) ?? [],
        },
      );
      const resumeResult = await resumeRunner.run();

      expect(resumeResult.state).toBe('done');
      expect(resumeResult.done).toBe(PAGE_COUNT);
      // exactly the remaining images were fetched this run
      const fetchedOnResume = slowSite.countFor('/img/') - requestsBeforeResume;
      expect(fetchedOnResume).toBe(PAGE_COUNT - doneFirst);
      // the resumed assembly holds all 20 files (resumed + fetched)
      const onDisk = resumeResult.savedFiles.filter((f) => f !== '' && fs.existsSync(f));
      expect(onDisk).toHaveLength(PAGE_COUNT);
    } finally {
      await slowSite.stop();
    }
  });

  it('site limiter: per-host concurrency never exceeds the configured limit under parallel chapters', async () => {
    const site2 = new FixtureMangaSite({ minImageMs: 25 });
    const base2 = await site2.start();
    try {
      const limiter = new PerHostSiteLimiter(); // ONE shared per-site limiter
      limiter.setHostLimit(new URL(base2).host, 2);

      const chapterDirs = Array.from({ length: 3 }, (_, i) => mkTmpDir(`dl-par-${i}-`));
      try {
        const runs = Array.from({ length: 3 }, (_, c) => {
          const module = new HookLogModule({
            base: base2,
            pageCount: 8,
            emitPlaceholders: false,
            bindTaskStart: false,
            bindBeforeDownload: false,
            bindSaveImage: false,
            bindAfterSaved: false,
          });
          const runner = new DownloadChapterRunner(
            { module, pool: new ConcurrentImageWorkerPool(), limiter },
            {
              moduleId: 'fixturesite',
              mangaUrl: `${base2}/`,
              chapterLink: `${base2}${CHAPTER_PATH}`,
              workDir: chapterDirs[c] ?? '',
              maxThreadPerTaskLimit: 4, // pool demand 4 > limiter 2
            },
          );
          return runner.run();
        });

        const results = await Promise.all(runs);

        for (const result of results) {
          expect(result.state).toBe('done');
          expect(result.done).toBe(8);
        }
        // server-side peak never exceeded the limit — and actually hit it
        expect(site2.maxInflight).toBe(2);
      } finally {
        for (const d of chapterDirs) {
          rmDir(d);
        }
      }
    } finally {
      await site2.stop();
    }
  });
});
