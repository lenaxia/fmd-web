import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { CatalogSync } from '../../../src/sync/db/sync-service.js';
import { isoDateToJdn } from '../../../src/sync/db/jdn.js';
import { fileSha256 } from '../../../src/sync/db/catalog-store.js';
import {
  buildCatalogArchive,
  fixtureId,
  sevenZipPath,
  type FixtureRow,
} from './fixtures.js';

/**
 * §6.3 atomic install — fault injection proves the temp+rename
 * invariant: NO partial catalog is ever visible at
 * data/catalogs/<ID>.db. Two crash flavors:
 *
 * 1. In-process throw between extract and rename (pipeline rollback,
 *    tmp cleanup runs) — plus the previous catalog staying intact on a
 *    failed update.
 * 2. A REAL hard kill (SIGKILL) mid-window in a child process — no
 *    cleanup runs at all; a following service instance completes the
 *    install cleanly (the crash left nothing half-visible).
 */

const ID: string = fixtureId('atomic-install-id');

function rows(version: 1 | 2): FixtureRow[] {
  if (version === 1) {
    return [{ link: '/m/v1', title: 'Atomic One', summary: 'first atomic content', jdn: isoDateToJdn('2026-01-01') }];
  }
  return [{ link: '/m/v2', title: 'Atomic Two', summary: 'second atomic content', jdn: isoDateToJdn('2026-02-01') }];
}

describe('atomic extract → rename invariant (§6.3)', () => {
  let tmp: string;
  let archive1: string;
  let archive2: string;
  let sevenZip: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/atomic-');
    archive1 = buildCatalogArchive(tmp, ID, rows(1));
    archive2 = buildCatalogArchive(tmp, `${ID}-v2`, rows(2));
    sevenZip = sevenZipPath();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeService(onBeforeInstall?: (id: string) => void, archive: string = archive1): CatalogSync {
    return new CatalogSync({
      dataDir: tmp,
      dbUrl: 'mock://unused',
      extractor: {
        async extract(dest: string, destDir: string): Promise<void> {
          void dest;
          fs.mkdirSync(destDir, { recursive: true });
          const res = spawnSync(sevenZip, ['x', '-y', '-aoa', `-o${destDir}`, archive], { stdio: 'pipe' });
          if (res.status !== 0) {
            throw new Error(`7za x failed: ${String(res.stderr)}`);
          }
        },
      },
      fetchImpl: async () => new Response(fs.readFileSync(archive), { headers: { ETag: '"atomic"' } }),
      onBeforeInstall: onBeforeInstall ?? ((): void => {}),
    });
  }

  it('a throw between extract and rename leaves NO catalog visible and cleans tmp', async () => {
    const service: CatalogSync = makeService(() => {
      throw new Error('simulated crash before rename');
    });
    const result = await service.syncCatalog(ID);
    expect(result.state).toBe('failed');
    expect(result.error).toMatch(/simulated crash/);

    const catalogsDir: string = path.join(tmp, 'catalogs');
    expect(fs.existsSync(catalogsDir) ? fs.readdirSync(catalogsDir) : []).toEqual([]);
    // The finally-cleaner removed the temp archive + extraction dir.
    expect(fs.existsSync(path.join(tmp, 'tmp')) ? fs.readdirSync(path.join(tmp, 'tmp')) : []).toEqual([]);
    // Batch state kept the id pending (resumable).
    expect(service.store.getMeta(ID)).toBeUndefined();
  });

  it('a failed update never damages the previous catalog', async () => {
    const good: CatalogSync = makeService();
    const installed = await good.syncCatalog(ID);
    expect(installed.state).toBe('updated');
    const shaBefore: string = fileSha256(path.join(tmp, 'catalogs', `${ID}.db`));

    // Update attempt with the v2 archive crashes before the rename.
    const crashing: CatalogSync = makeService(
      () => {
        throw new Error('simulated crash before rename');
      },
      archive2,
    );
    const result = await crashing.syncCatalog(ID);
    expect(result.state).toBe('failed');
    expect(fileSha256(path.join(tmp, 'catalogs', `${ID}.db`))).toBe(shaBefore);
    // Reads stay on v1 content.
    expect(good.store.search(ID, { query: 'first atomic' }).total).toBe(1);
    expect(good.store.search(ID, { query: 'second atomic' }).total).toBe(0);
  });

  it('SIGKILL between extract and rename: no partial catalog, recovery completes', async () => {
    // Bundle the pipeline for the child process. The bundle must live
    // under the workspace tree (node_modules resolution for the native
    // better-sqlite3 + the 7zip-bin binary), so use server/node_modules/.cache.
    const serverRoot: string = path.resolve(import.meta.dirname, '../../../..');
    const cacheDir: string = path.join(serverRoot, 'node_modules', '.cache', 'sync-db-test');
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    const bundlePath: string = path.join(cacheDir, 'bundle.mjs');
    await build({
      entryPoints: [path.resolve(import.meta.dirname, '../../../src/sync/db/sync-service.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      outfile: bundlePath,
      external: ['better-sqlite3', '7zip-bin'],
      logLevel: 'silent',
    });
    try {
      const dataDir: string = path.join(tmp, 'data');
      const childScript: string = path.join(cacheDir, 'crash-child.mjs');
      fs.writeFileSync(
        childScript,
        [
          "import { CatalogSync } from './bundle.mjs';",
          "import * as fs from 'node:fs';",
          'const [dataDir, archivePath, catalogId] = process.argv.slice(2);',
          "process.env['FMD_CATALOG_7ZZ'] = process.env['SEVEN_ZIP'];",
          'const service = new CatalogSync({',
          '  dataDir,',
          "  dbUrl: 'mock://unused',",
          '  fetchImpl: async () => new Response(fs.readFileSync(archivePath), { headers: { ETag: \'"kill-1"\' } }),',
          '  onBeforeInstall: () => { process.kill(process.pid, "SIGKILL"); },',
          '});',
          'await service.syncCatalog(catalogId);',
          "process.stdout.write('completed-should-not-happen');",
        ].join('\n'),
        'utf8',
      );

      const res = spawnSync(process.execPath, [childScript, dataDir, archive1, ID], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, SEVEN_ZIP: sevenZip },
      });
      // Hard-crashed mid-window (killed by signal, never exited).
      expect(res.signal).toBe('SIGKILL');

      // Invariant: nothing partial visible at the target path.
      const catalogsDir: string = path.join(dataDir, 'catalogs');
      expect(fs.existsSync(catalogsDir) ? fs.readdirSync(catalogsDir) : []).toEqual([]);
      // Forensics: the kill landed AFTER extraction — the fresh temp dir
      // still holds the extracted db (SIGKILL skips every finally).
      const tmpDir: string = path.join(dataDir, 'tmp');
      const leftovers: string[] = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
      const extractDirs: string[] = leftovers.filter((f) => f.endsWith('.x'));
      expect(extractDirs).toHaveLength(1);
      expect(
        fs.readdirSync(path.join(tmpDir, extractDirs[0] as string)).filter((f) => f.endsWith('.db')),
      ).toEqual([`${ID}.db`]);

      // Recovery: a fresh service over the SAME data dir completes the
      // install — proof the crash left the pipeline resumable and the
      // target path was never polluted by a partial file.
      const { SevenZipExtractor } = await import('../../../src/sync/db/extract.js');
      const recovery: CatalogSync = new CatalogSync({
        dataDir,
        dbUrl: 'mock://unused',
        extractor: new SevenZipExtractor(sevenZip),
        fetchImpl: async () => new Response(fs.readFileSync(archive1), { headers: { ETag: '"kill-1"' } }),
      });
      const final = await recovery.syncCatalog(ID);
      expect(final.state).toBe('updated');
      expect(final.dbSha).toBe(fileSha256(path.join(dataDir, 'catalogs', `${ID}.db`)));
      const page = recovery.store.search(ID, { query: 'first atomic' });
      expect(page.total).toBe(1);
      expect(page.entries[0]?.title).toBe('Atomic One');
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
