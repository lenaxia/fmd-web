/**
 * [library-layout] The flat series folder computation (rule 1 + rule 2):
 * the duplicate suffix form, sanitization/truncation of the combined
 * component (the suffix — the discriminating tail — always survives
 * the cap), and the pure foreign-claim decision (different module, or
 * an unattributed on-disk folder).
 */
import { describe, expect, it } from 'vitest';
import {
  isForeignClaim,
  safeFolderComponent,
  suffixedMangaFolder,
} from '../../../src/jobs/library/layout.js';
import { sanitizeFileName, urlSegment } from '../../../src/jobs/library/filenames.js';

describe('safeFolderComponent', (): void => {
  it('sanitizes exactly like the finalizer component (RemoveSymbols parity + trim)', (): void => {
    expect(safeFolderComponent('My/Manga: Title?')).toBe('MyManga Title');
    expect(safeFolderComponent('  padded  ')).toBe('padded');
  });

  it('rejects a component that sanitizes away', (): void => {
    expect((): string => safeFolderComponent('???*|')).toThrow(/empty after sanitization/);
  });

  it('tail-truncates past 255 units (the tail survives)', (): void => {
    const long = 'x'.repeat(300);
    expect(safeFolderComponent(long)).toHaveLength(255);
    expect(safeFolderComponent(long).endsWith('x'.repeat(255))).toBe(true);
  });
});

describe('suffixedMangaFolder (rule 2 duplicate form)', (): void => {
  it('appends the sanitized module in brackets', (): void => {
    expect(suffixedMangaFolder('Naruto', 'MangaDex')).toBe('Naruto [MangaDex]');
    // module ids carrying path-unsafe characters are sanitized into the suffix
    expect(suffixedMangaFolder('Naruto', 'man ga: park')).toBe('Naruto [man ga park]');
  });

  it('the whole component keeps the §7.1 sanitize policy (brackets survive — not in the FMD2 Symbols set)', (): void => {
    const folder = suffixedMangaFolder('Title: With/Bad Chars', 'module/id');
    expect(folder).toBe('Title WithBad Chars [moduleid]');
  });

  it('truncation keeps the suffix (the discriminating tail), never the manga head alone', (): void => {
    const veryLongManga = 'm'.repeat(400);
    const folder = suffixedMangaFolder(veryLongManga, 'hexmodule');
    expect(folder.length).toBeLessThanOrEqual(255);
    expect(folder.endsWith(' [hexmodule]')).toBe(true);
  });

  it('is idempotent under re-sanitization (the finalizer re-sanitizes components)', (): void => {
    const folder = suffixedMangaFolder('Alpha Quest', 'moduleb');
    expect(sanitizeFileName(folder)).toBe(folder);
  });

  it('an empty-sanitizing module falls back to the plain folder', (): void => {
    expect(suffixedMangaFolder('Alpha Quest', '???')).toBe('Alpha Quest');
  });
});

describe('isForeignClaim (the claim decision)', (): void => {
  const OWN = 'modulea';
  it('no claimants and nothing on disk → not foreign (first writer takes the clean name)', (): void => {
    expect(isForeignClaim([], OWN, false)).toBe(false);
  });

  it('claimants all from the own module → not foreign', (): void => {
    expect(isForeignClaim([OWN], OWN, true)).toBe(false);
  });

  it('a different module among the claimants → foreign (suffix)', (): void => {
    expect(isForeignClaim(['moduleb'], OWN, false)).toBe(true);
    expect(isForeignClaim([OWN, 'moduleb'], OWN, false)).toBe(true);
  });

  it('an unattributed on-disk folder (no ledger claimants) → foreign (unknown claim, conservative)', (): void => {
    expect(isForeignClaim([], OWN, true)).toBe(true);
  });
});

describe('clean folder derivation is the unchanged §7.1 manga segment policy', (): void => {
  it('urlSegment keeps its sanitize + truncate-80 + url-tail fallback derivation', (): void => {
    expect(urlSegment('Fixture Manga', 'manga')).toBe('Fixture Manga');
    expect(urlSegment('https://ex.org/manga/alpha-quest?x=1', 'manga')).toBe('alpha-quest');
    expect(urlSegment('', 'manga')).toBe('manga');
  });
});
