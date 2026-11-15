import { EpubPacker } from './epub-packer.js';
import { PdfPacker } from './pdf-packer.js';
import { ZipPacker } from './zip-packer.js';
import type { PackFormat, Packer } from './types.js';

/**
 * Packer factory + module surface (server/jobs/packers, DESIGN.md
 * §7.3). One Packer implementation per format:
 *   zip / cbz — archiver streaming, append-per-image, disk-backed temp
 *   epub      — zip-based streaming builder (mimetype first, OPF spine)
 *   pdf       — incremental disk-backed writer (D16, no pdf-lib)
 * Every pack runs under the 512 MB D16 budget and the 120 s watchdog;
 * failures map to the retryable `pack` job failure (packJobFailure).
 */

/** All supported pack formats. */
export const PACKER_FORMATS: readonly PackFormat[] = ['zip', 'cbz', 'epub', 'pdf'];

/** Build the packer for one format. */
export function createPacker(format: PackFormat): Packer {
  switch (format) {
    case 'zip':
      return new ZipPacker('zip');
    case 'cbz':
      return new ZipPacker('cbz');
    case 'epub':
      return new EpubPacker();
    case 'pdf':
      return new PdfPacker();
  }
}

export {
  attributedMemoryBytes,
  DEFAULT_MEMORY_BUDGET_BYTES,
  MemoryBudget,
} from './budget.js';
export {
  DEFAULT_WATCHDOG_MS,
  PackWatchdog,
} from './watchdog.js';
export {
  isPackError,
  PACK_JOB_FAILURE_KIND,
  packJobFailure,
  PackError,
} from './errors.js';
export type {
  PackFailureKind,
  PackJobFailure,
  PackRecoveryHint,
} from './errors.js';
export type {
  PackFormat,
  PackOptions,
  PackPageInput,
  PackProgressInfo,
  PackResult,
  Packer,
} from './types.js';
export { validateZipArchive, walkZipCentralDirectory, readZipEntry } from './validate/zip-validator.js';
export { validateEpub } from './validate/epub-validator.js';
export { validatePdf } from './validate/pdf-validator.js';
export { probeEmbeddableImage } from './probe-image.js';
