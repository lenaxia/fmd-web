/**
 * Case-insensitive chapter-list merge — FMD2 `MergeCaseInsensitive`
 * parity (uBaseUnit.pas:1438-1474), the value semantics of
 * `downloaded_chapters` (DESIGN.md §9) and the favorite-side
 * `downloaded_chapter_list` (§7.2 dual-write).
 *
 * Ground truth (DownloadedChaptersDB.pas:55, 70-79, 125-128 +
 * uFavoritesManager.pas:1131, 1368):
 *   - key = `LowerCase(ModuleID+Link)` (ASCII lowercasing, Pascal
 *     `LowerCase` — :55, :78);
 *   - an EXISTING row merges the stored list with the new value via
 *     `MergeCaseInsensitive([stored, value])` (:73);
 *   - a NEW row stores the value as-is (:78-79) — no merge, no sort;
 *   - `SetChapters('')` exits — an empty value is a no-op (:65).
 *
 * `MergeCaseInsensitive` itself (uBaseUnit.pas:1438-1455): a TStringList
 * with `CaseSensitive := False`, `Duplicates := dupIgnore`,
 * `Sorted := True`; every input goes through `AddText` (FPC
 * DoSetTextStr — lines split on #10/#13/CRLF, a trailing break adds no
 * item, interior empty lines ARE items); each Add binary-searches with
 * `CompareText` (ASCII-case-insensitive) and a case-insensitive match is
 * DROPPED — the first-added case variant of a duplicate survives, the
 * list ends sorted. `Result := s.Text` = lines joined with LineEnding +
 * a trailing LineEnding when non-empty (LineEnding = LF on the Linux
 * runtime, the convention pinned in engine/lua/tstrings.ts; parsing
 * accepts CRLF either way).
 */

import { compareLegacyText } from '../../engine/facade.js';

/** FPC GetNextLine / DoSetTextStr line split (stringl.inc:834-947). */
export function splitTextLines(value: string): string[] {
  const out: string[] = [];
  let p = 0;
  while (p < value.length) {
    const start = p;
    while (p < value.length && value.charCodeAt(p) !== 10 && value.charCodeAt(p) !== 13) {
      p += 1;
    }
    out.push(value.slice(start, p));
    if (value.charCodeAt(p) === 13) p += 1;
    if (value.charCodeAt(p) === 10) p += 1;
  }
  return out;
}

/** Pascal `LowerCase` parity: ASCII-only case folding. */
export function asciiLowerCase(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s.charAt(i);
  }
  return out;
}

/** `LowerCase(ModuleID+Link)` — the downloaded_chapters row key. */
export function downloadedChaptersKey(moduleId: string, link: string): string {
  return asciiLowerCase(moduleId + link);
}

/** TStrings.Text — joined with LF + trailing LF when non-empty. */
export function linesToText(lines: readonly string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/**
 * `MergeCaseInsensitive(Strs: array of String)` — sorted, deduped,
 * first-added case variant survives, trailing-LF text out, '' when no
 * lines at all (no inputs or inputs with no lines).
 */
export function mergeCaseInsensitive(...inputs: string[]): string {
  const merged: string[] = [];
  for (const input of inputs) {
    for (const line of splitTextLines(input)) {
      // TStringList.Add with Sorted+dupIgnore: binary search, drop on
      // a case-insensitive match (uBaseUnit.pas:1446-1450).
      let lo = 0;
      let hi = merged.length;
      let hit = false;
      while (lo < hi) {
        const mid = lo + ((hi - lo) >> 1);
        const existing = merged[mid] ?? '';
        const cmp = compareLegacyText(line, existing);
        if (cmp === 0) {
          hit = true;
          break;
        }
        if (cmp < 0) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      if (!hit) {
        merged.splice(lo, 0, line);
      }
    }
  }
  return linesToText(merged);
}

/**
 * Membership test the favorites diff uses (uFavoritesManager.pas:364-370
 * — IndexOf over a case-insensitively sorted list): true when `line`
 * compares equal (ASCII-case-insensitive) to some line of the stored
 * text. Linear, not binary — a freshly-created row stores its list
 * unsorted (:78-79), so sortedness is not an invariant here.
 */
export function hasChapter(text: string, line: string): boolean {
  for (const existing of splitTextLines(text)) {
    if (compareLegacyText(line, existing) === 0) {
      return true;
    }
  }
  return false;
}
