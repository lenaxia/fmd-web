/**
 * Site-first browse failure taxonomy at the sync layer: a missing
 * FMD2-DB blob (HTTP 404) surfaces as the STABLE `no-catalog:` error
 * prefix (distinct from transient network failures), and the
 * fine-grained provision phases (downloading → extracting →
 * installing) stream through the onProgress seam.
 */
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogSync } from '../../../src/sync/db/sync-service.js';
import { NO_CATALOG_ERROR_PREFIX } from '../../../src/api/services.js';
import { buildCatalogArchive, fixtureId, startMockGitHub, type FixtureRow, type MockGitHubServer } from './fixtures.js';

const ID_KNOWN: string = fixtureId('nocatalog-known');
const ID_MISSING: string = fixtureId('nocatalog-missing');

const ROWS: FixtureRow[] = [
  { link: '/m/one', title: 'One', status: 'Ongoing', summary: 's', numchapter: 1, jdn: 45000 },
];

describe('catalog sync 404 taxonomy + progress phases (site-first browse)', (): void => {
  let tmp: string;
  let mock: MockGitHubServer;
  let service: CatalogSync;

  beforeEach(async (): Promise<void> => {
    tmp = fs.mkdtempSync('/tmp/opencode/sync404-');
    mock = await startMockGitHub();
    mock.state.headSha = 'c'.repeat(40);
    mock.state.headEtag = '"commits-1"';
    mock.state.blobs.set(
      ID_KNOWN,
      { bytes: fs.readFileSync(buildCatalogArchive(tmp, ID_KNOWN, ROWS)), etag: `"blob-${ID_KNOWN}-1"` },
    );
    service = new CatalogSync({
      dataDir: tmp,
      dbUrl: `${mock.baseUrl}/owner/dbrepo/master/db`,
      apiBase: mock.baseUrl,
    });
  });

  afterEach((): void => {
    fs.rmSync(tmp, { recursive: true, force: true });
    mock.close();
  });

  it('a missing FMD2-DB blob (404) → failed with the stable no-catalog prefix', async (): Promise<void> => {
    const result = await service.syncCatalog(ID_MISSING);
    expect(result.state).toBe('failed');
    expect(result.error?.startsWith(NO_CATALOG_ERROR_PREFIX)).toBe(true);
    expect(result.error).toContain('HTTP 404');
    // nothing installed for the missing id
    expect(service.store.getMeta(ID_MISSING)).toBeUndefined();
  });

  it('a successful install streams the downloading→extracting→installing phases in order', async (): Promise<void> => {
    const phases: string[] = [];
    const result = await service.syncCatalog(ID_KNOWN, (phase): void => {
      phases.push(phase);
    });
    expect(result.state).toBe('updated');
    expect(phases).toEqual(['downloading', 'extracting', 'installing']);
    expect(service.store.getMeta(ID_KNOWN)?.dbSha).toBe(result.dbSha);
  });

  it('no onProgress consumer changes nothing on the wire', async (): Promise<void> => {
    const result = await service.syncCatalog(ID_KNOWN);
    expect(result.state).toBe('updated');
  });
});
