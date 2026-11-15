import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attributedMemoryBytes, createPacker, validateEpub, validatePdf, validateZipArchive } from '../../../src/jobs/packers/index.js';
import type { PackResult } from '../../../src/jobs/packers/types.js';
import { writeLargeChapter, type ChapterFixture } from './fixtures.js';

/**
 * The D16 memory test (Phase-3 exit criterion): a synthetic 1000-page
 * chapter (large-ish generated PNGs) packs under the 512 MB budget with
 * heap monitoring asserted in-test — packers report their peak
 * attributed heap and peak RSS (sampled per page), and the test itself
 * re-checks RSS between packs. The PDF path exercises the incremental
 * disk-backed writer: no full-document materialization (peak heap far
 * below the chapter's total byte volume proves no whole-book buffering).
 */

const PAGE_COUNT = 1000;
const PAGE_WIDTH = 512;
const PAGE_HEIGHT = 256;
const MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

let rootDir: string | undefined;
let fixturePromise: Promise<ChapterFixture> | undefined;

/** The 1000-page fixture is generated once and reused by all three packs. */
function fixture(): Promise<ChapterFixture> {
  fixturePromise ??= (async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'packers-mem-'));
    return writeLargeChapter(rootDir, PAGE_COUNT, PAGE_WIDTH, PAGE_HEIGHT);
  })();
  return fixturePromise;
}

afterAll(async () => {
  if (rootDir !== undefined) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

function expectUnderBudget(
  result: PackResult,
  totalImageBytes: number,
  baselineBytes: number,
): void {
  expect(result.pageCount).toBe(PAGE_COUNT);
  // In-test RSS/heap assertion: peaks stay under the D16 budget.
  expect(result.peakHeapBytes).toBeLessThan(MEMORY_BUDGET_BYTES);
  expect(result.peakRssBytes).toBeLessThan(MEMORY_BUDGET_BYTES);
  const rssNow = process.memoryUsage().rss;
  expect(rssNow).toBeLessThan(MEMORY_BUDGET_BYTES);
  // Disk-temp discipline, measured as GROWTH over the pre-pack baseline
  // (the budget samples process-wide memory, which retains un-collected
  // garbage from sibling packs in this worker): whole-book buffering
  // would add ≥ the chapter byte volume — the streaming writers stay
  // far below it (headroom for GC-scheduling variance).
  const growth = result.peakHeapBytes - baselineBytes;
  expect(growth).toBeLessThan(totalImageBytes * 0.75);
}

describe('1000-page synthetic chapter packs under the D16 budget', () => {
  it(
    'ZIP pack: entries ordered, CRC-valid, heap far below the book size',
    async () => {
      const chapter = await fixture();
      // Large-ish sanity: the chapter must be heavy enough that naive
      // whole-book buffering would threaten the budget.
      expect(chapter.totalImageBytes).toBeGreaterThan(128 * 1024 * 1024);

      const baseline = attributedMemoryBytes();
      const result = await createPacker('zip').pack(chapter.pages, {
        outputDir: join(rootDir ?? '', 'out-zip'),
        title: 'Memory drill',
      });
      expectUnderBudget(result, chapter.totalImageBytes, baseline);
      expect(result.bytes).toBeGreaterThanOrEqual(chapter.totalImageBytes);

      const expected = chapter.pages.map((page) => page.fileName);
      const validation = await validateZipArchive(result.filePath, expected);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      expect(validation.entryCount).toBe(PAGE_COUNT);
    },
    600_000,
  );

  it(
    'EPUB pack: spine equals chapter order across 1000 pages, under budget',
    async () => {
      const chapter = await fixture();
      const baseline = attributedMemoryBytes();
      const result = await createPacker('epub').pack(chapter.pages, {
        outputDir: join(rootDir ?? '', 'out-epub'),
        title: 'Memory drill',
      });
      expectUnderBudget(result, chapter.totalImageBytes, baseline);

      const expectedHrefs = chapter.pages.map(
        (_page, index) => `text/p${String(index + 1).padStart(4, '0')}.xhtml`,
      );
      const validation = await validateEpub(result.filePath, expectedHrefs);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      expect(validation.spineHrefs).toEqual(expectedHrefs);
    },
    600_000,
  );

  it(
    'PDF pack: incremental writer streams 1000 pages, page count matches, under budget',
    async () => {
      const chapter = await fixture();
      const baseline = attributedMemoryBytes();
      const result = await createPacker('pdf').pack(chapter.pages, {
        outputDir: join(rootDir ?? '', 'out-pdf'),
        title: 'Memory drill',
      });
      expectUnderBudget(result, chapter.totalImageBytes, baseline);
      expect(result.bytes).toBeGreaterThanOrEqual(chapter.totalImageBytes);

      const validation = await validatePdf(result.filePath, PAGE_COUNT);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      expect(validation.pageCount).toBe(PAGE_COUNT);
      for (const page of validation.pages) {
        expect(page.hasPageType).toBe(true);
        expect(page.imageObjectId).toBeGreaterThan(0);
      }
    },
    600_000,
  );
});
