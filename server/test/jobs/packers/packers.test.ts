import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createPacker,
  packJobFailure,
  PackError,
  validateEpub,
  validatePdf,
  validateZipArchive,
} from '../../../src/jobs/packers/index.js';
import { writeSmallChapter } from './fixtures.js';

/**
 * Structural validation of every pack format (DESIGN.md §13, §7.3) —
 * dedicated validators per format, plus the reading-order checks:
 * ZIP entry order and EPUB spine order must equal the chapter page
 * order, and CBZ must be recognized as a plain ZIP.
 */

const SMALL_CHAPTER = [
  { kind: 'png' as const },
  { kind: 'jpeg' as const },
  { kind: 'png' as const },
  { kind: 'jpeg' as const },
  { kind: 'png' as const },
  { kind: 'png' as const },
];

const EXPECTED_ZIP_ENTRIES = ['0001.png', '0002.jpg', '0003.png', '0004.jpg', '0005.png', '0006.png'];
const EXPECTED_SPINE_HREFS = [
  'text/p0001.xhtml',
  'text/p0002.xhtml',
  'text/p0003.xhtml',
  'text/p0004.xhtml',
  'text/p0005.xhtml',
  'text/p0006.xhtml',
];

let parentDir: string | undefined;

async function parent(): Promise<string> {
  parentDir ??= await mkdtemp(join(tmpdir(), 'packers-test-'));
  return parentDir;
}

afterAll(async () => {
  if (parentDir !== undefined) {
    await rm(parentDir, { recursive: true, force: true });
  }
});

describe('packers — ZIP structural validation (central-directory walk)', () => {
  it('packs a chapter whose entries are present, ordered, and CRC-valid', async () => {
    const fixture = await writeSmallChapter(await parent(), SMALL_CHAPTER);
    const packer = createPacker('zip');
    const result = await packer.pack(fixture.pages, { outputDir: join(await parent(), 'zip-out') });

    expect(result.format).toBe('zip');
    expect(result.pageCount).toBe(6);
    expect(result.bytes).toBeGreaterThan(fixture.totalImageBytes);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    const validation = await validateZipArchive(result.filePath, EXPECTED_ZIP_ENTRIES);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.entryCount).toBe(6);
    for (const entry of validation.entries) {
      expect(entry.crcOk).toBe(true);
      expect(entry.sizeOk).toBe(true);
      expect(entry.localNameMatches).toBe(true);
      expect([0, 8]).toContain(entry.method);
    }
  });

  it('reads one entry back through the validator (round-trip)', async () => {
    const fixture = await writeSmallChapter(await parent(), SMALL_CHAPTER);
    const result = await createPacker('zip').pack(fixture.pages, {
      outputDir: join(await parent(), 'zip-out2'),
    });
    const { readZipEntry } = await import('../../../src/jobs/packers/index.js');
    const data = await readZipEntry(result.filePath, '0002.jpg');
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toBe(0xff); // JPEG SOI
    expect(data[1]).toBe(0xd8);
  });
});

describe('packers — CBZ is a ZIP by another extension', () => {
  it('packs .cbz output that the ZIP validator accepts', async () => {
    const fixture = await writeSmallChapter(await parent(), SMALL_CHAPTER);
    const result = await createPacker('cbz').pack(fixture.pages, {
      outputDir: join(await parent(), 'cbz-out'),
    });
    expect(result.format).toBe('cbz');
    expect(result.filePath.endsWith('.cbz')).toBe(true);
    const validation = await validateZipArchive(result.filePath, EXPECTED_ZIP_ENTRIES);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

describe('packers — EPUB structural validation (reading order)', () => {
  it('packs an EPUB with mimetype first (stored), OPF, and a spine in chapter order', async () => {
    const fixture = await writeSmallChapter(await parent(), SMALL_CHAPTER);
    const result = await createPacker('epub').pack(fixture.pages, {
      outputDir: join(await parent(), 'epub-out'),
      title: 'Small Chapter <&>',
    });
    expect(result.format).toBe('epub');
    expect(result.pageCount).toBe(6);

    const validation = await validateEpub(result.filePath, EXPECTED_SPINE_HREFS);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.mimetypeFirstStored).toBe(true);
    expect(validation.opfPath).toBe('OEBPS/content.opf');
    expect(validation.spineHrefs).toEqual(EXPECTED_SPINE_HREFS);
    expect(validation.imageCount).toBe(6);
  });

  it('flags a tampered EPUB whose spine diverges from chapter order', async () => {
    const fixture = await writeSmallChapter(await parent(), SMALL_CHAPTER);
    const result = await createPacker('epub').pack(fixture.pages, {
      outputDir: join(await parent(), 'epub-out2'),
    });
    const reversed = [...EXPECTED_SPINE_HREFS].reverse();
    const validation = await validateEpub(result.filePath, reversed);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toContain('reading order mismatch');
  });
});

describe('packers — PDF structural validation (incremental writer)', () => {
  it('packs a PDF whose parsed page count matches and every page embeds its image', async () => {
    const fixture = await writeSmallChapter(await parent(), SMALL_CHAPTER);
    const result = await createPacker('pdf').pack(fixture.pages, {
      outputDir: join(await parent(), 'pdf-out'),
      title: 'Small Chapter',
    });
    expect(result.format).toBe('pdf');
    expect(result.pageCount).toBe(6);
    expect(result.bytes).toBeGreaterThan(fixture.totalImageBytes);

    const validation = await validatePdf(result.filePath, 6);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.pageCount).toBe(6);
    expect(validation.declaredCount).toBe(6);
    expect(validation.pages).toHaveLength(6);
    for (const page of validation.pages) {
      expect(page.hasPageType).toBe(true);
      expect(page.contentsObjectId).toBeGreaterThan(0);
      expect(page.imageObjectId).toBeGreaterThan(0);
    }
    // Mixed sources: RGB PNG pages (FlateDecode+predictor) and grayscale JPEG pages (DCTDecode).
    const filters = new Set(validation.pages.map((page) => page.imageObjectId));
    expect(filters.size).toBe(6);
  });

  it('rejects unsupported page images as pack failures with the re-encode hint', async () => {
    const fixture = await writeSmallChapter(await parent(), [...SMALL_CHAPTER, { kind: 'gif' }]);
    const packError = await createPacker('pdf')
      .pack(fixture.pages, { outputDir: join(await parent(), 'pdf-out2') })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(packError).toBeInstanceOf(PackError);
    expect((packError as PackError).kind).toBe('pack-unsupported-image');
    expect((packError as PackError).recoveryHint).toBe('re-encode-pages');
    const failure = packJobFailure(packError);
    expect(failure.kind).toBe('pack');
    expect(failure.retryable).toBe(true);
    expect(failure.recoveryHint).toBe('re-encode-pages');
    // The failed pack left no temp output behind.
    const leftovers = await readdir(join(await parent(), 'pdf-out2'));
    expect(leftovers).toEqual([]);
  });

  it('stores GIF pages fine in ZIP/CBZ (only the PDF path needs decode)', async () => {
    const fixture = await writeSmallChapter(await parent(), [...SMALL_CHAPTER, { kind: 'gif' }]);
    const result = await createPacker('zip').pack(fixture.pages, {
      outputDir: join(await parent(), 'zip-gif-out'),
    });
    const validation = await validateZipArchive(result.filePath, [
      ...EXPECTED_ZIP_ENTRIES,
      '0007.gif',
    ]);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

describe('packers — failure mapping (D16: pack failures are retryable)', () => {
  it('maps budget-exceeded and watchdog errors to the retryable pack kind', () => {
    const budget = packJobFailure(
      new PackError('pack-budget-exceeded', 'over budget', { recoveryHint: 're-encode-pages' }),
    );
    expect(budget).toMatchObject({ state: 'failed', kind: 'pack', retryable: true });
    expect(budget.recoveryHint).toBe('re-encode-pages');

    const watchdog = packJobFailure(new PackError('pack-watchdog-timeout', 'too slow'));
    expect(watchdog).toMatchObject({ state: 'failed', kind: 'pack', retryable: true });

    const unexpected = packJobFailure(new Error('disk exploded'));
    expect(unexpected.kind).toBe('pack');
    expect(unexpected.retryable).toBe(true);
  });
});
