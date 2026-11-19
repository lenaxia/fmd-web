/**
 * [settings-parity] Output defaults are HONORED ON NEW JOBS (FMD2
 * Save-to parity, PUT /api/settings/output): the download lane reads
 * the settings provider PER-JOB at pack/finalize time — format → §7.3
 * packer selection + the FMD2 progress-stage names (COMPRESS for
 * zip/cbz, CONVERT for pdf/epub), chapterNameTemplate → the artifact
 * filename ('' keeps the chapter-name fallback). The engine seam
 * (EngineDownloadHooks — one wasmoon VM per chapter run) is stubbed
 * onto the SAME local fixture manga site the §7.1 download suite
 * drives; the queue, the packers and the library store are the REAL
 * implementations, so the full claim → download → pack → finalize →
 * ledger path runs end-to-end offline (§13 loopback only).
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
import { readZipEntry, walkZipCentralDirectory } from '../../src/jobs/packers/index.js';
import type { OutputDefaultsT } from '../../src/api/schemas.js';
import type { ChapterModuleHooks, TaskWriter } from '../../src/jobs/download/types.js';
import type { EngineDownloadOptions, ModuleDownloadHooks } from '../../src/engine/facade.js';
import { mkTmpDir, openHarness, rmDir } from '../jobs/helpers.js';

const MODULE_ID = 'a'.repeat(32);
const PAGE_COUNT = 4;
const CHAPTER_PATH = '/manga/chapter-1';

// ENGINE-BOUNDARY (tsk-linear-varnish-restricts): the old path-mock of
// runtime/download-engine.js is gone with the module — the lane's
// createHooks SEAM (the substrate factory injection point) is the stub
// surface now, exactly like the production assembly wires the substrate.
const engineStub: { create: (moduleId: string, engine: EngineDownloadOptions) => Promise<ModuleDownloadHooks> } = {
  create: async (): Promise<ModuleDownloadHooks> => {
    throw new Error('engine stub not installed');
  },
};

/**
 * Direct-image hooks over the fixture site (the runner-test default
 * writer path: no SaveImage binding — the runner downloads verbatim
 * and writes `001.jpg`-style files itself).
 */
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

describe('download lane honors the output defaults on NEW jobs (PUT /api/settings/output)', (): void => {
  let site: FixtureMangaSite;
  let base = '';
  let dir = '';
  let queue: ReturnType<typeof openHarness>['queue'];
  let library: SqliteLibraryStore;
  let db: InstanceType<typeof Database>;
  /** The mutable settings provider — flipped between jobs per test. */
  let current: OutputDefaultsT;

  beforeEach((): void => {
    site = new FixtureMangaSite({ minImageMs: 1 });
    dir = mkTmpDir('lane-output-');
  });

  afterEach((): void => {
    void site.stop();
    db.close();
    queue.close();
    rmDir(dir);
  });

  /** Build the lane deps + a job runner against the fixture site. */
  const setup = (output: OutputDefaultsT): { run: (chapterName: string, chapterPosition?: number) => Promise<{ stages: string[]; outcome: { type: string } }> } => {
    current = output;
    const harness = openHarness(dir);
    queue = harness.queue;
    db = new Database(path.join(dir, 'lib.db'));
    library = new SqliteLibraryStore({ db, libraryRoot: path.join(dir, 'library') });
    const deps: DownloadLaneDeps = {
      queue,
      wsHub: new WsHub(),
      library,
      dataDir: dir,
      engine: { modules: (): readonly unknown[] => [{ id: MODULE_ID, name: 'FixtureSite' }] } as never,
      createHooks: (moduleId: string, engine: EngineDownloadOptions): Promise<ModuleDownloadHooks> =>
        engineStub.create(moduleId, engine),
      active: new ActiveDownloadRegistry(),
      log: (): void => undefined,
      outputDefaults: (): OutputDefaultsT => current,
    };
    const lane = downloadLane(deps);
    return {
      run: (
        chapterName: string,
        chapterPosition?: number,
      ): Promise<{ stages: string[]; outcome: { type: string } }> => {
        const { job } = queue.enqueue({
          type: 'download',
          moduleId: MODULE_ID,
          mangaUrl: `${base}/`,
          mangaTitle: 'Fixture Manga',
          chapterLink: `${base}${CHAPTER_PATH}`,
          chapterName,
          ...(chapterPosition !== undefined ? { chapterPosition } : {}),
        } as never);
        const stages: string[] = [];
        const outcomePromise = lane.handler(job as never, {
          setProgress: (p: { stage: string }): void => {
            stages.push(p.stage);
          },
        } as never);
        return outcomePromise.then((outcome): { stages: string[]; outcome: { type: string } } => ({
          stages,
          outcome: outcome as { type: string },
        }));
      },
    };
  };

  it('format + chapterNameTemplate: a NEW job packs .cbz under the template name (COMPRESS stage)', async (): Promise<void> => {
    base = await site.start();
    engineStub.create = async (): Promise<ModuleDownloadHooks> => fixtureSiteHooks(base) as ModuleDownloadHooks;
    const { run } = setup({
      format: 'cbz',
      chapterNameTemplate: '%MANGA% - %CHAPTER%',
      unicodeReplacement: false,
      unicodeReplacementChar: '_',
      digitPadding: 0,
      removeMangaName: false,
    });

    const { outcome, stages } = await run('Chapter 1 - The Beginning');

    expect(outcome.type).toBe('done');
    // FMD2 status-palette stage for the zip/cbz packers.
    expect(stages).toContain('compress');
    // The library ledger row carries the template-resolved artifact.
    const rows = library.listLibraryFiles();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fileName).toBe('Fixture Manga - Chapter 1 - The Beginning.cbz');
    const row = library.getLibraryFile(String(rows[0]?.id ?? ''));
    expect(row).toBeDefined();
    expect(row?.path.endsWith('.cbz')).toBe(true);
    expect(fs.existsSync(row?.path ?? '')).toBe(true);
    // §7.2 ledger dual-write: the chapter is recorded as downloaded.
    expect(library.getDownloadedChapters(MODULE_ID, `${base}/`)).toContain(CHAPTER_PATH);
  });

  it('frozen scan-target defaults end-to-end: %NUMBERING% %CHAPTER% name, .cbz, ComicInfo.xml with Series = folder', async (): Promise<void> => {
    base = await site.start();
    engineStub.create = async (): Promise<ModuleDownloadHooks> => fixtureSiteHooks(base) as ModuleDownloadHooks;
    const { run } = setup({
      format: 'cbz',
      chapterNameTemplate: '%NUMBERING% %CHAPTER%',
      unicodeReplacement: false,
      unicodeReplacementChar: '_',
      digitPadding: 0,
      removeMangaName: false,
    });

    const { outcome } = await run('The Beginning', 1);
    expect(outcome.type).toBe('done');

    const rows = library.listLibraryFiles();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fileName).toBe('0001 The Beginning.cbz');
    const row = library.getLibraryFile(String(rows[0]?.id ?? ''));
    expect(row).toBeDefined();
    // The Komga/Kavita convention over the whole artifact:
    const finalPath = row?.path ?? '';
    expect(finalPath.endsWith('.cbz')).toBe(true);
    expect(path.basename(path.dirname(finalPath))).toBe('Fixture Manga');
    const walk = await walkZipCentralDirectory(finalPath);
    expect(walk.entries[0]?.name).toBe('ComicInfo.xml');
    const xml = (await readZipEntry(finalPath, 'ComicInfo.xml')).toString('utf8');
    expect(xml).toContain('<Series>Fixture Manga</Series>');
    expect(xml).toContain('<Title>The Beginning</Title>');
    expect(xml).toContain(`<Web>${`${base}/`}</Web>`);
    expect(xml).toContain('<Notes>FixtureSite</Notes>');
    expect(xml).not.toMatch(/<(Number|Volume)>/);
    // No dotfiles or stage residue in the series folder.
    expect(fs.readdirSync(path.dirname(finalPath)).every((name): boolean => !name.startsWith('.'))).toBe(true);
  });

  it('a settings CHANGE applies to the NEXT job only (per-job read): epub + the chapter-name fallback', async (): Promise<void> => {
    base = await site.start();
    engineStub.create = async (): Promise<ModuleDownloadHooks> => fixtureSiteHooks(base) as ModuleDownloadHooks;
    const laneA = setup({
      format: 'zip',
      chapterNameTemplate: '',
      unicodeReplacement: false,
      unicodeReplacementChar: '_',
      digitPadding: 0,
      removeMangaName: false,
    });
    const first = await laneA.run('Chapter One');
    expect(first.outcome.type).toBe("done");
    expect(library.listLibraryFiles()[0]?.fileName).toBe('Chapter One.zip');

    // PUT /api/settings/output between jobs: format epub, no template
    // (epub — like pdf — maps onto the CONVERT stage; its packer does
    // not probe image dimensions, so the fixture site's synthetic
    // JPEGs are embeddable as-is).
    current = {
      format: 'epub',
      chapterNameTemplate: '',
      unicodeReplacement: false,
      unicodeReplacementChar: '_',
      digitPadding: 0,
      removeMangaName: false,
    };
    const second = await laneA.run('Chapter Two');

    console.log('OUTCOME2', JSON.stringify(second.outcome));     expect(second.outcome.type).toBe('done');
    // FMD2 CONVERT stage for the pdf/epub packers.
    expect(second.stages).toContain('convert');
    // Listing is newest-first: the epub landed above job 1's zip.
    const rows = library.listLibraryFiles();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.fileName).toBe('Chapter Two.epub');
    expect(rows[1]?.fileName).toBe('Chapter One.zip');
  });
});
