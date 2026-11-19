/**
 * [library-layout] Lane-level contract: downloading the SAME series
 * from two seeded modules lands as `<manga>/` and `<manga>
 * [<module2>]/` (first writer keeps the clean name; the module is not
 * a path segment anywhere), re-downloads stay on the recorded folder
 * (never recomputed), and a saveTo override still REPLACES the computed
 * prefix with no folder derived. REAL queue + packers + library store;
 * stubbed engine hooks over the loopback fixture site.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FixtureMangaSite } from '../jobs/download/fixture-site.js';
import { WsHub } from '../../src/api/ws/hub.js';
import { ActiveDownloadRegistry, downloadLane } from '../../src/runtime/download-lane.js';
import type { DownloadLaneDeps } from '../../src/runtime/download-lane.js';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import type { OutputDefaultsT } from '../../src/api/schemas.js';
import type { ChapterModuleHooks, TaskWriter } from '../../src/jobs/download/types.js';
import type { EngineDownloadOptions, ModuleDownloadHooks } from '../../src/engine/facade.js';
import { mkTmpDir, openHarness, rmDir } from '../jobs/helpers.js';

const MODULE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MODULE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAGE_COUNT = 2;
const CHAPTER_PATH = '/manga/chapter-1';

const OUTPUT: OutputDefaultsT = {
  format: 'zip',
  chapterNameTemplate: '',
  unicodeReplacement: false,
  unicodeReplacementChar: '_',
  digitPadding: 0,
  removeMangaName: false,
};

function fixtureSiteHooks(base: string): ChapterModuleHooks {
  return {
    getPageNumber: async (task: TaskWriter, url: string): Promise<boolean> => {
      const page = await fetch(url);
      if (!page.ok) {
        return false;
      }
      task.pageNumber = PAGE_COUNT;
      for (let i = 0; i < PAGE_COUNT; i += 1) {
        task.pageLinks[i] = `${base}/img/p${i}`;
      }
      return true;
    },
    getImageURL: async (): Promise<boolean> => true,
    dispose: async (): Promise<void> => undefined,
  } as unknown as ChapterModuleHooks;
}

describe('download lane — flat series layout (library relayout)', (): void => {
  let site: FixtureMangaSite;
  let base = '';
  let dir = '';
  let queue: ReturnType<typeof openHarness>['queue'];
  let library: SqliteLibraryStore;
  let db: InstanceType<typeof Database>;

  beforeEach((): void => {
    site = new FixtureMangaSite({ minImageMs: 1 });
    dir = mkTmpDir('lane-layout-');
  });

  afterEach((): void => {
    void site.stop();
    db.close();
    queue.close();
    rmDir(dir);
  });

  const setup = (): {
    run: (moduleId: string, mangaUrl: string, chapter: string, saveTo?: string, chapterName?: string) => Promise<{ type: string }>;
  } => {
    const harness = openHarness(dir);
    queue = harness.queue;
    db = new Database(path.join(dir, 'lib.db'));
    library = new SqliteLibraryStore({ db, libraryRoot: path.join(dir, 'library') });
    const deps: DownloadLaneDeps = {
      queue,
      wsHub: new WsHub(),
      library,
      dataDir: dir,
      engine: { modules: (): readonly unknown[] => [] } as never,
      createHooks: (_moduleId: string, _engine: EngineDownloadOptions): Promise<ModuleDownloadHooks> =>
        Promise.resolve(fixtureSiteHooks(base) as ModuleDownloadHooks),
      active: new ActiveDownloadRegistry(),
      log: (): void => undefined,
      outputDefaults: (): OutputDefaultsT => OUTPUT,
    };
    const lane = downloadLane(deps);
    return {
      run: (moduleId, mangaUrl, chapter, saveTo, chapterName = 'Chapter 1'): Promise<{ type: string }> => {
        const { job } = queue.enqueue({
          type: 'download',
          moduleId,
          mangaUrl,
          mangaTitle: 'Alpha Quest',
          chapterLink: chapter,
          chapterName,
          ...(saveTo !== undefined ? { saveTo } : {}),
        } as never);
        return lane
          .handler(
            job as never,
            { setProgress: (): void => undefined } as never,
          )
          .then((outcome) => outcome as { type: string });
      },
    };
  };

  it('the same series from two seeded modules lands as <manga>/ and <manga> [<module2>]/', async (): Promise<void> => {
    base = await site.start();
    const { run } = setup();

    const a = await run(MODULE_A, 'https://ex.org/manga/alpha', `${base}${CHAPTER_PATH}`);
    expect(a.type).toBe('done');
    const b = await run(MODULE_B, 'https://other.org/series/alpha', `${base}${CHAPTER_PATH}`);
    expect(b.type).toBe('done');

    const rows = library.allLibraryLedgerRows();
    const paths = rows.map((r): string => r.path).sort();
    const root = path.join(dir, 'library');
    // ' ' sorts before the path separator — the suffixed home is first.
    expect(paths).toEqual([
      path.join(root, `Alpha Quest [${MODULE_B}]`, 'Chapter 1.zip'),
      path.join(root, 'Alpha Quest', 'Chapter 1.zip'),
    ]);
    // Both artifacts exist on disk at the flat homes.
    for (const p of paths) {
      expect(fs.existsSync(p)).toBe(true);
    }
    // The ledger rows record the effective folders + module metadata.
    const cleanRow = rows.find((r): boolean => r.path.endsWith(path.join('Alpha Quest', 'Chapter 1.zip')));
    expect(cleanRow?.manga).toBe('Alpha Quest');
    expect(cleanRow?.moduleId).toBe(MODULE_A);
    const suffixedRow = rows.find((r): boolean => r.path.includes('['));
    expect(suffixedRow?.manga).toBe(`Alpha Quest [${MODULE_B}]`);
    expect(suffixedRow?.moduleId).toBe(MODULE_B);
  });

  it('re-downloads stay on the SAME folder (computed once, never re-pointed)', async (): Promise<void> => {
    base = await site.start();
    const { run } = setup();

    await run(MODULE_A, 'https://ex.org/manga/alpha', `${base}${CHAPTER_PATH}`);
    await run(MODULE_B, 'https://other.org/series/alpha', `${base}${CHAPTER_PATH}`);
    // A SECOND chapter from module B (the fixture site serves one
    // recorded chapter page; the differing chapterName yields the next
    // artifact) must land beside the first — the suffixed folder is
    // sticky even though the clean folder exists.
    const again = await run(MODULE_B, 'https://other.org/series/alpha', `${base}${CHAPTER_PATH}`, undefined, 'Chapter 2');
    expect(again.type).toBe('done');
    const root = path.join(dir, 'library');
    const bRows = library
      .allLibraryLedgerRows()
      .filter((r): boolean => r.moduleId === MODULE_B)
      .map((r): string => r.path);
    expect(bRows).toHaveLength(2);
    expect(
      bRows.every((p) => p.startsWith(path.join(root, `Alpha Quest [${MODULE_B}]`))),
    ).toBe(true);
  });

  it('saveTo precedence: an override REPLACES the computed prefix and no effective folder is derived', async (): Promise<void> => {
    base = await site.start();
    const { run } = setup();

    const overridden = await run(MODULE_A, 'https://ex.org/manga/alpha', `${base}${CHAPTER_PATH}`, 'custom/target');
    expect(overridden.type).toBe('done');

    const rows = library.allLibraryLedgerRows();
    expect(rows).toHaveLength(1);
    const root = path.join(dir, 'library');
    expect(rows[0]?.path).toBe(path.join(root, 'custom', 'target', 'Chapter 1.zip'));
    expect(fs.existsSync(rows[0]?.path ?? '')).toBe(true);
    // No clean-name folder was created for the overridden download.
    expect(fs.existsSync(path.join(root, 'Alpha Quest'))).toBe(false);
  });
});
