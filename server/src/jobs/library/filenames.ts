/**
 * Library chapter filename resolution (DESIGN §7.1 — the
 * `library/<module>/<manga>/<chapter>.<ext>` entry name).
 *
 * Resolution order (first non-empty wins):
 *   1. module `FileNames[]` entry for the chapter
 *      (TASK.FileNames, LuaDownloadTask.pas:21-32 — honored when the
 *      chapter pointer indexes the list, mirroring GetFileName's
 *      count-alignment guard, uDownloadsManager.pas:537-539);
 *   2. the `SaveImage` return value (DoSaveImage, LuaWebsiteModules.pas:
 *      372-391 — SaveImage returns the filename the module saved,
 *      luaToString at :386);
 *   3. the filename template — chapter-scope CustomRename placeholders
 *      (CR_* constants, uBaseUnit.pas:251-257). FMD2's chapter-naming
 *      CustomRename calls leave `AFileName` at its '' default
 *      (signature :564-567; calls uFavoritesManager.pas:483-492,
 *      uSilentThread.pas:332-340), so `%FILENAME%` has no page-name
 *      source at chapter scope there — it substitutes ''. fmd-web
 *      substitutes the SaveImage return instead (normally absent,
 *      since a present SaveImage return already won at step 2),
 *      leaving the template's literal text (FMD2 behavior:
 *      unresolvable placeholders yield '').
 *   4. the chapter name (FMD2's packer fallback — the packed chapter is
 *      `<SaveTo>/<ChapterNames[ptr]>.<ext>`, uDownloadsManager.pas:577).
 *
 * Every candidate is sanitized before it can win, and the final name is
 * sanitized once more as a whole: the fmd-web library is a fixed-depth
 * layout (§7.1/§9), so a template's literal text cannot introduce path
 * separators — a deliberate, documented divergence from FMD2, where a
 * CustomRename template may create subdirectories under downloads/ and
 * the GetFileName page path is not sanitized at all (:542).
 *
 * Sanitization = exact `RemoveSymbols` parity (set uBaseUnit.pas:59-60,
 * loop :1382-1394): EXACTLY the FMD2 `Symbols` set — `\ / : * ? " < > |`
 * plus tab (#9) and `;` — is deleted, unit by unit, and NOTHING else.
 * `RemoveSymbols` has no general control-character sweep: control units
 * outside the set (#0..#8, #10..#31, ...) and DEL (#127) survive —
 * parity, verified. The trailing trim is FPC `Trim` parity (strips only
 * leading/trailing units ≤ #32, not Unicode whitespace) and follows
 * FixStringLocal's CommonStringFilter (uBaseUnit.pas:1807 → :2119-2124,
 * the Trim at :2123); fmd-web applies it to every candidate as part of
 * the whole-component sanitization above, whereas FMD2 trims only
 * CustomRename results (per-value FixStringLocal :1804-1813, final
 * `TrimChar(AllowDirectorySeparators)` at :1856).
 *
 * Template-substitution values pass through the same
 * {@link sanitizeFileName}; FMD2's FixStringLocal (:1804-1813)
 * additionally entity-decodes via CommonStringFilter and optionally
 * strips unicode (:1810-1812) — HTML-text hygiene plus a user option
 * fmd-web does not reproduce here (documented divergence).
 *
 * Truncation = tail survival: `Delete(s, 1, Length(s) -
 * FCurrentMaxFileNameLength)` when over `CurrentMaxFileNameLength`,
 * applied AFTER the template expansion (uDownloadsManager.pas:545-549,
 * the :542 substitution → :545 check order); 0 = no limit (D5
 * Windows-desktop parity, UTF-16 code units — Pascal's UnicodeString
 * Length).
 *
 * The mode-dependent final step (parity tail-truncation vs the
 * `FMD_NORMALIZE_PATHS=1` / `--normalize-paths` Linux-normalized
 * opt-out) lives in the SHARED D5 policy
 * ({@link applyFileNamePolicy} from `@fmd/contract`, DESIGN.md §14 D5)
 * — this module never re-implements the mode switch; it only owns the
 * parity sanitization (RemoveSymbols/Trim above), which both modes
 * apply before the policy runs. The §7.1 fixed-depth LAYOUT caps
 * (finalize.ts/download-lane.ts component truncations) are not D5
 * filename semantics and stay parity-only.
 */

import { applyFileNamePolicy, type FileNamePolicyMode } from '@fmd/contract';

/**
 * uBaseUnit.pas:59-60 — the FMD2 `Symbols` set, in declaration order:
 * path-unsafe punctuation plus tab (#9) and `;`. Exactly these units
 * are deleted by {@link sanitizeFileName} (`RemoveSymbols` parity) —
 * no other character is removed.
 */
export const SYMBOLS: readonly string[] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\t', ';'];

/** CustomRename placeholders (uBaseUnit.pas:251-257). */
export const CR = {
  numbering: '%NUMBERING%',
  chapter: '%CHAPTER%',
  website: '%WEBSITE%',
  manga: '%MANGA%',
  author: '%AUTHOR%',
  artist: '%ARTIST%',
  fileName: '%FILENAME%',
} as const;

/**
 * FPC `Trim` parity (:2123): strips leading/trailing units ≤ #32 only —
 * deliberately NOT JS `.trim()`, which additionally strips Unicode
 * whitespace (U+00A0, U+2028, ...) Pascal leaves alone.
 */
function trimAscii(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end -= 1;
  return s.slice(start, end);
}

/**
 * `RemoveSymbols` + Trim parity: deletes exactly the {@link SYMBOLS}
 * set (uBaseUnit.pas:59-60, loop :1382-1394) and nothing else — no
 * general control-character sweep — then strips leading/trailing units
 * ≤ #32 (:2123). Idempotent.
 */
export function sanitizeFileName(name: string): string {
  let out = '';
  for (const ch of name) {
    if (SYMBOLS.includes(ch)) {
      continue;
    }
    out += ch;
  }
  return trimAscii(out);
}

/**
 * Tail truncation (uDownloadsManager.pas:543-550, D5): over a positive
 * `maxLength` the HEAD is deleted — the TAIL survives; 0 = no limit.
 */
export function truncateKeepTail(name: string, maxLength: number): string {
  const max = Math.trunc(maxLength);
  if (!(max > 0) || name.length <= max) {
    return name;
  }
  return name.slice(name.length - max);
}

function substitute(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let out = template;
  for (const [placeholder, value] of Object.entries(values)) {
    out = out.split(placeholder).join(value);
  }
  return out;
}

/** Chapter-scoped filename inputs (§7.1 resolution order). */
export interface ChapterFileNameParts {
  /** Module `FileNames[]` (TASK.FileNames). */
  readonly fileNames?: readonly string[];
  /** Chapter pointer into FileNames[] (CurrentDownloadChapterPtr). */
  readonly fileNamesIndex?: number;
  /** `SaveImage` return value (module-saved filename). */
  readonly saveImageName?: string;
  /** Filename template (''/absent = no template candidate). */
  readonly template?: string;
  /** Chapter name (the FMD2 packer fallback, :577). */
  readonly chapterName?: string;
  /** Template substitution values (each passed through sanitizeFileName). */
  readonly website?: string;
  readonly manga?: string;
  readonly author?: string;
  readonly artist?: string;
  readonly numbering?: string;
  /** CurrentMaxFileNameLength (0 = no limit, D5 — parity mode only). */
  readonly maxLength?: number;
  /**
   * D5 policy mode override (undefined = resolve from
   * `FMD_NORMALIZE_PATHS` / `--normalize-paths` at the shared choke
   * point). `linux-normalized` skips the tail truncation and strips
   * control units; `windows-parity` is the default semantics.
   */
  readonly mode?: FileNamePolicyMode | undefined;
}

/**
 * §7.1 resolution order: module FileNames[] → SaveImage return →
 * filename template → chapter name; sanitize; tail-truncate. Throws
 * when every candidate sanitizes away — the finalize then fails the
 * job instead of writing an unnamed library entry.
 */
export function resolveChapterFileName(parts: ChapterFileNameParts): string {
  const safe = (candidate: string): string => {
    const sanitized = sanitizeFileName(candidate);
    return sanitized === '' ? '' : sanitized;
  };
  // The shared D5 final step (parity tail-truncation vs Linux-normalized
  // opt-out) — never re-implemented here (DESIGN.md §14 D5).
  const finalize = (sanitized: string): string =>
    applyFileNamePolicy(sanitized, { mode: parts.mode, maxLength: parts.maxLength ?? 0 });

  // 1. module FileNames[] (:531-539 alignment guard)
  if (parts.fileNames !== undefined) {
    const index = Math.trunc(parts.fileNamesIndex ?? 0);
    const entry = index >= 0 && index < parts.fileNames.length ? parts.fileNames[index] : undefined;
    if (entry !== undefined && entry !== '') {
      const candidate = finalize(safe(entry));
      if (candidate !== '') return candidate;
    }
  }

  // 2. SaveImage return (LuaWebsiteModules.pas:385 luaToString result)
  if (parts.saveImageName !== undefined && parts.saveImageName !== '') {
    const candidate = finalize(safe(parts.saveImageName));
    if (candidate !== '') return candidate;
  }

  // 3. filename template (CR_* substitution). Substitution values go
  //    through the same sanitizeFileName; FMD2's FixStringLocal
  //    (uBaseUnit.pas:1804-1813) additionally entity-decodes via
  //    CommonStringFilter and optionally strips unicode (:1810-1812) —
  //    documented divergences, see the module doc.
  if (parts.template !== undefined && parts.template !== '') {
    const values: Record<string, string> = {
      [CR.numbering]: safe(parts.numbering ?? ''),
      [CR.chapter]: safe(parts.chapterName ?? ''),
      [CR.website]: safe(parts.website ?? ''),
      [CR.manga]: safe(parts.manga ?? ''),
      [CR.author]: safe(parts.author ?? ''),
      [CR.artist]: safe(parts.artist ?? ''),
      [CR.fileName]: safe(parts.saveImageName ?? ''),
    };
    const candidate = finalize(safe(substitute(parts.template, values)));
    if (candidate !== '') return candidate;
  }

  // 4. chapter name (the packer fallback, uDownloadsManager.pas:577)
  if (parts.chapterName !== undefined && parts.chapterName !== '') {
    const candidate = finalize(safe(parts.chapterName));
    if (candidate !== '') return candidate;
  }

  throw new Error('chapter filename resolution produced no candidate');
}

/** The §7.3 packer output formats → library file extensions. */
export type ChapterFileFormat = 'zip' | 'cbz' | 'pdf' | 'epub';

/**
 * [parity-sweep] M5/M6: the itemized output-rename options (FMD2
 * lfm:3947/4183/4014), applied to the resolved chapter base name
 * BEFORE the final truncation:
 *
 * - `removeMangaName` (lfm:4014): strip a leading manga-title prefix
 *   from the chapter name (case-insensitive contains-prefix on the
 *   sanitized forms; trailing separators/spaces after the strip are
 *   trimmed). FMD2 strips the site-provided "MangaName ChapterN" prefix
 *   so chapter files sort by chapter alone.
 * - `unicodeReplacement` (lfm:3947/4183): every non-ASCII char in the
 *   name is replaced with `replacementChar` (contiguous runs collapse
 *   to one — FMD2's string-replace loops collapse per char; runs keep
 *   archive listings readable). Off = byte-parity (no change).
 */
export function applyOutputRenameOptions(
  name: string,
  options: {
    readonly unicodeReplacement: boolean;
    readonly unicodeReplacementChar: string;
    readonly removeMangaName: boolean;
  },
  mangaTitle: string,
): string {
  let out: string = name;
  if (options.removeMangaName) {
    const lowered: string = out.toLowerCase();
    const title: string = sanitizeFileName(mangaTitle).toLowerCase();
    if (title !== '' && lowered.startsWith(title)) {
      out = out.slice(title.length).replace(/^[\s\-_:,.]+/, '');
    }
  }
  if (options.unicodeReplacement) {
    const replacement: string = options.unicodeReplacementChar;
    let replaced: string = '';
    let lastWasReplacement = false;
    for (const ch of out) {
      if (ch.charCodeAt(0) <= 0x7f) {
        replaced += ch;
        lastWasReplacement = false;
      } else if (!lastWasReplacement) {
        replaced += replacement;
        lastWasReplacement = true;
      }
    }
    out = replaced;
  }
  return out;
}

export function normalizeChapterExtension(ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  if (normalized !== 'zip' && normalized !== 'cbz' && normalized !== 'pdf' && normalized !== 'epub') {
    throw new Error(`unknown chapter format extension: ${JSON.stringify(ext)}`);
  }
  return normalized;
}

/**
 * Deterministic work-dir/library segment for a URL's tail (path-safe):
 * the §7.1 layout derivation shared by the download lane (work dir +
 * finalize segments) and the library file-state service (expected
 * convention directory, legacy segment matching). ONE derivation —
 * never a second opinion about where a title's files live.
 */
export function urlSegment(url: string, fallback: string): string {
  const tail = url.split('?')[0]?.split('#')[0]?.split('/').filter((s) => s !== '').at(-1);
  let decoded = tail ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw tail (malformed escape)
  }
  const sanitized = sanitizeFileName(decoded);
  return sanitized === '' ? fallback : truncateKeepTail(sanitized, 80);
}
