/**
 * The Komga/Kavita scan-target contract, pinned on a GENERATED fixture
 * (D1 §2 EXIT): a real cbz pack through the real finalizer, repeated
 * across series, then the tree is inspected exactly the way a scanner
 * sweeps it — folder-per-series grouping, parseable
 * `<numbering> <chapter>` filenames, a readable ComicInfo.xml whose
 * Series equals the containing folder, the `.cbz` extension, and NO
 * dotfiles or staging residue anywhere under the root. Atomic
 * appearance (no partial file ever observable at the final path) is
 * drilled through every finalize fault point.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildComicInfoXml, COMIC_INFO_ENTRY_NAME, createPacker, readZipEntry, walkZipCentralDirectory } from '../../../src/jobs/packers/index.js';
import { formatChapterNumbering } from '../../../src/jobs/library/filenames.js';
import { LibraryFinalizer } from '../../../src/jobs/library/finalize.js';
import type { FinalizeFaultPoint } from '../../../src/jobs/library/finalize.js';
import { writeSmallChapter } from '../packers/fixtures.js';
import { mkTmpDir, rmDir } from '../helpers.js';

let dir = '';
let workDir = '';
let libraryRoot = '';

beforeEach((): void => {
  dir = mkTmpDir('komga-scan-target-');
  workDir = path.join(dir, 'work');
  libraryRoot = path.join(dir, 'library');
  fs.mkdirSync(workDir, { recursive: true });
});

afterEach((): void => {
  rmDir(dir);
});

interface ChapterSpec {
  readonly manga: string;
  readonly position: number;
  readonly chapterLabel: string;
}

/** Pack + finalize one chapter exactly the way the lane does. */
async function deliver(
  finalizer: LibraryFinalizer,
  spec: ChapterSpec,
): Promise<{ path: string; bytes: number; packedBytes: number }> {
  const fixture = await writeSmallChapter(workDir, [
    { kind: 'png' as const },
    { kind: 'jpeg' as const },
    { kind: 'png' as const },
  ]);
  const fileName = `${formatChapterNumbering(spec.position, 0)} ${spec.chapterLabel}`;
  const packed = await createPacker('cbz').pack(fixture.pages, {
    outputDir: path.join(workDir, 'pack'),
    comicInfo: {
      series: spec.manga,
      title: spec.chapterLabel,
      web: 'https://example.test/manga/1',
      notes: 'FixtureSite',
    },
  });
  const finalized = finalizer.finalize({
    manga: spec.manga,
    fileName,
    ext: 'cbz',
    sourcePath: packed.filePath,
  });
  return { path: finalized.path, bytes: finalized.bytes, packedBytes: packed.bytes };
}

/** Recursive readdir of every entry under the root (the scanner sweep). */
function sweepTree(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('generated fixture — the Komga/Kavita scan-target convention', (): void => {
  it('folder-per-series, parseable filenames, readable ComicInfo, .cbz, zero residue', async (): Promise<void> => {
    const finalizer = new LibraryFinalizer({ libraryRoot });
    const specs: readonly ChapterSpec[] = [
      { manga: 'Series Alpha', position: 1, chapterLabel: 'The Beginning' },
      { manga: 'Series Alpha', position: 2, chapterLabel: 'The Middle' },
      // duplicate title from a second site: the suffixed duplicate form
      // (D1 §3 — first writer keeps the clean name, later series takes
      // the [<module>] suffix; the lane computes it, the finalizer
      // writes it, ComicInfo carries it as its Series)
      { manga: 'Series Alpha [othermodule]', position: 9, chapterLabel: 'Cross Post' },
      { manga: 'Series Beta', position: 123, chapterLabel: 'Much Later' },
    ];
    const delivered: { spec: ChapterSpec; result: { path: string; bytes: number; packedBytes: number } }[] = [];
    for (const spec of specs) {
      delivered.push({ spec, result: await deliver(finalizer, spec) });
    }

    // ── the scanner's sweep of the library root ──
    const tree = sweepTree(libraryRoot);
    // (1) .cbz extension on every file; files ONLY (no stray dirs).
    const files = tree.filter((entry): boolean => fs.statSync(path.join(libraryRoot, entry)).isFile());
    expect(files.length).toBe(specs.length);
    for (const file of files) {
      expect(file.endsWith('.cbz'), file).toBe(true);
      // (2) fixed two-level layout: <series>/<file> — folder-per-series.
      expect(file.split(path.sep), file).toHaveLength(2);
      // (3) parseable filename: zero-padded numbering + site label.
      expect(file, file).toMatch(/^[^/\\]+[/\\]\d{4} .+\.cbz$/);
    }
    // (4) exactly three series folders — grouping by title, the
    // duplicate folded into its suffixed folder.
    const folders = new Set(files.map((file): string => file.split(path.sep)[0] ?? ''));
    expect([...folders].sort()).toEqual(['Series Alpha', 'Series Alpha [othermodule]', 'Series Beta']);
    // (5) NO dotfiles or temp residue anywhere in the tree.
    for (const entry of tree) {
      const base = path.basename(entry);
      expect(base.startsWith('.'), entry).toBe(false);
    }

    // ── per-file: bytes complete at the final path + ComicInfo ──
    for (const { spec, result } of delivered) {
      expect(result.bytes).toBe(result.packedBytes);
      expect(fs.statSync(result.path).size).toBe(result.packedBytes);
      const walk = await walkZipCentralDirectory(result.path);
      expect(walk.entries[0]?.name).toBe(COMIC_INFO_ENTRY_NAME);
      const xml = (await readZipEntry(result.path, COMIC_INFO_ENTRY_NAME)).toString('utf8');
      // Series matches the containing folder name — the D1 §3 line.
      const folder = path.basename(path.dirname(result.path));
      expect(xml).toContain(`<Series>${folder}</Series>`);
      expect(folder).toBe(spec.manga);
      expect(xml).toContain(`<Title>${spec.chapterLabel}</Title>`);
      expect(xml).not.toMatch(/<(Number|Volume)>/);
      // byte-exact against the same builder the packer used
      expect(xml).toBe(
        buildComicInfoXml({
          series: spec.manga,
          title: spec.chapterLabel,
          web: 'https://example.test/manga/1',
          notes: 'FixtureSite',
        }),
      );
      // pages follow the metadata, in reading order
      expect(walk.entries.map((entry): string => entry.name)).toEqual([
        COMIC_INFO_ENTRY_NAME,
        '0001.png',
        '0002.jpg',
        '0003.png',
      ]);
    }
  });

  it('atomic appearance: a crash at EVERY finalize boundary never exposes a partial file at the final path', async (): Promise<void> => {
    const points: readonly FinalizeFaultPoint[] = [
      'begin',
      'before-stage',
      'after-stage',
      'before-relocate',
      'after-relocate',
      'before-commit',
    ];
    for (const point of points) {
      const target = path.join(libraryRoot, 'Crashy Series');
      const fixture = await writeSmallChapter(workDir, [{ kind: 'png' as const }]);
      const packed = await createPacker('cbz').pack(fixture.pages, {
        outputDir: path.join(workDir, 'pack'),
        comicInfo: { series: 'Crashy Series', title: 'Halfway' },
      });
      const source = path.join(workDir, 'source.cbz');
      fs.copyFileSync(packed.filePath, source);
      const sourceBytes = fs.statSync(source).size;
      const finalizer = new LibraryFinalizer({
        libraryRoot,
        crash: (hit): void => {
          if (hit === point) {
            throw new Error(`simulated crash at ${point}`);
          }
        },
      });
      expect(() =>
        finalizer.finalize({ manga: 'Crashy Series', fileName: '0001 Halfway', ext: 'cbz', sourcePath: source }),
      ).toThrow(`simulated crash at ${point}`);
      // the invariant: the final path is ABSENT or COMPLETE — never a
      // partial .cbz a scanner could sweep mid-write.
      const finalPath = path.join(target, '0001 Halfway.cbz');
      if (fs.existsSync(finalPath)) {
        expect(fs.statSync(finalPath).size, point).toBe(sourceBytes);
      } else {
        // residue is .tmp- litter only — sweepable, never at a final
        // name (the dir may not exist yet at the early fault points).
        if (fs.existsSync(target)) {
          const litter = fs.readdirSync(target).filter((name): boolean => name.startsWith('.tmp-'));
          for (const name of litter) {
            expect(name.startsWith('.tmp-')).toBe(true);
          }
          expect(new LibraryFinalizer({ libraryRoot }).sweepLeftovers(target)).toBe(litter.length);
          expect(fs.readdirSync(target)).toEqual([]);
        }
      }
    }
  });
});
