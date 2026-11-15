import { mkdirSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Host-default image save/resume file ops (DESIGN §7.1; FMD2
 * `SaveImageStreamToFile` + `FindImageFile`, uBaseUnit.pas:2391-2518):
 * extension detection from the stream content type, the write-then-
 * rename atomic save, and the any-known-extension existence probe the
 * resume path uses (CheckForExists, uDownloadsManager.pas:1040-1063).
 */

/** The image extension table (FMD2 ImageHandlerMgr known extensions). */
const IMAGE_EXTS: readonly string[] = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'];

const CONTENT_TYPE_TO_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/**
 * `GetImageStreamExt` (uBaseUnit.pas) from the response Content-Type —
 * '' when the type is not a known image (the caller then fails the
 * save, mirroring the empty-Result contract).
 */
export function extFromContentType(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTENT_TYPE_TO_EXT[base] ?? '';
}

/**
 * `FindImageFile` (uBaseUnit.pas:2506-2518): the first existing
 * `<dir>/<base>.<known-image-ext>`, or '' when none exists (the resume
 * probe — a hit means the slot is already downloaded).
 */
export function findImageFile(dir: string, baseName: string): string {
  for (const ext of IMAGE_EXTS) {
    const candidate = path.join(dir, `${baseName}.${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

/**
 * `SaveImageStreamToFile` (uBaseUnit.pas:2391+): write `<base>.<ext>`
 * detected from the content type; empty bytes → '' (the FMD2 failure
 * contract); the file lands via tmp-write + rename so a crash never
 * leaves a half-written image behind.
 */
export function saveImageStreamToFile(
  dir: string,
  baseName: string,
  bytes: Uint8Array,
  contentType: string,
): string {
  if (bytes.length === 0) {
    return '';
  }
  const ext = extFromContentType(contentType);
  if (ext === '') {
    return '';
  }
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${baseName}.${ext}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
  return target;
}

/** Directory listing filtered to leftover tmp files (test diagnostics). */
export function leftoverTmpFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.includes('.tmp-'));
  } catch {
    return [];
  }
}
