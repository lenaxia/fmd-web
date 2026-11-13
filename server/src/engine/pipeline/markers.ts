/**
 * PageLinks marker semantics (DESIGN.md §5.2, uDownloadsManager.pas:350-407
 * and the TTaskThread scan functions) — the RESUME CONTRACT of the download
 * pipeline:
 *
 * - `'W'`  — waiting: the real image URL is not (yet) resolved. Written by
 *            the padding after GetPageNumber (:851), by DownloadImage when
 *            the slot is empty (:353), and by the empty-pagelink sweep
 *            (:1243). `'W'` slots get work in the CS_GETPAGELINK phase and
 *            are SKIPPED (fail) by DownloadImage (:356-357).
 * - `'D'`  — done: image downloaded. Skipped (success) by DownloadImage
 *            (:358-359), skipped by the download work scan (:952), and the
 *            finish check counts the non-'D' entries (:1067+).
 * - `'G'`  — dynamic: like `'W'` but the URL must be re-resolved every run
 *            (`DynamicPageLink`, CheckForExists :1048-1061).
 * - `''`   — empty: treated exactly like `'W'` everywhere
 *            (CheckForPrepare :994, DownloadImage :352-355).
 */

export const PAGE_LINK_WAITING = 'W';
export const PAGE_LINK_DONE = 'D';
export const PAGE_LINK_DYNAMIC = 'G';

/** Chapter-level status markers (ChaptersStatus, uDownloadsManager.pas:1119-1318). */
export const CHAPTER_PENDING = 'P';
export const CHAPTER_DONE = 'D';
export const CHAPTER_FAILED = 'F';

/** `'W'` and the empty string are the same state (uDownloadsManager.pas:994). */
export function isWaitingMarker(value: string): boolean {
  return value === PAGE_LINK_WAITING || value === '';
}

export function isDoneMarker(value: string): boolean {
  return value === PAGE_LINK_DONE;
}

export function isDynamicMarker(value: string): boolean {
  return value === PAGE_LINK_DYNAMIC;
}

/** A slot ready for a DownloadImage attempt (any real URL). */
export function isReadyMarker(value: string): boolean {
  return !isWaitingMarker(value) && !isDoneMarker(value) && !isDynamicMarker(value);
}
