import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { imageMediaTypeFor, sanitizeArchiveEntryName } from './archive-common.js';

/** Open the byte source for a page: test override or the disk file. */
export function openPageSource(page: {
  readonly filePath: string;
  readonly openStream?: () => Readable;
}): Readable {
  if (page.openStream !== undefined) {
    return page.openStream();
  }
  return createReadStream(page.filePath);
}

/**
 * The entry name inside a ZIP/CBZ: flattened to one safe segment
 * (entries come from untrusted URL basenames).
 */
export function zipEntryName(page: { readonly fileName: string }): string {
  return sanitizeArchiveEntryName(page.fileName);
}

/** Re-exported for packers that need the EPUB media type of a page. */
export { imageMediaTypeFor, sanitizeArchiveEntryName };
