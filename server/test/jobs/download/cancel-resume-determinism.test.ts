import { describe, expect, it } from 'vitest';
import { FixtureMangaSite } from './fixture-site.js';
import { DownloadChapterRunner } from '../../../src/jobs/download/download-runner.js';
import { PerHostSiteLimiter } from '../../../src/jobs/download/site-limiter.js';
import { ConcurrentImageWorkerPool } from '../../../src/jobs/download/image-worker-pool.js';
import { readMarkers, writeMarkers } from '../../../src/jobs/download/marker-store.js';
import { mkTmpDir, rmDir } from '../helpers.js';
import type { ChapterModuleHooks, TaskWriter } from '../../../src/jobs/download/types.js';

/**
 * Regression test for the cancel→resume request-count race (REVIEW
 * velvet-pulley-prosper Blocker 2, root cause established 2026-11-14).
 *
 * ROOT CAUSE (wire-level trace, undici diagnostics + server connection
 * log): cancel() lands in the ~1ms window after an in-flight fetch was
 * dispatched; the abort destroys the client socket but cannot unsend
 * request bytes already written. The server still parses that request
 * and its arrival can be recorded a few event-loop turns AFTER the
 * cancelled run's promise settles — i.e. inside the next run's sampling
 * window. The engine is correct per DESIGN §4 (in-flight aborts; FMD2
 * THTTP.Terminate has the same TCP property): the cancelled request is
 * never marked 'D' and resume re-fetches that image exactly once. The
 * defect was in the TESTS: request-count baselines were sampled without
 * waiting for the fixture's handlers to quiesce (FixtureMangaSite
 * .waitSettled). This suite pins the invariant deterministically:
 * after cancel + settle, the resume run fetches EXACTLY the remaining
 * images, each exactly once, regardless of where the cancel landed.
 */

const PAGE_COUNT = 20;
const CHAPTER_PATH = '/manga/chapter-1';
/** Bounded loop: the cancel/dispatch race window is one event-loop
 *  turn; the pre-fix race reproduced at ~1–4 of 25 iterations, so 30
 *  iterations cover it repeatedly while keeping the suite fast. */
const ITERATIONS = 30;

function bareModule(base: string): ChapterModuleHooks {
  return {
    getPageNumber: async (task: TaskWriter, url: string) => {
      const page = await fetch(url);
      if (!page.ok) return false;
      task.pageNumber = PAGE_COUNT;
      for (let i = 0; i < PAGE_COUNT; i += 1) task.pageLinks[i] = `${base}/img/p${i}`;
      return true;
    },
    getImageURL: async (task: TaskWriter, workId: number) => {
      task.pageLinks[workId] = `${base}/img/p${workId}`;
      return true;
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('cancel→resume determinism (wire-straggler regression, Blocker 2)', () => {
  it(`over ${ITERATIONS} cancel→resume cycles: resume fetches exactly the remaining images, each exactly once`, async () => {
    const site = new FixtureMangaSite({ slowDelayMs: 60, minImageMs: 15 });
    const base = await site.start();
    try {
      for (let iter = 0; iter < ITERATIONS; iter += 1) {
        const dir = mkTmpDir('dl-det-');
        try {
          // the fixture's request log accumulates across iterations —
          // baseline everything per iteration
          const iterStartCount = site.countFor('/img/');
          const limiter = new PerHostSiteLimiter();
          limiter.setHostLimit(new URL(base).host, 2);
          const runner = new DownloadChapterRunner(
            { module: bareModule(base), pool: new ConcurrentImageWorkerPool(), limiter },
            {
              moduleId: 'fixturesite',
              mangaUrl: `${base}/`,
              chapterLink: `${base}${CHAPTER_PATH}`,
              workDir: dir,
              maxThreadPerTaskLimit: 3,
              persistMarkers: (links) => writeMarkers(dir, links),
            },
          );
          const firstRun = runner.run();
          await waitFor(() => site.countFor('/img/') >= iterStartCount + 3); // mid-download
          runner.cancel('determinism');
          const first = await firstRun;
          expect(first.state, `iter ${iter}`).toBe('cancelled');
          const doneFirst = first.done;
          expect(doneFirst, `iter ${iter}`).toBeGreaterThan(0);
          expect(doneFirst, `iter ${iter}`).toBeLessThan(PAGE_COUNT);

          // wire settle: a cancelled in-flight request may still arrive at
          // the server after the run settles (see header) — its handler
          // must finish BEFORE the resume-window baseline is sampled
          await site.waitSettled();
          const before = site.countFor('/img/');

          // resume: fresh job over the persisted markers (fresh limiter —
          // a cancelled limiter is terminal)
          const resumeLimiter = new PerHostSiteLimiter();
          resumeLimiter.setHostLimit(new URL(base).host, 2);
          const resumeRunner = new DownloadChapterRunner(
            { module: bareModule(base), pool: new ConcurrentImageWorkerPool(), limiter: resumeLimiter },
            {
              moduleId: 'fixturesite',
              mangaUrl: `${base}/`,
              chapterLink: `${base}${CHAPTER_PATH}`,
              workDir: dir,
              maxThreadPerTaskLimit: 3,
              resumeMarkers: readMarkers(dir) ?? [],
              persistMarkers: (links) => writeMarkers(dir, links),
            },
          );
          const resume = await resumeRunner.run();

          expect(resume.state, `iter ${iter}`).toBe('done');
          expect(resume.done, `iter ${iter}`).toBe(PAGE_COUNT);

          // exact server-side request count: exactly the remaining images
          const remainingIds = first.savedFiles
            .map((f, workId) => (f === '' ? workId : -1))
            .filter((workId) => workId >= 0);
          const expected = remainingIds.length;
          const fetched = site.countFor('/img/') - before;
          expect(fetched, `iter ${iter}`).toBe(expected);

          // and exactly once per remaining path, no other path touched
          // (compare as sorted multisets — arrival order across the pool is
          // nondeterministic by design)
          const imgAll = site.requests.filter((r) => r.path.startsWith('/img/'));
          const window = imgAll.slice(before);
          const counts = new Map<string, number>();
          for (const r of window) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
          const byPath = (a: [string, number], b: [string, number]): number =>
            Number(a[0].slice('/img/p'.length)) - Number(b[0].slice('/img/p'.length));
          expect([...counts.entries()].sort(byPath), `iter ${iter}`).toEqual(
            remainingIds.map((workId) => [`/img/p${workId}`, 1] as [string, number]).sort(byPath),
          );

          // the resume contract: every slot now persisted as 'D'
          const markers = readMarkers(dir) ?? [];
          expect(markers.filter((m) => m === 'D'), `iter ${iter}`).toHaveLength(PAGE_COUNT);
        } finally {
          rmDir(dir);
        }
      }
    } finally {
      await site.stop();
    }
  }, 120_000);
});
