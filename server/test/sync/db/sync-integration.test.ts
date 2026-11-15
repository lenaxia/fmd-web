import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogSync } from '../../../src/sync/db/sync-service.js';
import { isoDateToJdn } from '../../../src/sync/db/jdn.js';
import { fileSha256 } from '../../../src/sync/db/catalog-store.js';
import {
  buildCatalogArchive,
  fixtureId,
  sevenZipPath,
  startMockGitHub,
  type FixtureRow,
  type MockGitHubServer,
} from './fixtures.js';

/**
 * §6 end-to-end over a LOCAL mock of api.github.com +
 * raw.githubusercontent.com (loopback only, §13-clean): commits-API
 * update check (1 call), per-file ETag/304, real 7za extraction,
 * atomic install, FTS sidecar keyed by db_sha, rate-limit posture.
 */

const ID_A: string = fixtureId('integration-alpha');
const ID_B: string = fixtureId('integration-bravo');

function rowsA(version: 1 | 2): FixtureRow[] {
  if (version === 1) {
    return [
      { link: '/m/alpha1', title: 'Alpha One', status: 'Ongoing', summary: 'integration alpha one', numchapter: 10, jdn: isoDateToJdn('2026-01-01') },
      { link: '/m/alpha2', title: 'Alpha Two', status: 'Ongoing', summary: 'integration alpha two', numchapter: 20, jdn: isoDateToJdn('2026-02-01') },
    ];
  }
  return [
    { link: '/m/alpha3', title: 'Alpha Three', status: 'Ongoing', summary: 'integration alpha three', numchapter: 30, jdn: isoDateToJdn('2026-10-01') },
  ];
}

const ROWS_B: FixtureRow[] = [
  { link: '/m/bravo1', title: 'Bravo One', status: 'Completed', summary: 'integration bravo one', numchapter: 5, jdn: isoDateToJdn('2026-04-01') },
];

describe('catalog sync end-to-end over the mock GitHub server (§6)', () => {
  let tmp: string;
  let mock: MockGitHubServer;
  let service: CatalogSync;

  beforeEach(async () => {
    tmp = fs.mkdtempSync('/tmp/opencode/syncint-');
    mock = await startMockGitHub();
    mock.state.headSha = 'c'.repeat(40);
    mock.state.headEtag = '"commits-1"';
    mock.state.blobs.set(ID_A, { bytes: fs.readFileSync(buildCatalogArchive(tmp, ID_A, rowsA(1))), etag: `"blob-${ID_A}-1"` });
    mock.state.blobs.set(ID_B, { bytes: fs.readFileSync(buildCatalogArchive(tmp, ID_B, ROWS_B)), etag: `"blob-${ID_B}-1"` });
    service = makeService();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    mock.close();
  });

  function makeService(): CatalogSync {
    return new CatalogSync({
      dataDir: tmp,
      dbUrl: `${mock.baseUrl}/owner/dbrepo/master/db`,
      apiBase: mock.baseUrl,
      knownCatalogIds: () => [ID_A, ID_B],
      extractor: {
        async extract(archivePath: string, destDir: string): Promise<void> {
          fs.mkdirSync(destDir, { recursive: true });
          const res = spawnSync(sevenZipPath(), ['x', '-y', '-aoa', `-o${destDir}`, archivePath], { stdio: 'pipe' });
          if (res.status !== 0) {
            throw new Error(`7za x failed (${String(res.status)}): ${String(res.stderr)}`);
          }
        },
      },
    });
  }

  it('first sync: 1 commits call → changed set → fetch+extract+install both catalogs', async () => {
    const check = await service.checkForUpdates();
    // Exactly ONE commits-API request; no blob traffic during the check.
    expect(mock.requests.filter((r) => r.url.includes('/commits'))).toHaveLength(1);
    expect(mock.blobRequests).toHaveLength(0);
    expect(check.changed).toBe(true);
    expect(check.changedIds).toEqual([ID_A, ID_B]);

    const results = await service.syncChanged();
    expect(results.map((r) => r.state)).toEqual(['updated', 'updated']);

    // Installed dbs are byte-equal to the fixture db content.
    const metaA = service.store.getMeta(ID_A);
    expect(metaA?.bytes).toBe(fs.statSync(path.join(tmp, 'catalogs', `${ID_A}.db`)).size);
    const page = service.store.latest(ID_A);
    expect(page.entries.map((e) => e.title)).toEqual(['Alpha Two', 'Alpha One']); // jdn DESC

    // tmp/ is cleaned: no archive or extraction leftovers.
    expect(fs.readdirSync(path.join(tmp, 'tmp'))).toEqual([]);
  });

  it('unchanged pin: second check re-verifies via ETag, downloads nothing', async () => {
    await service.checkForUpdates();
    await service.syncChanged();
    const blobsAfterFirst: number = mock.blobRequests.length;

    const check = await service.checkForUpdates();
    expect(check.changed).toBe(false);
    expect(check.changedIds).toEqual([]);
    const results = await service.syncChanged();
    expect(results).toHaveLength(0); // nothing pending → no fetches
    expect(mock.blobRequests.length).toBe(blobsAfterFirst);
  });

  it('moved pin: conditional GETs return 304 → unchanged, zero re-downloads', async () => {
    await service.checkForUpdates();
    await service.syncChanged();

    mock.state.headSha = 'd'.repeat(40);
    mock.state.headEtag = '"commits-2"';
    const check = await service.checkForUpdates();
    expect(check.changed).toBe(true);
    expect(check.changedIds).toEqual([ID_A, ID_B]);

    const results = await service.syncChanged();
    expect(results.map((r) => r.state)).toEqual(['unchanged', 'unchanged']);
    // Every second wave carried If-None-Match and got 304s (no bodies).
    const conditional: number = mock.blobRequests.filter((r) => r.ifNoneMatch !== '').length;
    expect(conditional).toBe(2);
    // Installed content untouched.
    expect(service.store.latest(ID_A).entries.map((e) => e.title)).toEqual(['Alpha Two', 'Alpha One']);
  });

  it('changed blob: new bytes + ETag → updated install, FTS sidecar rebuilt by db_sha', async () => {
    await service.checkForUpdates();
    await service.syncChanged();
    expect(service.store.search(ID_A, { query: 'alpha three' }).total).toBe(0);

    // Server rotates catalog A (new content + new etag) and the pin.
    mock.state.blobs.set(ID_A, {
      bytes: fs.readFileSync(buildCatalogArchive(tmp, `${ID_A}-v2`, rowsA(2))),
      etag: `"blob-${ID_A}-2"`,
    });
    mock.state.headSha = 'e'.repeat(40);
    mock.state.headEtag = '"commits-3"';
    const check = await service.checkForUpdates();
    expect(check.changed).toBe(true);
    const results = await service.syncChanged();
    expect(results.map((r) => r.state)).toEqual(['updated', 'unchanged']);

    // New rows visible; sidecar keyed by the NEW db_sha.
    const meta = service.store.getMeta(ID_A);
    expect(meta?.dbSha).toBe(fileSha256(path.join(tmp, 'catalogs', `${ID_A}.db`)));
    expect(service.store.search(ID_A, { query: 'alpha three' }).total).toBe(1);
    expect(service.store.search(ID_A, { query: 'alpha two' }).total).toBe(0);
    expect(service.store.latest(ID_A).entries.map((e) => e.title)).toEqual(['Alpha Three']);
    // B was a 304: content untouched.
    expect(service.store.search(ID_B, { query: 'bravo one' }).total).toBe(1);
  });

  it('rate-limited blob responses stop the batch; pending survives; retry completes', async () => {
    await service.checkForUpdates();
    mock.state.rateLimited = true;
    const results = await service.syncChanged();
    expect(results).toHaveLength(1);
    expect(results[0]?.state).toBe('failed');
    expect(results[0]?.error).toMatch(/rate limited/);
    // Batch stopped at the FIRST failure: only one blob request made.
    expect(mock.blobRequests).toHaveLength(1);

    mock.state.rateLimited = false;
    const retried = await service.syncChanged();
    expect(retried.map((r) => r.state)).toEqual(['updated', 'updated']);
    expect(service.store.getMeta(ID_A)).toBeDefined();
    expect(service.store.getMeta(ID_B)).toBeDefined();
  });

  it('no-sidecar invariant holds after the full sync workload', async () => {
    await service.checkForUpdates();
    await service.syncChanged();
    // Browse + search workload across both catalogs.
    for (const id of [ID_A, ID_B]) {
      service.store.latest(id);
      service.store.byTitle(id);
      service.store.search(id, { query: 'integration' });
    }
    const catalogsDir: string = path.join(tmp, 'catalogs');
    const sidecars: string[] = fs
      .readdirSync(catalogsDir)
      .filter((f) => f.endsWith('-journal') || f.endsWith('-wal') || f.endsWith('-shm'));
    expect(sidecars).toEqual([]);
    expect(new Set(fs.readdirSync(catalogsDir))).toEqual(
      new Set([`${ID_A}.db`, `${ID_A}.meta.json`, `${ID_B}.db`, `${ID_B}.meta.json`]),
    );
  });
});
