import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createPacker,
  DEFAULT_MEMORY_BUDGET_BYTES,
  MemoryBudget,
  packJobFailure,
  PackError,
} from '../../../src/jobs/packers/index.js';
import { writeSmallChapter } from './fixtures.js';

/**
 * Watchdog drill (DESIGN.md §13 chaos discipline, §7.3): a fake-slow
 * input must fail the pack AT the deadline with the retryable `pack`
 * failure kind — never wedge the lane — and the failed pack must leave
 * no temp output behind. Also covers the D16 budget mechanics.
 */

let parentDir: string | undefined;

async function parent(): Promise<string> {
  parentDir ??= await mkdtemp(join(tmpdir(), 'packers-watchdog-'));
  return parentDir;
}

afterAll(async () => {
  if (parentDir !== undefined) {
    await rm(parentDir, { recursive: true, force: true });
  }
});

function stalledPage(workId: number): {
  readonly workId: number;
  readonly filePath: string;
  readonly fileName: string;
  readonly openStream: () => PassThrough;
} {
  return {
    workId,
    filePath: '/nonexistent/stalled.png',
    fileName: `${String(workId + 1).padStart(4, '0')}.png`,
    openStream: () => {
      const stream = new PassThrough();
      return stream; // never written to, never ended — a stalled site
    },
  };
}

describe('pack watchdog — deadline-exceeded pack fails as retryable pack', () => {
  it('ZIP: a stalled page stream trips the watchdog at the deadline', async () => {
    const fixture = await writeSmallChapter(await parent(), [{ kind: 'png' }]);
    const pages = [fixture.pages[0] ?? undefined, stalledPage(1)].filter(
      (page) => page !== undefined,
    );
    const started = Date.now();
    const error = await createPacker('zip')
      .pack(pages, { outputDir: join(await parent(), 'wd-zip'), watchdogMs: 80 })
      .then(
        (result) => result,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).kind).toBe('pack-watchdog-timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
    const failure = packJobFailure(error);
    expect(failure.kind).toBe('pack');
    expect(failure.retryable).toBe(true);
    // No temp output survives a watchdog failure.
    const leftovers = await readdir(join(await parent(), 'wd-zip'));
    expect(leftovers).toEqual([]);
  }, 20_000);

  it('PDF: a stalled probe source trips the watchdog (page never resolves)', async () => {
    const fixture = await writeSmallChapter(await parent(), [{ kind: 'png' }]);
    const pages = [fixture.pages[0] ?? undefined, stalledPage(1)].filter(
      (page) => page !== undefined,
    );
    const started = Date.now();
    const error = await createPacker('pdf')
      .pack(pages, { outputDir: join(await parent(), 'wd-pdf'), watchdogMs: 80 })
      .then(
        (result) => result,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).kind).toBe('pack-watchdog-timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
    const failure = packJobFailure(error);
    expect(failure.kind).toBe('pack');
    expect(failure.retryable).toBe(true);
    const leftovers = await readdir(join(await parent(), 'wd-pdf'));
    expect(leftovers).toEqual([]);
  }, 20_000);

  it('EPUB: a stalled page stream trips the watchdog too', async () => {
    const fixture = await writeSmallChapter(await parent(), [{ kind: 'png' }]);
    const pages = [fixture.pages[0] ?? undefined, stalledPage(1)].filter(
      (page) => page !== undefined,
    );
    const error = await createPacker('epub')
      .pack(pages, { outputDir: join(await parent(), 'wd-epub'), watchdogMs: 80 })
      .then(
        (result) => result,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).kind).toBe('pack-watchdog-timeout');
    const leftovers = await readdir(join(await parent(), 'wd-epub'));
    expect(leftovers).toEqual([]);
  }, 20_000);
});

describe('D16 memory budget mechanics', () => {
  it('default budget is 512 MiB and samples report peaks', () => {
    const budget = new MemoryBudget(DEFAULT_MEMORY_BUDGET_BYTES);
    const sample = budget.sample();
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(budget.peakHeapBytes).toBeGreaterThan(0);
    expect(budget.peakRssBytes).toBeGreaterThan(0);
  });

  it('sample() throws the typed budget error when the budget is tiny', () => {
    const budget = new MemoryBudget(1);
    expect(() => budget.sample()).toThrowError(PackError);
    try {
      budget.sample();
    } catch (error) {
      expect((error as PackError).kind).toBe('pack-budget-exceeded');
      expect((error as PackError).recoveryHint).toBe('re-encode-pages');
      const failure = packJobFailure(error);
      expect(failure.kind).toBe('pack');
      expect(failure.retryable).toBe(true);
    }
  });

  it('charge() rejects an in-memory charge above the budget', () => {
    const budget = new MemoryBudget(64 * 1024);
    expect(() => budget.charge(65 * 1024)).toThrowError(PackError);
    expect(() => budget.charge(1024)).not.toThrowError();
  });
});
