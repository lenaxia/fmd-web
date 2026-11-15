import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchStateStore, emptyBatchState } from '../../../src/sync/db/batch-state.js';
import { buildCatalogArchive, fixtureId, startMockGitHub, type MockGitHubServer } from './fixtures.js';
import { CatalogSync } from '../../../src/sync/db/sync-service.js';
import { isoDateToJdn } from '../../../src/sync/db/jdn.js';
import { fileSha256 } from '../../../src/sync/db/catalog-store.js';

/**
 * Resumable batch state (§6.1, GitHubRepoV3.pas:69-113 work-file
 * parity): the pending set + per-file ETags persist atomically after
 * EVERY step, so a crashed/interrupted batch resumes exactly at the
 * remaining ids — proven here with a rate-limited batch (§6.1 failure
 * posture) followed by a FRESH service instance draining the rest.
 */
describe('resumable batch state (§6.1)', () => {
  let tmp: string;
  let mock: MockGitHubServer;

  const idA: string = fixtureId('catalog-alpha');
  const idB: string = fixtureId('catalog-bravo');
  const idC: string = fixtureId('catalog-charlie');

  beforeEach(async () => {
    tmp = fs.mkdtempSync('/tmp/opencode/batch-');
    mock = await startMockGitHub();
    mock.state.headSha = 'a'.repeat(40);
    for (const id of [idA, idB, idC]) {
      const archive: string = buildCatalogArchive(tmp, id, [
        { link: `/m/${id}/1`, title: `Title ${id.slice(0, 4)}`, jdn: isoDateToJdn('2026-01-01') },
      ]);
      mock.state.blobs.set(id, { bytes: fs.readFileSync(archive), etag: `"${id}-v1"` });
    }
  });

  afterEach(() => {
    mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeService(): CatalogSync {
    return new CatalogSync({
      dataDir: tmp,
      dbUrl: `${mock.baseUrl}/o/n/master/db`,
      apiBase: mock.baseUrl,
      knownCatalogIds: () => [idA, idB, idC],
      extractor: { extract: async (archivePath: string, destDir: string): Promise<void> => {
        // In-process extraction via the real 7za binary is covered by
        // the integration suite; this unit keeps the store small.
        const { spawnSync } = await import('node:child_process');
        const { sevenZipPath } = await import('./fixtures.js');
        fs.mkdirSync(destDir, { recursive: true });
        const res = spawnSync(sevenZipPath(), ['x', '-y', '-aoa', `-o${destDir}`, archivePath]);
        if (res.status !== 0) {
          throw new Error(`7za x failed: ${String(res.stderr)}`);
        }
      } },
    });
  }

  it('persists pending atomically and drains it across service instances', async () => {
    const statePath: string = path.join(tmp, 'sync', 'catalog-batch.json');

    // 1) Check marks the changed set into pending, persisted.
    const first: CatalogSync = makeService();
    const check = await first.checkForUpdates();
    expect(check.changed).toBe(true);
    expect(check.changedIds).toEqual([idA, idB, idC]);
    expect(fs.existsSync(statePath)).toBe(true);
    let persisted: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
    expect((persisted as { pending: string[] }).pending).toEqual([idA, idB, idC]);

    // 2) Rate-limit mode: the batch stops after the first failure.
    mock.state.rateLimited = true;
    const results: readonly { id: string; state: string }[] = await first.syncChanged();
    // idA was never fetched before the limit hit... the limit applies to
    // every blob request, so the FIRST request already fails: the batch
    // stops with all three ids still pending.
    expect(results).toHaveLength(1);
    expect(results[0]?.state).toBe('failed');
    persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
    expect((persisted as { pending: string[] }).pending).toEqual([idA, idB, idC]);

    // 3) Limit lifted: a FRESH instance (empty cache, same state file)
    //    resumes the pending set and completes it — exactly once each.
    mock.state.rateLimited = false;
    const second: CatalogSync = makeService();
    const resumed: readonly { id: string; state: string }[] = await second.syncChanged();
    expect(resumed).toHaveLength(3);
    for (const r of resumed) {
      expect(r.state).toBe('updated');
    }
    persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
    expect((persisted as { pending: string[] }).pending).toEqual([]);
    expect(Object.keys((persisted as { etags: Record<string, string> }).etags).sort()).toEqual(
      [idA, idB, idC].sort(),
    );
    expect(fs.existsSync(path.join(tmp, 'catalogs', `${idA}.db`))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'catalogs', `${idB}.db`))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'catalogs', `${idC}.db`))).toBe(true);
  });

  it('completed ids are dropped from pending one-by-one (crash window)', async () => {
    const statePath: string = path.join(tmp, 'sync', 'catalog-batch.json');
    const service: CatalogSync = makeService();
    await service.checkForUpdates();
    // Single-catalog sync (what a batch run does per item).
    const result = await service.syncCatalog(idA);
    expect(result.state).toBe('updated');

    const persisted: { pending: string[]; etags: Record<string, string> } = JSON.parse(
      fs.readFileSync(statePath, 'utf8'),
    ) as { pending: string[]; etags: Record<string, string> };
    expect(persisted.pending).toEqual([idB, idC]);
    expect(persisted.etags[idA]).toBe(`"${idA}-v1"`);
  });

  it('BatchStateStore round-trips, self-heals from corruption, writes atomically', () => {
    const file: string = path.join(tmp, 'state.json');
    const store: BatchStateStore = new BatchStateStore(file, 'o/n');
    expect(store.load()).toEqual(emptyBatchState('o/n'));
    store.mutate((state) => {
      state.lastCommitSha = 'f'.repeat(40);
      state.pending = ['x', 'y'];
      state.etags['x'] = '"ex"';
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8') as string)).toMatchObject({
      repo: 'o/n',
      lastCommitSha: 'f'.repeat(40),
      pending: ['x', 'y'],
    });
    // No temp leftovers (atomic rename discipline).
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('state.json.tmp'))).toEqual([]);

    const healed: BatchStateStore = new BatchStateStore(file, 'o/n');
    expect(healed.load().lastCommitSha).toBe('f'.repeat(40));

    fs.writeFileSync(file, '{corrupt');
    const fresh: BatchStateStore = new BatchStateStore(file, 'o/n');
    expect(fresh.load()).toEqual(emptyBatchState('o/n'));
  });

  it('a 304 re-check does not resurrect completed ids', async () => {
    const service: CatalogSync = makeService();
    await service.checkForUpdates();
    await service.syncChanged();

    // Commits re-check: pin moved, but the per-file ETags now match the
    // server → everything comes back 304/unchanged and pending stays empty.
    mock.state.headSha = 'b'.repeat(40);
    mock.state.headEtag = '"commit-etag-2"';
    const check = await service.checkForUpdates();
    expect(check.changed).toBe(true);
    expect(check.changedIds).toEqual([idA, idB, idC]);
    const results: readonly { id: string; state: string }[] = await service.syncChanged();
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.state).toBe('unchanged');
    }
    // The 304 round-trips carried NO bodies: blob bytes served once each.
    expect(mock.blobRequests).toHaveLength(6); // 3 initial + 3 conditional
    const served: number[] = mock.blobRequests.filter((r) => r.ifNoneMatch === '').map(() => 1);
    expect(served).toHaveLength(3);

    const dbSha: string = fileSha256(path.join(tmp, 'catalogs', `${idA}.db`));
    expect(dbSha).not.toBe('');
  });
});
