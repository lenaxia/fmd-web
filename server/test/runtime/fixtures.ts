import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { buildFixtureZipball, zipballRootFor } from '../sync/modules/fixture-zipball.js';

/**
 * Runtime-test fixtures: the SAME asset set the compose e2e mounts
 * (e2e/fixtures), built into a tmp upstream tree and served by the REAL
 * e2e/mock-upstream.mjs — so the offline runtime integration exercises
 * the exact scenario the compose stack runs (fixture zipball, crafted
 * catalog .7z, recorded manga page).
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

export interface E2EConstants {
  readonly luaSha: string;
  readonly commitsSha: string;
  readonly repo: string;
  readonly dbRepo: string;
  readonly catalogId: string;
  readonly moduleName: string;
  readonly mangaPath: string;
  readonly mangaTitle: string;
  readonly searchQuery: string;
}

export function e2eConstants(): E2EConstants {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'e2e', 'fixtures', 'e2e.json'), 'utf8'),
  ) as E2EConstants;
}

/** The committed fixture lua tree (zipball content). */
export function fixtureLuaFiles(): readonly { path: string; content: string }[] {
  const luaRoot = path.join(repoRoot, 'e2e', 'fixtures', 'lua', 'lua');
  const files: { path: string; content: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      if (fs.statSync(file).isDirectory()) {
        walk(file, relPath);
      } else {
        files.push({ path: relPath, content: fs.readFileSync(file, 'utf8') });
      }
    }
  };
  walk(luaRoot, '');
  return files;
}

/** `uBaseUnit.pas:2740` Gregorian date → JDN (§6.7). */
function isoDateToJdn(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) {
    throw new Error(`invalid ISO date: ${iso}`);
  }
  const year = Number(m[1] as string);
  const month = Number(m[2] as string);
  const day = Number(m[3] as string);
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const mm = month + 12 * a - 3;
  return (
    day + Math.floor((153 * mm + 2) / 5) + 365 * y +
    Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045
  );
}

export interface FixtureEntry {
  readonly link: string;
  readonly title: string;
  readonly alttitles: string;
  readonly authors: string;
  readonly artists: string;
  readonly genres: string;
  readonly status: string;
  readonly summary: string;
  readonly numchapter: number;
  readonly jdn: number;
}

export function fixtureEntries(mockBase: string): readonly FixtureEntry[] {
  return [
    {
      link: `${mockBase}/manga/alpha-quest`,
      title: 'Alpha Quest',
      alttitles: 'Alpha Quest!',
      authors: 'Alpha Author',
      artists: 'Alpha Artist',
      genres: 'Action, Adventure',
      status: 'Ongoing',
      summary: 'The alpha fixture story. Rendered from the local mock upstream.',
      numchapter: 3,
      jdn: isoDateToJdn('2026-11-10'),
    },
    {
      link: `${mockBase}/manga/beta-trails`,
      title: 'Beta Trails',
      alttitles: '',
      authors: 'Beta Author',
      artists: '',
      genres: 'Slice of Life',
      status: 'Ongoing',
      summary: 'Beta trails through the mountains.',
      numchapter: 7,
      jdn: isoDateToJdn('2026-11-05'),
    },
    {
      link: `${mockBase}/manga/gamma-drift`,
      title: 'Gamma Drift',
      alttitles: '',
      authors: 'Gamma Author',
      artists: '',
      genres: 'Sci-Fi',
      status: 'Complete',
      summary: 'Gamma drifts between stations.',
      numchapter: 12,
      jdn: isoDateToJdn('2026-11-01'),
    },
    {
      link: `${mockBase}/manga/delta-harbor`,
      title: 'Delta Harbor',
      alttitles: '',
      authors: 'Delta Author',
      artists: '',
      genres: 'Drama',
      status: 'Complete',
      summary: 'Delta harbor stories at dusk.',
      numchapter: 24,
      jdn: isoDateToJdn('2026-10-20'),
    },
    {
      link: `${mockBase}/manga/zeta-landing`,
      title: 'Zeta Landing',
      alttitles: '',
      authors: 'Zeta Author',
      artists: '',
      genres: 'Mystery',
      status: 'Hiatus',
      summary: 'Zeta lands where nobody looks.',
      numchapter: 5,
      jdn: isoDateToJdn('2026-10-01'),
    },
  ];
}

export interface UpstreamTree {
  readonly root: string;
  readonly zipballRoot: string;
  cleanup(): void;
}

/**
 * Build the mock upstream tree — same layout prep.mjs produces for the
 * compose stack:
 *   api-github/commits.json · codeload/<repo>/zip/<luaSha>
 *   FMD2-DB/db/7z/<catalogId>.7z · site/manga/alpha-quest.html
 */
export function buildUpstreamTree(options: { mockBase: string; outDir?: string }): UpstreamTree {
  const e2e = e2eConstants();
  const root = options.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-upstream-'));
  const ownDir = options.outDir === undefined;
  fs.mkdirSync(path.join(root, 'api-github'), { recursive: true });
  fs.mkdirSync(path.join(root, 'site', 'manga'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'api-github', 'commits.json'),
    `${JSON.stringify([{ sha: e2e.commitsSha }], null, 2)}\n`,
    'utf8',
  );

  const files = fixtureLuaFiles();
  const zipballRoot = zipballRootFor('FMD2', e2e.luaSha);
  const zipball = buildFixtureZipball(zipballRoot, files);
  fs.mkdirSync(path.join(root, 'codeload', e2e.repo, 'zip'), { recursive: true });
  fs.writeFileSync(path.join(root, 'codeload', e2e.repo, 'zip', e2e.luaSha), zipball.bytes);

  // masterlist db (DBDataProcess.pas:137-153 schema) → real 7za archive
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-db-'));
  const dbFile = path.join(tmp, `${e2e.catalogId}.db`);
  const db = new Database(dbFile);
  try {
    db.exec(
      'CREATE TABLE masterlist (' +
        '"link" TEXT NOT NULL PRIMARY KEY,"title" TEXT,"alttitles" TEXT,"authors" TEXT,' +
        '"artists" TEXT,"genres" TEXT,"status" TEXT,"summary" TEXT,"numchapter" INTEGER,"jdn" INTEGER)',
    );
    const insert = db.prepare(
      'INSERT INTO masterlist ("link","title","alttitles","authors","artists","genres","status","summary","numchapter","jdn") ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    const entries = fixtureEntries(options.mockBase);
    db.transaction((): void => {
      for (const entry of entries) {
        insert.run(
          entry.link,
          entry.title,
          entry.alttitles,
          entry.authors,
          entry.artists,
          entry.genres,
          entry.status,
          entry.summary,
          entry.numchapter,
          entry.jdn,
        );
      }
    })();
  } finally {
    db.close();
  }
  const sevenZip = require.resolve('7zip-bin/linux/x64/7za');
  fs.chmodSync(sevenZip, 0o755);
  const sevenZipDir = path.join(root, 'FMD2-DB', 'db', '7z');
  fs.mkdirSync(sevenZipDir, { recursive: true });
  const packed = spawnSync(
    sevenZip,
    ['a', '-t7z', path.join(sevenZipDir, `${e2e.catalogId}.7z`), dbFile],
    { encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    throw new Error(`7za failed: ${String(packed.stderr)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  fs.copyFileSync(
    path.join(repoRoot, 'e2e', 'fixtures', 'upstream', 'site', 'manga', 'alpha-quest.html'),
    path.join(root, 'site', 'manga', 'alpha-quest.html'),
  );

  return {
    root,
    zipballRoot,
    cleanup: (): void => {
      if (ownDir) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export interface MockUpstream {
  readonly base: string;
  readonly port: number;
  /** Assert-only kill (tests manage lifecycle). */
  stop(): void;
}

/** Grab a free loopback port (the mock is started with it). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject): void => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', (): void => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((): void => {
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

/** Spawn the REAL e2e mock script (same file the compose container runs). */
export async function startMockUpstream(root: string, port = 0): Promise<MockUpstream> {
  return new Promise((resolve, reject): void => {
    const child: ChildProcess = spawn(
      process.execPath,
      [path.join(repoRoot, 'e2e', 'mock-upstream.mjs'), '--root', root, '--port', String(port)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    const onChunk = (chunk: Buffer): void => {
      stdout += String(chunk);
      const m = /mock listening on (\d+)/.exec(stdout);
      if (m !== null) {
        child.stdout?.off('data', onChunk);
        const boundPort = Number(m[1]);
        resolve({
          base: `http://127.0.0.1:${String(boundPort)}`,
          port: boundPort,
          stop: (): void => {
            child.kill('SIGTERM');
          },
        });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', (chunk: Buffer): void => {
      stdout += String(chunk);
    });
    child.on('exit', (code): void => {
      reject(new Error(`mock upstream exited early (code ${String(code)}): ${stdout}`));
    });
  });
}

/** One-shot helper: free port + started mock (root built with its base). */
export async function startMock(root: string): Promise<{ mock: MockUpstream; base: string }> {
  const port = await freePort();
  const mock = await startMockUpstream(root, port);
  return { mock, base: mock.base };
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export { repoRoot };
