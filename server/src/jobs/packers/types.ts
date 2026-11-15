import type { Readable } from 'node:stream';

/**
 * Packer boundary types (DESIGN.md §7.3, D16) — the streaming pack stage
 * of the download pipeline (uDownloadsManager.pas packaging).
 *
 * DISCIPLINE (D16): every packer streams append-per-item into a
 * disk-backed output file. Nothing ever buffers a whole chapter (or the
 * whole packed archive) in RSS. The per-job memory budget (512 MB) and
 * the pack watchdog (120 s) are enforced in the shared pack context —
 * a violation fails the job as `pack`, which is retryable (optionally
 * with the per-image re-encode recovery).
 */

/** The four pack formats (§7.3). CBZ is a ZIP by another extension. */
export type PackFormat = 'zip' | 'cbz' | 'epub' | 'pdf';

/** One page handed to a packer — the image must be on disk. */
export interface PackPageInput {
  /** The chapter work id (PageLinks index); defines reading order. */
  readonly workId: number;
  /**
   * The downloaded image file on disk. Packers stream from this file —
   * never a whole-file buffer across the boundary.
   */
  readonly filePath: string;
  /** File name to use inside the archive (with extension, e.g. `0001.jpg`). */
  readonly fileName: string;
  /**
   * Optional stream override for the page bytes. Production always reads
   * `filePath` from disk (append-per-image from the file, never a
   * whole-file buffer); the watchdog drill injects a slow stream here.
   */
  readonly openStream?: () => Readable;
}

/** Progress callback — the pack stage reports progress per item (§7.3). */
export interface PackProgressInfo {
  readonly pagesPacked: number;
  readonly total: number;
  readonly bytesPacked: number;
}

export interface PackOptions {
  /** Temp directory the packed output file is created in. */
  readonly outputDir: string;
  /** Human title (EPUB metadata / PDF outline-adjacent Info subject). */
  readonly title?: string;
  /** D16 per-job memory budget in bytes (default 512 MiB). */
  readonly memoryBudgetBytes?: number;
  /** Pack watchdog deadline in ms (default 120 000). */
  readonly watchdogMs?: number;
  /** Per-item progress sink (coalescing is the caller's concern). */
  readonly onProgress?: (progress: PackProgressInfo) => void;
}

export interface PackResult {
  readonly format: PackFormat;
  /** Disk path of the packed output (caller moves it into the library). */
  readonly filePath: string;
  readonly bytes: number;
  readonly pageCount: number;
  /** Peak attributed memory (heapUsed + external + arrayBuffers) observed. */
  readonly peakHeapBytes: number;
  /** Peak RSS observed over the pack (the in-test RSS assertion). */
  readonly peakRssBytes: number;
  readonly elapsedMs: number;
}

/**
 * The Packer interface — one implementation per format (§7.3). `pack`
 * appends pages in the given order (chapter reading order), writes the
 * output to a temp file under `options.outputDir`, and enforces the D16
 * memory budget + watchdog for the whole pack.
 */
export interface Packer {
  readonly format: PackFormat;
  pack(pages: readonly PackPageInput[], options: PackOptions): Promise<PackResult>;
}
