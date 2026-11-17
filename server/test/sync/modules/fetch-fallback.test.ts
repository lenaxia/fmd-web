import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CodeloadArchiveFetcher,
  createModuleSyncService,
  DEFAULT_TARBALL_API_BASE_URL,
  githubTarballUrl,
  ModuleSyncError,
  type ModuleSyncConfig,
  type ModuleSyncResult,
} from '../../../src/index.js';
import {
  buildFixtureZipball,
  fixtureTreeV1,
  FIXTURE_REPO,
  FIXTURE_SHA,
  zipballRootFor,
  type FixtureFile,
} from './fixture-zipball.js';

/**
 * Fetch-chain fallback (launch defect (d)): codeload answered HTTP 500
 * on this network while api.github.com's tarball endpoint served the
 * same pinned commit. The chain must fall back on zipball 5xx /
 * unreachable, verify the tarball root under its OWN convention
 * (`<owner>-<Repo>-<sha7>`), extract the lua/ subtree, and fail with a
 * TYPED ModuleSyncFetchError carrying the full attempt chain when both
 * legs fail. 4xx on the zipball leg fails FAST (no tarball attempt — a
 * wrong pin is not a transport problem).
 */

/** Minimal ustar builder (regular files only) — mirrors the tar reader. */
function buildTarGz(root: string, files: readonly FixtureFile[]): Uint8Array {
  const blocks: Buffer[] = [];
  const writeHeader = (name: string, size: number): void => {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0, 'utf8');
    header.write('000777\0', 100, 'ascii'); // mode
    header.write('000000\0', 108, 'ascii'); // uid
    header.write('000000\0', 116, 'ascii'); // gid
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii'); // mtime
    header.write('        ', 148, 'ascii'); // checksum placeholder (spaces)
    header.write('0', 156, 'ascii'); // typeflag: regular file
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header);
  };
  for (const file of files) {
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    writeHeader(`${root}/lua/${file.path}`, data.length);
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) {
      blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

interface ChainMock {
  readonly baseUrl: string;
  ready(): Promise<void>;
  setZipball(status: number, body?: Uint8Array): void;
  setTarball(status: number, body?: Uint8Array): void;
  readonly requests: { path: string }[];
  close(): Promise<void>;
}

/** Loopback upstream with independent zipball/tarball canned responses. */
function startChainMock(): ChainMock {
  const requests: { path: string }[] = [];
  let zipball: { status: number; body: Uint8Array } = { status: 500, body: new Uint8Array() };
  let tarball: { status: number; body: Uint8Array } = { status: 500, body: new Uint8Array() };
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push({ path });
    const isTarball = path.includes('/tarball/');
    const leg = isTarball ? tarball : zipball;
    res.writeHead(leg.status, { 'content-type': isTarball ? 'application/x-gzip' : 'application/zip' });
    res.end(Buffer.from(leg.body));
  });
  const listening = new Promise<void>((resolve, reject): void => {
    server.once('listening', (): void => resolve());
    server.once('error', reject);
  });
  server.listen(0, '127.0.0.1');
  return {
    ready(): Promise<void> {
      return listening;
    },
    get baseUrl(): string {
      const address = server.address() as AddressInfo;
      return `http://${address.address}:${String(address.port)}`;
    },
    setZipball(status: number, body: Uint8Array = new Uint8Array()): void {
      zipball = { status, body };
    },
    setTarball(status: number, body: Uint8Array = new Uint8Array()): void {
      tarball = { status, body };
    },
    requests,
    close(): Promise<void> {
      return new Promise((resolve, reject): void => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('module-archive fetch chain — zipball → tarball fallback (canned upstreams)', (): void => {
  const mock = startChainMock();
  let dataDir = '';

  beforeAll(async (): Promise<void> => {
    await mock.ready();
  });

  function makeConfig(): ModuleSyncConfig {
    return {
      repo: FIXTURE_REPO,
      sha: FIXTURE_SHA,
      codeloadBaseUrl: mock.baseUrl,
      tarballApiBaseUrl: mock.baseUrl,
      dataDir,
      luaDirOverride: undefined,
      autoBump: false,
    };
  }

  afterAll(async (): Promise<void> => {
    await mock.close();
  });

  it('falls back to the tarball on zipball 500 and installs the tree', async (): Promise<void> => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-fetch-fallback-'));
    mock.setZipball(500);
    mock.setTarball(200, buildTarGz(`dazedcat19-FMD2-${FIXTURE_SHA.slice(0, 7)}`, fixtureTreeV1()));

    const result: ModuleSyncResult = await createModuleSyncService(makeConfig()).sync();

    expect(result.report.modules).toBe(4);
    expect(result.report.failures).toEqual([]);
    // both legs were attempted, zipball first
    expect(mock.requests.map((r) => r.path)).toEqual([
      `/${FIXTURE_REPO}/zip/${FIXTURE_SHA}`,
      `/repos/${FIXTURE_REPO}/tarball/${FIXTURE_SHA}`,
    ]);
  });

  it('refuses (typed) when BOTH legs fail — attempts chain surfaced', async (): Promise<void> => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-fetch-fallback-'));
    mock.setZipball(500);
    mock.setTarball(503);

    const error = await capture(createModuleSyncService(makeConfig()).sync());
    expect(error).toBeInstanceOf(ModuleSyncError);
    expect(error?.reason).toBe('fetch-failed');
    expect(error?.details).toMatchObject({
      fetchKind: 'http-error',
      attempts: [
        { endpoint: 'zipball', status: 500 },
        { endpoint: 'tarball', status: 503 },
      ],
    });
  });

  it('zipball 404 (wrong pin) fails FAST — the tarball leg never fires', async (): Promise<void> => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-fetch-fallback-'));
    mock.requests.length = 0;
    mock.setZipball(404);
    mock.setTarball(200, buildTarGz(`dazedcat19-FMD2-${FIXTURE_SHA.slice(0, 7)}`, fixtureTreeV1()));

    const error = await capture(createModuleSyncService(makeConfig()).sync());
    expect(error?.reason).toBe('fetch-failed');
    expect(error?.details).toMatchObject({
      fetchKind: 'http-error',
      attempts: [{ endpoint: 'zipball', status: 404 }],
    });
    expect(mock.requests.some((r) => r.path.includes('/tarball/'))).toBe(false);
  });

  it('unreachable upstream is typed unreachable (both legs, no statuses)', async (): Promise<void> => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-fetch-fallback-'));
    const dead = startChainMock();
    await dead.ready();
    const deadUrl = dead.baseUrl; // capture BEFORE close (address() is null after)
    await dead.close();

    const config: ModuleSyncConfig = { ...makeConfig(), codeloadBaseUrl: deadUrl, tarballApiBaseUrl: deadUrl };
    const error = await capture(createModuleSyncService(config).sync());
    expect(error?.reason).toBe('fetch-failed');
    expect(error?.details).toMatchObject({
      fetchKind: 'unreachable',
      attempts: [
        { endpoint: 'zipball' },
        { endpoint: 'tarball' },
      ],
    });
  });

  it('tarball root naming another commit is a sha-mismatch refusal', async (): Promise<void> => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-fetch-fallback-'));
    mock.setZipball(500);
    mock.setTarball(200, buildTarGz('dazedcat19-FMD2-0000000', fixtureTreeV1()));

    const error = await capture(createModuleSyncService(makeConfig()).sync());
    expect(error?.reason).toBe('sha-mismatch');
    expect(error?.message).toContain('dazedcat19-FMD2-0000000');
  });

  it('githubTarballUrl composes the api.github.com endpoint (default base)', (): void => {
    expect(githubTarballUrl(FIXTURE_REPO, FIXTURE_SHA, DEFAULT_TARBALL_API_BASE_URL)).toBe(
      `https://api.github.com/repos/${FIXTURE_REPO}/tarball/${FIXTURE_SHA}`,
    );
  });

  it('CodeloadArchiveFetcher prefers the zipball when it answers 200 (no fallback traffic)', async (): Promise<void> => {
    dataDir = mkdtempSync(join(tmpdir(), 'fmd-fetch-fallback-'));
    mock.requests.length = 0;
    mock.setZipball(200, buildFixtureZipball(zipballRootFor('FMD2', FIXTURE_SHA), fixtureTreeV1()).bytes);
    mock.setTarball(200, new Uint8Array());

    const archive = await new CodeloadArchiveFetcher().fetchArchive({
      zipball: `${mock.baseUrl}/${FIXTURE_REPO}/zip/${FIXTURE_SHA}`,
      tarball: `${mock.baseUrl}/repos/${FIXTURE_REPO}/tarball/${FIXTURE_SHA}`,
    });
    expect(archive.format).toBe('zip');
    expect(archive.endpoint).toBe('zipball');
    expect(mock.requests).toHaveLength(1);
  });
});

interface SyncErrorShape {
  readonly reason?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

async function capture(promise: Promise<unknown>): Promise<(Error & SyncErrorShape) | undefined> {
  return promise.then(
    (): undefined => {
      throw new Error('expected the sync to be refused');
    },
    (error: unknown): Error & SyncErrorShape => error as Error & SyncErrorShape,
  );
}
