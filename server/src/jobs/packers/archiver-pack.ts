import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import archiver from 'archiver';
import { tempPackOutputPath, wrapPackIo } from './archive-common.js';
import { MemoryBudget } from './budget.js';
import { PackError } from './errors.js';
import { openPageSource } from './page-source.js';
import { Deferred, waitForClose } from './stream-utils.js';
import { PackWatchdog } from './watchdog.js';
import type { PackOptions, PackResult } from './types.js';

/**
 * Shared scaffolding for the zip-family packers (ZIP/CBZ/EPUB, §7.3):
 * one archiver instance piped into a disk-backed write stream, pages
 * appended one at a time by the format-specific `populate` step, the
 * D16 memory budget sampled between appends, and the pack watchdog
 * racing the whole pipeline. Failures clean up the temp file and are
 * rethrown typed (they map to the retryable `pack` job failure).
 */

export type ArchiverInstance = ReturnType<typeof archiver>;

export interface ArchiverPackContext {
  readonly archive: ArchiverInstance;
  /** Bytes handed to the disk-backed output so far. */
  bytesPacked(): number;
  /** D16 in-memory charge (metadata documents built while packing). */
  charge(bytes: number): void;
  /** D16 budget probe between item appends (throws on breach). */
  sample(): void;
  reportPageProgress(pagesPacked: number, total: number): void;
}

/** Minimal page shape the zip-family packers consume. */
export type ArchiverPage = {
  readonly workId: number;
  readonly filePath: string;
  readonly openStream?: () => Readable;
};

/**
 * One append-per-image step: open the page source (disk stream by
 * default), wire its errors into the pipeline failure, hand it to the
 * archiver (streaming — the file is never buffered whole), and report
 * progress.
 */
export function appendPageEntry(
  ctx: ArchiverPackContext,
  page: ArchiverPage,
  entryName: string,
  opts?: { readonly store?: boolean },
  total?: number,
  pagesPacked?: number,
): Readable {
  const source = openPageSource(page);
  source.on('error', (error: unknown) => {
    throw wrapPackIo(error, `page ${page.workId} read failed`);
  });
  ctx.archive.append(source, { name: entryName, ...(opts?.store === true ? { store: true } : {}) });
  if (total !== undefined && pagesPacked !== undefined) {
    ctx.reportPageProgress(pagesPacked, total);
  }
  return source;
}

export async function runArchiverPack(
  format: 'zip' | 'cbz' | 'epub',
  options: PackOptions,
  populate: (ctx: ArchiverPackContext) => Promise<number>,
): Promise<PackResult> {
  const started = Date.now();
  const budget = new MemoryBudget(options.memoryBudgetBytes);
  const watchdog = new PackWatchdog(options.watchdogMs);
  const outPath = await tempPackOutputPath(options.outputDir, format);
  const out = createWriteStream(outPath, { highWaterMark: 1 << 20 });
  const archive: ArchiverInstance = archiver('zip');
  // Attach before any write: 'close' can fire the moment the last
  // small chunk flushes — a late listener would wait forever.
  const closePromise = waitForClose(out);
  closePromise.catch(() => undefined);
  const pipelineFailure = new Deferred<never>();

  archive.on('error', (error: unknown) => {
    pipelineFailure.reject(error instanceof PackError ? error : wrapPackIo(error, 'archiver failure'));
  });
  archive.on('warning', (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      pipelineFailure.reject(wrapPackIo(error, 'archiver warning'));
    }
  });
  out.on('error', (error: unknown) => {
    pipelineFailure.reject(wrapPackIo(error, 'pack output stream failed'));
  });
  archive.pipe(out);
  watchdog.start();

  const context: ArchiverPackContext = {
    archive,
    bytesPacked: () => out.bytesWritten,
    charge: (bytes: number): void => {
      budget.charge(bytes);
    },
    sample: (): void => {
      budget.sample();
    },
    reportPageProgress: (pagesPacked: number, total: number): void => {
      options.onProgress?.({ pagesPacked, total, bytesPacked: out.bytesWritten });
    },
  };

  try {
    const work = (async (): Promise<number> => {
      const pageCount = await populate(context);
      await archive.finalize();
      return pageCount;
    })();
    const pageCount = await watchdog.race(Promise.race([work, pipelineFailure.promise]));
    await watchdog.race(Promise.race([closePromise, pipelineFailure.promise]));
    return {
      format,
      filePath: outPath,
      bytes: out.bytesWritten,
      pageCount,
      peakHeapBytes: budget.peakHeapBytes,
      peakRssBytes: budget.peakRssBytes,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    archive.abort();
    out.destroy();
    await rm(outPath, { force: true }).catch(() => undefined);
    throw error instanceof PackError ? error : wrapPackIo(error, 'pack failed');
  } finally {
    watchdog.dispose();
  }
}
