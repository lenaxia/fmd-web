import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createModuleSyncService,
  DEFAULT_FMD2_PIN_SHA,
  DEFAULT_FMD2_REPO,
  ModuleSyncError,
  safeSubtreeRelative,
  type ModuleSyncConfig,
  type ModuleSyncResult,
  type ZipballFetcher,
} from '../../../src/index.js';
import {
  buildFixtureZipball,
  FIXTURE_IDS,
  FIXTURE_REPO,
  FIXTURE_SHA,
  fixtureTreeV1,
  fixtureTreeV2,
  fixtureTreeWithBrokenModule,
  fixtureZipballWrongSha,
  zipballRootFor,
  type FixtureZipball,
} from './fixture-zipball.js';

/**
 * Fixture-zipball integration tests (DESIGN.md §6/§8.5, D9): the full
 * ModuleSyncService flow — codeload fetch over LOOPBACK (offline policy),
 * zipball-root SHA verification, staged strict Init pass, atomic swap into
 * `data/lua/`, sync_state recording — plus the refusals: SHA mismatch and
 * a broken module file must leave the previous tree byte-identical, with
 * no staging leftovers.
 */

const NOW_ISO = '2026-11-13T18:00:00.000Z';

interface MockUpstream {
  readonly baseUrl: string;
  readonly requests: string[];
  serve(payload: FixtureZipball | Uint8Array): void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

function startMockUpstream(): MockUpstream {
  const requests: string[] = [];
  let payload: Uint8Array = new Uint8Array();
  let baseUrl = '';
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(Buffer.from(payload));
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', (): void => {
      const { address, port } = server.address() as AddressInfo;
      baseUrl = `http://${address}:${String(port)}`;
      resolve();
    });
    server.once('error', reject);
  });
  server.listen(0, '127.0.0.1');
  return {
    get baseUrl(): string {
      if (baseUrl === '') {
        throw new Error('mock upstream is not listening yet');
      }
      return baseUrl;
    },
    requests,
    serve(upstreamPayload: FixtureZipball | Uint8Array): void {
      payload = upstreamPayload instanceof Uint8Array ? upstreamPayload : upstreamPayload.bytes;
    },
    ready(): Promise<void> {
      return listening;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function refusalOf(syncing: Promise<unknown>): Promise<ModuleSyncError> {
  return syncing.then(
    (): never => {
      throw new Error('expected the sync to be refused');
    },
    (error: unknown): ModuleSyncError => {
      expect(error).toBeInstanceOf(ModuleSyncError);
      return error as ModuleSyncError;
    },
  );
}

describe('ModuleSyncService — fixture zipball integration (loopback, offline)', (): void => {
  const upstream = startMockUpstream();
  let dataDir = '';

  function makeConfig(overrides: Partial<ModuleSyncConfig> = {}): ModuleSyncConfig {
    return {
      repo: FIXTURE_REPO,
      sha: FIXTURE_SHA,
      codeloadBaseUrl: upstream.baseUrl,
      dataDir,
      luaDirOverride: undefined,
      autoBump: false,
      ...overrides,
    };
  }

  beforeAll(async (): Promise<void> => {
    await upstream.ready();
  });

  function syncNow(overrides: Partial<ModuleSyncConfig> = {}): Promise<ModuleSyncResult> {
    return createModuleSyncService(makeConfig(overrides), { now: () => NOW_ISO }).sync();
  }

  function serveV1(): void {
    upstream.serve(buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), fixtureTreeV1()));
  }

  /** SHA-256 of every file in the installed tree — the byte-identity probe. */
  function treeFingerprint(root: string): string {
    const lines: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
        } else {
          const digest = createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex');
          lines.push(`${rel} ${digest}`);
        }
      }
    };
    walk(root, '');
    return lines.sort().join('\n');
  }

  function stagingLeftovers(): string[] {
    return readdirSync(dataDir).filter((name) => name.startsWith('.sync-'));
  }

  beforeEach((): void => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-module-sync-'));
    upstream.requests.length = 0;
  });

  afterAll(async (): Promise<void> => {
    await upstream.close();
  });

  it('installs the pinned lua/ subtree: fetch → verify → validate → atomic swap → sync_state', async (): Promise<void> => {
    serveV1();

    const result = await syncNow();

    expect(result.sha).toBe(FIXTURE_SHA);
    expect(result.previousSha).toBeNull();
    expect(result.source).toBe('codeload');
    expect(result.targetDir).toBe(join(dataDir, 'lua'));
    // the mock upstream saw exactly the pinned codeload request
    expect(upstream.requests).toEqual([`/${FIXTURE_REPO}/zip/${FIXTURE_SHA}`]);

    // the installed tree is the FULL lua/ subtree: modules + templates + utils + assets
    const luaDir = result.targetDir;
    expect(existsSync(join(luaDir, 'modules', '11Toon.lua'))).toBe(true);
    expect(existsSync(join(luaDir, 'modules', 'AsuraScans.lua'))).toBe(true);
    expect(existsSync(join(luaDir, 'modules', 'YoungAceUp.lua'))).toBe(true);
    expect(existsSync(join(luaDir, 'templates', 'Madara.lua'))).toBe(true);
    expect(existsSync(join(luaDir, 'utils', 'jsunpack.lua'))).toBe(true);
    expect(existsSync(join(luaDir, 'modules', 'MangaPlus.proto'))).toBe(true);

    // report: every file validated, first sync is all-added
    expect(result.report.previousSha).toBeNull();
    expect(result.report.moduleFiles).toBe(4);
    expect(result.report.luaFiles).toBe(6);
    expect(result.report.otherFiles).toBe(1);
    expect(result.report.modules).toBe(4);
    expect(result.report.warnings).toEqual([]);
    expect(result.report.diff.added.map((m) => m.id).sort()).toEqual(
      [
        FIXTURE_IDS.elevenToon,
        FIXTURE_IDS.asuraScans,
        FIXTURE_IDS.hentai2Read,
        FIXTURE_IDS.youngAceUp,
      ].sort(),
    );
    expect(result.report.diff.removed).toEqual([]);
    expect(result.report.diff.changed).toEqual([]);

    // sync_state(repo, sha, fetched_at, report) recorded
    const state = JSON.parse(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')) as {
      repos: Record<string, { repo: string; sha: string; fetchedAt: string; report: unknown }>;
    };
    const entry = state.repos[FIXTURE_REPO];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error('sync_state entry for the fixture repo is missing');
    }
    expect(entry.sha).toBe(FIXTURE_SHA);
    expect(entry.fetchedAt).toBe(NOW_ISO);
    expect(entry.report).toEqual(result.report);

    // atomic: no staging dirs left behind
    expect(stagingLeftovers()).toEqual([]);
  });

  it('swaps v1 → v2 atomically: exact tree replacement, no stale files, diff vs previous pin', async (): Promise<void> => {
    serveV1();
    const first = await syncNow();
    const before = treeFingerprint(first.targetDir);

    upstream.serve(buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), fixtureTreeV2()));
    const second = await syncNow();

    expect(second.previousSha).toBe(FIXTURE_SHA);
    // v2 tree EXACTLY: removed file gone, added file present, rename visible
    expect(existsSync(join(second.targetDir, 'modules', 'Hentai2Read.lua'))).toBe(false);
    expect(existsSync(join(second.targetDir, 'modules', 'CraftedFixture.lua'))).toBe(true);
    expect(readFileSync(join(second.targetDir, 'modules', '11Toon.lua'), 'utf8')).toContain("'11Toon Classic'");
    expect(existsSync(join(second.targetDir, 'modules', 'AsuraScans.lua'))).toBe(true);
    expect(treeFingerprint(second.targetDir)).not.toBe(before);

    // diff report vs the previous pin: added/removed/changed by module ID
    expect(second.report.diff.added.map((m) => m.id)).toEqual([FIXTURE_IDS.craftedFixture]);
    expect(second.report.diff.removed.map((m) => m.id)).toEqual([FIXTURE_IDS.hentai2Read]);
    expect(second.report.diff.changed.map((m) => m.id)).toEqual([FIXTURE_IDS.elevenToon]);
    expect(second.report.diff.changed[0]?.previousName).toBe('11Toon');
    expect(second.report.diff.changed[0]?.currentName).toBe('11Toon Classic');
    expect(second.report.modules).toBe(4);

    expect(stagingLeftovers()).toEqual([]);
  });

  it('refuses a zipball whose root names another commit (SHA mismatch) — previous tree intact', async (): Promise<void> => {
    serveV1();
    const installed = await syncNow();
    const fingerprint = treeFingerprint(installed.targetDir);
    const stateBefore = readFileSync(join(dataDir, 'sync-state.json'), 'utf8');

    upstream.serve(fixtureZipballWrongSha(fixtureTreeV1(), 'FMD2'));
    const refusal = await refusalOf(syncNow());

    expect(refusal.reason).toBe('sha-mismatch');
    expect(refusal.message).toContain(FIXTURE_SHA.slice(0, 10));
    expect(refusal.details).toMatchObject({
      expectedRoot: `FMD2-${FIXTURE_SHA.slice(0, 10)}`,
      actualRoot: 'FMD2-0000000000',
    });
    // previous tree + sync_state byte-identical
    expect(treeFingerprint(installed.targetDir)).toBe(fingerprint);
    expect(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')).toBe(stateBefore);
    expect(stagingLeftovers()).toEqual([]);
  });

  it('refuses zip-slip traversal entries — no file written outside staging, previous tree intact', async (): Promise<void> => {
    serveV1();
    const installed = await syncNow();
    const fingerprint = treeFingerprint(installed.targetDir);
    const stateBefore = readFileSync(join(dataDir, 'sync-state.json'), 'utf8');

    // otherwise-valid pinned zipball with crafted escape entries (review blocker repro)
    const root = zipballRootFor('FMD2', FIXTURE_SHA);
    upstream.serve(
      buildFixtureZipball(
        root,
        [
          ...fixtureTreeV1(),
          { path: '../../../pwned.txt', content: 'escape via .. segments' },
          { path: 'modules/../../../../pwned2.txt', content: 'escape via nested ..' },
        ],
      ),
    );
    const refusal = await refusalOf(syncNow());

    expect(refusal.reason).toBe('zip-corrupt');
    expect(refusal.message).toContain('escapes the lua/ subtree');
    expect(refusal.message).toContain('pwned');
    // NOTHING landed outside staging — probe the data dir and its ancestors
    for (const base of [dataDir, dirname(dataDir), dirname(dirname(dataDir)), tmpdir()]) {
      expect(existsSync(join(base, 'pwned.txt'), )).toBe(false);
      expect(existsSync(join(base, 'pwned2.txt'))).toBe(false);
    }
    // previous tree + sync_state byte-identical, no partial install, no staging leftovers
    expect(treeFingerprint(installed.targetDir)).toBe(fingerprint);
    expect(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')).toBe(stateBefore);
    expect(existsSync(join(dataDir, 'lua'))).toBe(true); // v1 tree still installed at target
    expect(stagingLeftovers()).toEqual([]);
  });

  it('safeSubtreeRelative accepts clean paths and refuses traversal/dot/backslash/empty segments', (): void => {
    const prefix = `${zipballRootFor('FMD2', FIXTURE_SHA)}/lua/`;
    expect(safeSubtreeRelative(`${prefix}modules/11Toon.lua`, prefix)).toBe('modules/11Toon.lua');
    expect(safeSubtreeRelative(`${prefix}templates/Madara.lua`, prefix)).toBe('templates/Madara.lua');
    expect(() => safeSubtreeRelative(`${prefix}../pwned.txt`, prefix)).toThrow(/escapes the lua\/ subtree/);
    expect(() => safeSubtreeRelative(`${prefix}modules/../pwned.txt`, prefix)).toThrow(/escapes the lua\/ subtree/);
    expect(() => safeSubtreeRelative(`${prefix}modules/./pwned.txt`, prefix)).toThrow(/escapes the lua\/ subtree/);
    expect(() => safeSubtreeRelative(`${prefix}modules\\pwned.txt`, prefix)).toThrow(/escapes the lua\/ subtree/);
    expect(() => safeSubtreeRelative(`${prefix}modules//pwned.txt`, prefix)).toThrow(/escapes the lua\/ subtree/);
    expect(() => safeSubtreeRelative('outside/lua/x.lua', prefix)).toThrow(/escapes the lua\/ subtree/);
  });

  it('refuses a broken module file in the staged tree — no swap, previous tree intact', async (): Promise<void> => {
    serveV1();
    const installed = await syncNow();
    const fingerprint = treeFingerprint(installed.targetDir);
    const stateBefore = readFileSync(join(dataDir, 'sync-state.json'), 'utf8');

    upstream.serve(buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), fixtureTreeWithBrokenModule()));
    const refusal = await refusalOf(syncNow());

    expect(refusal.reason).toBe('staged-init-failed');
    expect(refusal.message).toContain('modules/Broken.lua');
    const failures = refusal.details['failures'] as readonly { file: string; errors: readonly string[] }[];
    expect(failures.map((f) => f.file)).toEqual(['modules/Broken.lua']);
    expect(failures[0]?.errors.length).toBeGreaterThan(0);
    // previous tree + sync_state untouched
    expect(treeFingerprint(installed.targetDir)).toBe(fingerprint);
    expect(readFileSync(join(dataDir, 'sync-state.json'), 'utf8')).toBe(stateBefore);
    expect(stagingLeftovers()).toEqual([]);
  });

  it('refuses a broken tree on FIRST install — data/lua is never created', async (): Promise<void> => {
    upstream.serve(buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), fixtureTreeWithBrokenModule()));
    const refusal = await refusalOf(syncNow());

    expect(refusal.reason).toBe('staged-init-failed');
    expect(existsSync(join(dataDir, 'lua'))).toBe(false);
    expect(existsSync(join(dataDir, 'sync-state.json'))).toBe(false);
    expect(stagingLeftovers()).toEqual([]);
  });

  it('refuses corrupt archives and zipballs without a lua/ subtree', async (): Promise<void> => {
    upstream.serve(new Uint8Array(Buffer.from('this is not a zip')));
    expect((await refusalOf(syncNow())).reason).toBe('zip-corrupt');
    expect(existsSync(join(dataDir, 'lua'))).toBe(false);

    upstream.serve(
      buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), [{ path: 'README.md', content: 'no lua here' }], ''),
    );
    expect((await refusalOf(syncNow())).reason).toBe('zip-corrupt');
    expect(existsSync(join(dataDir, 'lua'))).toBe(false);
    expect(stagingLeftovers()).toEqual([]);
  });

  it('reports fetch failures as refusals (previous tree intact)', async (): Promise<void> => {
    serveV1();
    const installed = await syncNow();
    const fingerprint = treeFingerprint(installed.targetDir);

    const dead = startMockUpstream();
    await dead.ready();
    const deadUrl = dead.baseUrl;
    await dead.close();
    const refusal = await refusalOf(syncNow({ codeloadBaseUrl: deadUrl }));

    expect(refusal.reason).toBe('fetch-failed');
    expect(treeFingerprint(installed.targetDir)).toBe(fingerprint);
    expect(stagingLeftovers()).toEqual([]);
  });

  describe('local-dir override (FMD_LUA_DIR — development path, fetch skipped)', (): void => {
    it('stages + validates + installs the local tree without any fetch', async (): Promise<void> => {
      const localTree = mkdtempSync(join(tmpdir(), 'fmd-lua-src-'));
      try {
        for (const file of fixtureTreeV1()) {
          const target = join(localTree, file.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.content);
        }
        const fetcher: ZipballFetcher & { calls: number } = {
          calls: 0,
          async fetchZipball(): Promise<Uint8Array> {
            this.calls += 1;
            throw new Error('fetch must never run under FMD_LUA_DIR');
          },
        };
        const service = createModuleSyncService(makeConfig({ luaDirOverride: localTree }), {
          fetcher,
          now: () => NOW_ISO,
        });

        const result = await service.sync();

        expect(fetcher.calls).toBe(0);
        expect(result.source).toBe('local-dir');
        expect(result.sha).toBe(FIXTURE_SHA);
        expect(existsSync(join(result.targetDir, 'modules', 'AsuraScans.lua'))).toBe(true);
        expect(existsSync(join(result.targetDir, 'modules', 'MangaPlus.proto'))).toBe(true);
        expect(result.report.modules).toBe(4);
        expect(result.report.source).toBe('local-dir');
        expect(stagingLeftovers()).toEqual([]);
      } finally {
        rmSync(localTree, { recursive: true, force: true });
      }
    });

    it('refuses a missing local dir without touching the target tree', async (): Promise<void> => {
      serveV1();
      const installed = await syncNow();
      const fingerprint = treeFingerprint(installed.targetDir);

      const refusal = await refusalOf(syncNow({ luaDirOverride: join(dataDir, 'does-not-exist') }));

      expect(refusal.reason).toBe('local-dir-missing');
      expect(treeFingerprint(installed.targetDir)).toBe(fingerprint);
      expect(stagingLeftovers()).toEqual([]);
    });
  });

  it('uses the default file-backed sync_state store at <dataDir>/sync-state.json', async (): Promise<void> => {
    serveV1();
    await syncNow();
    const path = join(dataDir, 'sync-state.json');
    expect(existsSync(path)).toBe(true);
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      repos: Record<string, { report: { source: string } }>;
    };
    expect(Object.keys(state.repos)).toEqual([FIXTURE_REPO]);
    expect(state.repos[FIXTURE_REPO]?.report.source).toBe('codeload');
  });
  it('default pin constant matches the fixture (the checkout the corpus was captured from)', (): void => {
    expect(DEFAULT_FMD2_PIN_SHA).toBe(FIXTURE_SHA);
    expect(DEFAULT_FMD2_REPO).toBe('dazedcat19/FMD2');
  });
});
