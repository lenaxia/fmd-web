import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PackError } from './errors.js';
import type { PackFormat } from './types.js';

/**
 * Archive-adjacent helpers shared by the packers: entry-name hygiene
 * (ZIP/EPUB entries are flat names derived from untrusted URL
 * basenames), media-type mapping, and the disk-backed temp output path
 * (D16: pack output lives on disk, never in a memory Buffer).
 */

/** Max archive entry name length — tail-truncated (DESIGN.md D5). */
const MAX_ENTRY_NAME_LENGTH = 120;

/**
 * Flatten an entry name to a safe single path segment: separators and
 * control characters collapse to `_`, reserved names fall back.
 */
export function sanitizeArchiveEntryName(name: string): string {
  const cleaned = name
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const sanitized = cleaned.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_');
  const safe = sanitized.length === 0 ? '_' : sanitized;
  return safe.length > MAX_ENTRY_NAME_LENGTH
    ? `${safe.slice(0, MAX_ENTRY_NAME_LENGTH)}`
    : safe;
}

/** Lower-cased extension including the dot ('' when none). */
export function fileExtensionOf(name: string): string {
  const base = sanitizeArchiveEntryName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** Image media type for EPUB manifest entries (core types only). */
export function imageMediaTypeFor(fileName: string): string {
  switch (fileExtensionOf(fileName)) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function outputExtensionFor(format: PackFormat): string {
  switch (format) {
    case 'zip':
      return 'zip';
    case 'cbz':
      return 'cbz';
    case 'epub':
      return 'epub';
    case 'pdf':
      return 'pdf';
  }
}

/**
 * The disk-backed pack output path (D16): created inside the caller's
 * temp dir; the packer streams into it and the caller moves it into the
 * library on success.
 */
export async function tempPackOutputPath(outputDir: string, format: PackFormat): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  return join(outputDir, `pack-${format}-${randomUUID()}.${outputExtensionFor(format)}`);
}

/** XML text escaping for EPUB metadata documents. */
export function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Zero-padded page number, width grows with the chapter size. */
export function paddedPageNumber(index1: number, total: number): string {
  const width = Math.max(4, String(Math.max(total, 1)).length);
  return String(index1).padStart(width, '0');
}

/** Wrap any thrown error as a typed pack failure (io/input variants). */
export function wrapPackIo(error: unknown, context: string): PackError {
  const message = error instanceof Error ? error.message : String(error);
  return new PackError('pack-io', `${context}: ${message}`, { cause: error });
}
