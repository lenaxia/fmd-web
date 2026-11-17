import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createModuleSyncService, DEFAULT_TARBALL_API_BASE_URL, type ModuleSyncConfig } from '../../../src/index.js';
import { createLuaHostFactory } from '../../../src/engine/lua/host.js';
import {
  buildFixtureZipball,
  FIXTURE_SHA,
  resolveFmd2LuaDir,
  zipballRootFor,
  type FixtureFile,
} from './fixture-zipball.js';

/**
 * REAL-TREE staged-tolerance integration (launch defect (a)): the FMD2
 * tree at the pinned commit permanently carries upstream-broken files
 * (the D3 published set — 4 that never parse + MangaPlus whose proto
 * require fails), so the zero-tolerance gate could NEVER pass on the
 * real tree. The shared TolerancePolicy admits them (≤5 AND ≤1% of 417
 * module files, none previously registered) — the sync proceeds, the
 * report carries failures[], and the known-broken files install (the
 * registry sweep drops them per-file at boot, exactly like production).
 */

const KNOWN_BROKEN = ['JapScan.lua', 'MangaPlus.lua', 'Shakai.lua', 'acqqcom.lua', 'dm5.lua'] as const;

interface MockUpstream {
  readonly baseUrl: string;
  serve(bytes: Uint8Array): void;
  close(): Promise<void>;
}

function startMockUpstream(): MockUpstream {
  let payload: Uint8Array = new Uint8Array();
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(Buffer.from(payload));
  });
  server.listen(0, '127.0.0.1');
  return {
    get baseUrl(): string {
      const address = server.address() as AddressInfo;
      return `http://${address.address}:${String(address.port)}`;
    },
    serve(bytes: Uint8Array): void {
      payload = bytes;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject): void => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** The ENTIRE real lua/ tree (486 files, binary-safe) as fixture files. */
function realTreeFiles(): FixtureFile[] {
  const root = resolveFmd2LuaDir();
  const files: FixtureFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        files.push({ path: relPath, content: readFileSync(join(dir, entry.name)) });
      }
    }
  };
  walk(root, '');
  return files;
}

describe('staged sync tolerance — the REAL 417-module-file tree (D20 launch fix)', (): void => {
  const upstream = startMockUpstream();
  let dataDir = '';

  beforeAll((): void => {
    const files = realTreeFiles();
    expect(files.length).toBe(486); // the whole pinned lua/ tree
    expect(files.filter((f) => f.path.startsWith('modules/') && f.path.endsWith('.lua'))).toHaveLength(417);
    upstream.serve(buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), files).bytes);
  }, 60_000);

  beforeEach((): void => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-real-tree-'));
  });

  afterAll(async (): Promise<void> => {
    await upstream.close();
  });

  function config(): ModuleSyncConfig {
    return {
      repo: 'dazedcat19/FMD2',
      sha: FIXTURE_SHA,
      codeloadBaseUrl: upstream.baseUrl,
      tarballApiBaseUrl: DEFAULT_TARBALL_API_BASE_URL,
      dataDir,
      luaDirOverride: undefined,
      autoBump: false,
    };
  }

  it(
    'first sync on the real tree PROCEEDS: known-broken files tolerated, failures[] recorded',
    async (): Promise<void> => {
      const result = await createModuleSyncService(config(), {
        now: () => '2026-11-16T00:00:00.000Z',
        hostFactory: createLuaHostFactory(),
      }).sync();

      expect(result.report.moduleFiles).toBe(417);
      // the D3 published known-broken set, exactly
      expect(result.report.failures.map((f) => f.file).sort()).toEqual(
        [...KNOWN_BROKEN].map((file) => `modules/${file}`).sort(),
      );
      for (const failure of result.report.failures) {
        expect(failure.firstError.length).toBeGreaterThan(0);
      }
      // the registered inventory excludes every broken file (regression
      // guard input stays clean for the NEXT sync)
      const registered = new Set(result.report.inventory.map((entry) => entry.sourceFile));
      for (const file of KNOWN_BROKEN) {
        expect(registered.has(`modules/${file}`)).toBe(false);
      }
      expect(result.report.modules).toBe(454); // the committed sweep count

      // the whole tree installed — including the broken files (the
      // registry sweep drops them per-file at boot, not the sync)
      expect(existsSync(join(result.targetDir, 'modules', 'JapScan.lua'))).toBe(true);
      expect(existsSync(join(result.targetDir, 'modules', 'dm5.lua'))).toBe(true);
      expect(existsSync(join(result.targetDir, 'modules', 'AsuraScans.lua'))).toBe(true);
      expect(existsSync(join(result.targetDir, 'templates', 'Madara.lua'))).toBe(true);

      // sync-state report carries failures[] for the Settings surface
      const state = JSON.parse(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')) as {
        repos: Record<string, { report: { failures: readonly { file: string }[] } }>;
      };
      const entry = state.repos['dazedcat19/FMD2'];
      expect(entry?.report.failures.map((f) => f.file)).toEqual(
        expect.arrayContaining([...KNOWN_BROKEN].map((file) => `modules/${file}`)),
      );
    },
    180_000,
  );

  it('re-sync of the same real tree re-admits (broken files were never in the inventory)', async (): Promise<void> => {
    const service = createModuleSyncService(config(), { hostFactory: createLuaHostFactory() });
    const first = await service.sync();
    const second = await service.sync();

    expect(second.previousSha).toBe(first.sha);
    expect(second.report.failures.map((f) => f.file).sort()).toEqual(
      [...KNOWN_BROKEN].map((file) => `modules/${file}`).sort(),
    );
    expect(second.report.diff.added).toEqual([]);
    expect(second.report.diff.removed).toEqual([]);
  }, 240_000);

  it('a real-tree sync plus ONE regressed module file refuses as regression', async (): Promise<void> => {
    const service = createModuleSyncService(config(), { hostFactory: createLuaHostFactory() });
    await service.sync();

    // Same real tree, but a previously-registered module goes broken:
    // the tolerance must refuse (regression guard) — previous tree intact.
    const before = JSON.parse(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')) as unknown as string;
    const files = realTreeFiles().map((f): FixtureFile =>
      f.path === 'modules/AsuraScans.lua' ? { path: f.path, content: 'function Init(\n  broken }}\n' } : f,
    );
    upstream.serve(buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), files).bytes);

    await expect(service.sync()).rejects.toMatchObject({
      name: 'ModuleSyncError',
      reason: 'staged-init-failed',
      details: { toleranceReason: 'regression' },
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')) as unknown as string).toEqual(before);
  }, 240_000);
});
