/**
 * ComicInfo.xml (D1 §2 EXIT — "ComicInfo metadata-only"): the
 * ComicRack-schema metadata document written INTO each cbz/zip output
 * for the Komga/Kavita scanner. fmd-web WRITES it and never reads,
 * parses, edits, or displays it (the D1 ruling — readers are the
 * parsers).
 *
 * Field set (deliberately minimal, the scan-target contract only):
 *
 * - `Series`   — the effective series FOLDER name (clean sanitized
 *                title, or the suffixed `<manga> [<module>]` duplicate
 *                form; saveTo downloads use the target directory's
 *                basename): D1 §3 "folder name = ComicInfo Series", so
 *                a scanner grouping by folder and a scanner grouping
 *                by Series agree by construction.
 * - `Title`    — the chapter label (the same site-provided name the
 *                filename carries).
 * - `Web`      — the manga's canonical URL (the source location;
 *                Komga/Kavita render it as the series link).
 * - `Notes`    — the source website label (the module name, the
 *                %WEBSITE% token's value).
 *
 * Deliberately NO `Number`/`Volume`: D1 §5 killed chapter-number
 * parsing (numbers parsed from titles are lossy and site-idiosyncratic;
 * numbering is positional per site), and the readers parse the
 * zero-padded positional `<numbering> ` filename prefix better than a
 * guessed comic-number field ever would. The schema permits the
 * elements; fmd-web never emits them.
 */

/** The archive entry name the scanners look for. */
export const COMIC_INFO_ENTRY_NAME = 'ComicInfo.xml';

/** Structured ComicInfo input (all fields except series/title optional). */
export interface ComicInfoInput {
  /** Series — MUST equal the series folder name (D1 §3). */
  readonly series: string;
  /** Title — the chapter label. */
  readonly title: string;
  /** Web — the manga's canonical URL (the source location). */
  readonly web?: string;
  /** Notes — the source website label (module name). */
  readonly notes?: string;
}

/** XML-escape a text node (ampersand first so entities cannot double). */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Build the ComicInfo.xml document (UTF-8, the ComicRack
 * `http://www.wyrmcorp.com/guidelines/comicinfo.xsd` convention —
 * schema-namespace attributes carried like every mainstream writer
 * emits them). Empty optional fields are omitted entirely; an
 * all-empty input still yields a valid document with Series/Title.
 */
export function buildComicInfoXml(input: ComicInfoInput): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Series>${escapeXml(input.series)}</Series>`,
    `  <Title>${escapeXml(input.title)}</Title>`,
  ];
  if (input.web !== undefined && input.web !== '') {
    lines.push(`  <Web>${escapeXml(input.web)}</Web>`);
  }
  if (input.notes !== undefined && input.notes !== '') {
    lines.push(`  <Notes>${escapeXml(input.notes)}</Notes>`);
  }
  lines.push('</ComicInfo>', '');
  return `${lines.join('\n')}`;
}
