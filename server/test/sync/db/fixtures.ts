/**
 * Catalog sync test fixtures (offline, DESIGN.md §13): local SQLite
 * catalogs packed into real .7z archives with the 7zip-bin binary, plus
 * a loopback mock of the raw.githubusercontent + api.github.com surface
 * (ETag / 304 / rate-limit responses, request log).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';

/** Absolute path of the test-shipped 7za binary (docker equivalent). */
export function sevenZipPath(): string {
  const require: NodeRequire = createRequire(import.meta.url);
  const bin: string = require.resolve('7zip-bin/linux/x64/7za');
  fs.chmodSync(bin, 0o755);
  return bin;
}

export interface FixtureRow {
  readonly link: string;
  readonly title: string;
  readonly alttitles?: string;
  readonly authors?: string;
  readonly artists?: string;
  readonly genres?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly numchapter?: number;
  /** ISO date (converted with the §6.7 helper by the caller). */
  readonly jdn: number;
}

/** Build a catalog db exactly like FMD2-DB's pipeline does
 * (DBDataProcess.pas:137-153 — table `masterlist`, rollback journal). */
export function createCatalogDb(file: string, rows: readonly FixtureRow[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const db: Database.Database = new Database(file);
  try {
    db.exec(
      'CREATE TABLE masterlist (' +
        '"link" TEXT NOT NULL PRIMARY KEY,' +
        '"title" TEXT,' +
        '"alttitles" TEXT,' +
        '"authors" TEXT,' +
        '"artists" TEXT,' +
        '"genres" TEXT,' +
        '"status" TEXT,' +
        '"summary" TEXT,' +
        '"numchapter" INTEGER,' +
        '"jdn" INTEGER)',
    );
    const insert: Database.Statement = db.prepare(
      'INSERT INTO masterlist ("link","title","alttitles","authors","artists","genres","status","summary","numchapter","jdn") ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    db.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.link,
          row.title,
          row.alttitles ?? '',
          row.authors ?? '',
          row.artists ?? '',
          row.genres ?? '',
          row.status ?? '',
          row.summary ?? '',
          row.numchapter ?? 0,
          row.jdn,
        );
      }
    })();
  } finally {
    db.close();
  }
}

/** Pack a directory into a real .7z (LZMA) with the 7za binary. */
export function pack7z(archivePath: string, sourceDir: string): void {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.rmSync(archivePath, { force: true });
  // cwd trick: '.' packs the directory contents at archive root (p7zip
  // does no shell globbing, so a literal '*' would break the archive).
  const res = spawnSync(sevenZipPath(), ['a', '-t7z', archivePath, '.', '-y'], {
    cwd: sourceDir,
    stdio: 'pipe',
  });
  if (res.status !== 0) {
    throw new Error(`7za a failed (${String(res.status)}): ${String(res.stderr)}`);
  }
}

export function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Build a one-entry .7z containing `<id>.db` made from `rows`. */
export function buildCatalogArchive(tmpDir: string, id: string, rows: readonly FixtureRow[]): string {
  const staging: string = path.join(tmpDir, `stage-${id}`);
  fs.mkdirSync(staging, { recursive: true });
  createCatalogDb(path.join(staging, `${id}.db`), rows);
  const archive: string = path.join(tmpDir, `${id}.7z`);
  pack7z(archive, staging);
  fs.rmSync(staging, { recursive: true, force: true });
  return archive;
}

// ── mock api.github.com + raw.githubusercontent.com ─────────────────

export interface LoggedRequest {
  readonly url: string;
  readonly ifNoneMatch: string;
}

export interface MockGitHubState {
  /** Commits-API response SHA + ETag. */
  headSha: string;
  headEtag: string;
  /** Catalog blob bytes + ETag per id. */
  blobs: Map<string, { bytes: Buffer; etag: string }>;
  /** When true, blob endpoint answers 403 like an exhausted rate limit. */
  rateLimited: boolean;
}

export interface MockGitHubServer {
  readonly baseUrl: string;
  readonly requests: LoggedRequest[];
  /** Requests to the blob endpoint only. */
  readonly blobRequests: LoggedRequest[];
  readonly state: MockGitHubState;
  close(): void;
}

export function startMockGitHub(): Promise<MockGitHubServer> {
  const state: MockGitHubState = {
    headSha: '',
    headEtag: '"commit-etag-1"',
    blobs: new Map<string, { bytes: Buffer; etag: string }>(),
    rateLimited: false,
  };
  const requests: LoggedRequest[] = [];
  const blobRequests: LoggedRequest[] = [];

  const server: http.Server = http.createServer((req, res) => {
    const ifNoneMatch: string = req.headers['if-none-match'] ?? '';
    const url: string = req.url ?? '';
    requests.push({ url, ifNoneMatch });

    // Commits API: /repos/<owner>/<name>/commits?sha=<ref>&per_page=1
    if (url.startsWith('/repos/') && url.includes('/commits')) {
      if (ifNoneMatch !== '' && ifNoneMatch === state.headEtag) {
        res.writeHead(304, { ETag: state.headEtag });
        res.end();
        return;
      }
      const body: string = JSON.stringify([{ sha: state.headSha }]);
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: state.headEtag });
      res.end(body);
      return;
    }

    // Blob: /<owner>/<name>/<ref>/db/7z/<id>.7z
    if (url.includes('/7z/')) {
      blobRequests.push({ url, ifNoneMatch });
      if (state.rateLimited) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: 'API rate limit exceeded',
            documentation_url: 'https://docs.github.com/rest',
          }),
        );
        return;
      }
      const id: string = path.basename(url).replace(/\.7z$/, '');
      const blob: { bytes: Buffer; etag: string } | undefined = state.blobs.get(id);
      if (blob === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (ifNoneMatch !== '' && ifNoneMatch === blob.etag) {
        res.writeHead(304, { ETag: blob.etag });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-7z-compressed', ETag: blob.etag });
      res.end(blob.bytes);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr: AddressInfo = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${String(addr.port)}`,
        requests,
        blobRequests,
        state,
        close: (): void => {
          server.close();
        },
      });
    });
  });
}

/** Valid 32-hex module ids for fixtures. */
export function fixtureId(seed: string): string {
  const hex: string = Buffer.from(seed.padEnd(16, '0').slice(0, 16), 'utf8').toString('hex');
  return hex.slice(0, 32);
}

export const TEST_ROOT: string = path.dirname(fileURLToPath(import.meta.url));
