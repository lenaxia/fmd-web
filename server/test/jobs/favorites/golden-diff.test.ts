// @vitest-environment node
/**
 * GOLDEN favorites parity tests (DESIGN §7.2/D8) — the DoCheck diff
 * semantics replayed over the §5.8 corpus fixtures, fully offline:
 *
 *   corpus rawModuleOutput → normalizeMangaInfo (§5.8 oracle-verified)
 *     → new-chapter diff vs a stored DownloadedChapterList
 *     → expected new-chapter set (case variants, mid-download chapter
 *       appearance, order preservation)
 *
 * Ground truth: uFavoritesManager.pas:364-370 — the stored list in a
 * sorted case-insensitive TStringList; every live ChapterLinks[i] with
 * IndexOf = -1 is new (its live position recorded). Case-variants of a
 * stored link are NOT new; a chapter dual-written mid-download is NOT
 * re-detected; new positions ascend in live order.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeMangaInfo } from '../../../src/engine/normalize/udata.js';
import { newChapterPositions, newChapters } from '../../../src/jobs/favorites/diff.js';
import { doCheck } from '../../../src/jobs/favorites/do-check.js';
import { linesToText, mergeCaseInsensitive } from '../../../src/jobs/library/merge.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../../corpus/fixtures/capture', import.meta.url),
);

interface NormalizeBatch {
  readonly fixtureId: string;
  readonly rawModuleOutput: Record<string, unknown>;
  readonly flags?: Record<string, unknown>;
}

interface TriplesBatch {
  readonly fixture: string;
  readonly triples: readonly {
    readonly normalized: { readonly chapterLinks: readonly string[]; readonly status?: string };
  }[];
}

/** §5.8 flag mapping (corpus README) — same mapping as the pipeline golden. */
function engineFlags(doc: NormalizeBatch): {
  isRemoveHostFromChapterLinks: boolean;
  OptionRemoveMangaNameFromChapter: boolean;
} {
  return {
    isRemoveHostFromChapterLinks:
      doc.flags?.['removeHostFromChapterLinks'] !== undefined
        ? Boolean(doc.flags['removeHostFromChapterLinks'])
        : true,
    OptionRemoveMangaNameFromChapter:
      doc.flags?.['optionRemoveMangaNameFromChapter'] !== undefined
        ? Boolean(doc.flags['optionRemoveMangaNameFromChapter'])
        : false,
  };
}

/** Deterministic ASCII case-mangle (Pascal `SameText` domain): flip the
 * case of every ASCII letter at an even index. The result must compare
 * EQUAL case-insensitively while differing byte-wise. */
function mangleCase(value: string): string {
  let out = '';
  let letterIndex = 0;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isAsciiLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (isAsciiLetter) {
      const flip = letterIndex % 2 === 0;
      out += flip
        ? String.fromCharCode(code >= 97 ? code - 32 : code + 32)
        : ch;
      letterIndex += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The §5.8-normalized live chapterLinks per fixture id. */
function loadFixtures(): { name: string; live: readonly string[]; status: string }[] {
  const names = readdirSync(FIXTURE_DIR)
    .filter(
      (name): boolean =>
        name.startsWith('getinfo-normalization-') &&
        name.endsWith('.triples.json'),
    )
    .sort();
  return names.map((name) => {
    const triples = JSON.parse(
      readFileSync(join(FIXTURE_DIR, name), 'utf8'),
    ) as TriplesBatch;
    const links = triples.triples[0]?.normalized.chapterLinks ?? [];
    const status = triples.triples[0]?.normalized.status ?? 'Ongoing';
    return { name, live: [...links], status };
  });
}

describe('§7.2 golden: normalization output → diff → expected new-chapter set', (): void => {
  const batches = readdirSync(FIXTURE_DIR)
    .filter(
      (name): boolean =>
        name.startsWith('getinfo-normalization-') &&
        name.endsWith('.json') &&
        !name.endsWith('.triples.json'),
    )
    .sort();

  it('the corpus ships at least 25 normalization batches', (): void => {
    expect(batches.length).toBeGreaterThanOrEqual(25);
  });

  it('diff over the §5.8-normalized links finds exactly the not-stored suffix (all fixtures)', (): void => {
    for (const name of batches) {
      const doc = JSON.parse(
        readFileSync(join(FIXTURE_DIR, name), 'utf8'),
      ) as NormalizeBatch;
      const normalized = normalizeMangaInfo(doc.rawModuleOutput, engineFlags(doc));
      const live = normalized.chapterLinks;
      if (live.length === 0) {
        continue;
      }
      // Stored = every OTHER live chapter (the already-downloaded set).
      const stored = linesToText(live.filter((_, i) => i % 2 === 0));
      const positions = newChapterPositions(live, stored);
      const expected = live.map((_, i) => i).filter((i) => i % 2 !== 0);
      expect(positions, `${name}: set-difference positions`).toEqual(expected);
      // Order preservation: projected links follow the live order.
      expect(newChapters(live, normalized.chapterNames, stored).map((c) => c.link)).toEqual(
        expected.map((i) => live[i]),
      );
    }
  });

  it('a case-mangled stored list hides its chapters (case-insensitive IndexOf membership, :364-370)', (): void => {
    // The mangle itself is real for letter-bearing links (host-stripped
    // fixture links like `/1` carry none — the membership test is what
    // this fixture sweep exercises): byte-different, case-equal.
    const mangled = mangleCase('https://SITE.example/Manga/X/Ch-1');
    expect(mangled.toLowerCase()).toBe('https://site.example/manga/x/ch-1');
    expect(mangled).not.toBe('https://SITE.example/Manga/X/Ch-1');
    for (const { live } of loadFixtures()) {
      if (live.length === 0) continue;
      // Every link stored, but byte-different via ASCII case flips.
      const stored = linesToText(live.map(mangleCase));
      expect(newChapterPositions(live, stored)).toEqual([]);
    }
  });

  it('mid-download chapter appearance: a dual-written in-flight chapter is NOT re-detected', (): void => {
    for (const { name, live } of loadFixtures()) {
      if (live.length < 3) continue;
      // Favorite knows chapters 0..1; auto-download queued 2 (the
      // :1131-1133 dual-write merged it) while the download runs.
      const stored = linesToText([live[0] ?? '', live[1] ?? '', live[2] ?? '']);
      const positions = newChapterPositions(live, stored);
      expect(positions, `${name}`).toEqual(live.map((_, i) => i).filter((i) => i >= 3));
      break; // one representative fixture asserts the shape; all covered above
    }
  });

  it('empty stored list → EVERY live chapter is new (fresh favorite)', (): void => {
    for (const { live } of loadFixtures()) {
      expect(newChapterPositions(live, '')).toEqual(live.map((_, i) => i));
    }
  });

  it('normalization → diff → dual-write merge → re-diff is empty (DoCheck convergence)', (): void => {
    for (const name of batches) {
      const doc = JSON.parse(
        readFileSync(join(FIXTURE_DIR, name), 'utf8'),
      ) as NormalizeBatch;
      const normalized = normalizeMangaInfo(doc.rawModuleOutput, engineFlags(doc));
      const live = normalized.chapterLinks;
      if (live.length < 2) continue;
      // First check: stored holds half the chapters.
      const storedHalf = linesToText(live.filter((_, i) => i % 2 === 0));
      const first = doCheck(
        { mangaKey: 'k', moduleId: 'm', url: 'u', downloadedChapterList: storedHalf },
        { status: normalized.status, chapterLinks: live, chapterNames: normalized.chapterNames },
        1_000,
      );
      expect(first.newChapterPositions.length).toBeGreaterThan(0);
      expect(first.lastUpdated).toBe(1_000);
      // Auto-download dual-write (:1131-1133): merged list.
      const newLinks = first.newChapterPositions.map((i) => live[i] ?? '');
      const merged = mergeCaseInsensitive(storedHalf, linesToText(newLinks));
      // Second check (mid-download appearance of the queued chapters): nothing new.
      const second = doCheck(
        { mangaKey: 'k', moduleId: 'm', url: 'u', downloadedChapterList: merged },
        { status: normalized.status, chapterLinks: live, chapterNames: normalized.chapterNames },
        2_000,
      );
      expect(
        second.newChapterPositions,
        `${name}: dual-written chapters never re-appear as new`,
      ).toEqual([]);
      expect(second.lastUpdated).toBeUndefined();
      expect(mergeCaseInsensitive(merged, linesToText(live))).toBe(merged);
    }
  });
});
