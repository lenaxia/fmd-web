/**
 * ComicInfo.xml (D1 §2 EXIT — "ComicInfo metadata-only"): the embedded
 * scanner metadata contract. The builder is pinned here field by
 * field, and the zip-family packers are pinned to embed it as the
 * FIRST entry of every cbz/zip output — Komga/Kavita read it from the
 * archive, fmd-web never reads it back (the D1 ruling).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildComicInfoXml,
  COMIC_INFO_ENTRY_NAME,
  createPacker,
  readZipEntry,
  walkZipCentralDirectory,
} from '../../../src/jobs/packers/index.js';
import { writeSmallChapter } from './fixtures.js';

let parentDir: string | undefined;

async function parent(): Promise<string> {
  parentDir ??= await mkdtemp(join(tmpdir(), 'comic-info-test-'));
  return parentDir;
}

afterAll(async (): Promise<void> => {
  if (parentDir !== undefined) {
    await rm(parentDir, { recursive: true, force: true });
  }
});

describe('buildComicInfoXml — the scan-target field contract', (): void => {
  it('emits Series/Title/Web/Notes; Series first, XML-declared UTF-8', (): void => {
    const xml = buildComicInfoXml({
      series: 'Fixture Manga',
      title: 'The Beginning',
      web: 'https://example.test/manga/1',
      notes: 'FixtureSite',
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema"');
    expect(xml).toContain('<Series>Fixture Manga</Series>');
    expect(xml).toContain('<Title>The Beginning</Title>');
    expect(xml).toContain('<Web>https://example.test/manga/1</Web>');
    expect(xml).toContain('<Notes>FixtureSite</Notes>');
    // Series is the FIRST child (the scanner's primary grouping key).
    expect(xml.indexOf('<Series>')).toBeLessThan(xml.indexOf('<Title>'));
    expect(xml.trimEnd().endsWith('</ComicInfo>')).toBe(true);
  });

  it('deliberately emits NO Number/Volume (D1 §5: readers parse labels/filenames better)', (): void => {
    const xml = buildComicInfoXml({ series: 'S', title: 'T', web: 'https://x/', notes: 'N' });
    expect(xml).not.toMatch(/<Number>/);
    expect(xml).not.toMatch(/<Volume>/);
    expect(xml).not.toMatch(/<AlternateNumber>/);
  });

  it('XML-escapes field text (a label can carry any site punctuation)', (): void => {
    const xml = buildComicInfoXml({
      series: 'A & B <Test> "Quoted"',
      title: "It's Chapter: 5?",
    });
    expect(xml).toContain('<Series>A &amp; B &lt;Test&gt; &quot;Quoted&quot;</Series>');
    expect(xml).toContain("<Title>It&apos;s Chapter: 5?</Title>");
  });

  it('omits empty optional fields entirely (never empty elements)', (): void => {
    const xml = buildComicInfoXml({ series: 'S', title: 'T' });
    expect(xml).not.toContain('<Web>');
    expect(xml).not.toContain('<Notes>');
  });
});

describe('zip-family packers embed ComicInfo.xml as the first entry', (): void => {
  it.each(['zip', 'cbz'] as const)(
    '%s: ComicInfo.xml precedes the pages and round-trips byte-exact',
    async (format): Promise<void> => {
      const fixture = await writeSmallChapter(await parent(), [
        { kind: 'png' as const },
        { kind: 'jpeg' as const },
      ]);
      const result = await createPacker(format).pack(fixture.pages, {
        outputDir: join(await parent(), `${format}-comicinfo`),
        comicInfo: {
          series: 'Fixture Manga',
          title: 'The Beginning',
          web: 'https://example.test/manga/1',
          notes: 'FixtureSite',
        },
      });
      const walk = await walkZipCentralDirectory(result.filePath);
      expect(walk.entries.map((entry): string => entry.name)).toEqual([
        COMIC_INFO_ENTRY_NAME,
        ...fixture.pages.map((page): string => page.fileName),
      ]);
      const bytes = await readZipEntry(result.filePath, COMIC_INFO_ENTRY_NAME);
      expect(bytes.toString('utf8')).toBe(
        buildComicInfoXml({
          series: 'Fixture Manga',
          title: 'The Beginning',
          web: 'https://example.test/manga/1',
          notes: 'FixtureSite',
        }),
      );
    },
  );

  it('no comicInfo option → no ComicInfo.xml entry (the pre-scan-target pack shape)', async (): Promise<void> => {
    const fixture = await writeSmallChapter(await parent(), [{ kind: 'png' as const }]);
    const result = await createPacker('cbz').pack(fixture.pages, {
      outputDir: join(await parent(), 'cbz-plain'),
    });
    const walk = await walkZipCentralDirectory(result.filePath);
    expect(walk.entryCount).toBe(1);
    expect(walk.entries.some((entry): boolean => entry.name === COMIC_INFO_ENTRY_NAME)).toBe(false);
  });
});
