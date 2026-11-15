#!/usr/bin/env node
/**
 * e2e fixture prep — builds the mock upstream tree (the ONLY state the
 * compose stack mounts, besides the static fixture lua tree):
 *
 *   <out>/api-github/commits.json          commits-API fixture
 *   <out>/codeload/<repo>/zip/<luaSha>     fixture zipball (FMD2-<sha10>/lua/...)
 *   <out>/FMD2-DB/db/7z/<catalogId>.7z     crafted catalog archive
 *                                          (real 7za; masterlist db)
 *   <out>/site/manga/alpha-quest.html      recorded manga-info page
 *   <out>/manifest.json                    what was built (evidence)
 *
 * Zero external dependencies beyond the workspace's node_modules:
 * better-sqlite3 (catalog db) + 7zip-bin (archive), both already
 * workspace deps — the same binaries the server itself uses.
 *
 * Usage: node e2e/prep.mjs --out <dir> --mock-base <http://host:port>
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.resolve(fileURLToPath(import.meta.url), '../../package.json'));
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { out: null, mockBase: 'http://e2e-mock:8081' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key === 'out') args.out = argv[i + 1];
    else if (key === 'mock-base') args.mockBase = argv[i + 1].replace(/\/+$/, '');
  }
  if (args.out === null) {
    console.error('usage: prep.mjs --out <dir> [--mock-base url]');
    process.exit(2);
  }
  return args;
}

function crc32(buf) {
  let table = crc32.table;
  if (table === undefined) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Stored-entry zip with a codeload root dir — same shape the module
 * sync's zipball reader accepts (and the same layout the sync tests
 * build at runtime). */
function buildZipball(root, files, subdir = 'lua') {
  const prefix = `${root}/${subdir}/`;
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${prefix}${file.path}`, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    chunks.push(local, data);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDir, eocd]);
}

/** uBaseUnit.pas:2740 Gregorian date → JDN (the §6.7 helper). */
function isoDateToJdn(iso) {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const a = Math.floor((14 - month) / 12);
  const yy = year + 4800 - a;
  const mm = month + 12 * a - 3;
  return (
    day + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
  );
}

const E2E = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'e2e.json'), 'utf8'));

// ── synthetic chapter fixture images (pure-node, offline) ────────────
// The same encoder shape the packer tests use: a minimal-but-valid
// grayscale baseline JPEG (flat blocks, single-symbol Huffman tables)
// plus a COM segment carrying the (chapter, page) identity so every
// image's bytes are distinct and deterministic.

const huffmanTable = (bits, values) => {
  const out = Buffer.alloc(1 + 16 + values.length);
  out[0] = 0; // Tc/Th
  for (let i = 0; i < 16; i += 1) out[1 + i] = bits[i] ?? 0;
  for (let i = 0; i < values.length; i += 1) out[17 + i] = values[i] ?? 0;
  return out;
};

function jpegSegment(marker, payload) {
  const out = Buffer.alloc(2 + 2 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(payload.length + 2, 2);
  payload.copy(out, 4);
  return out;
}

function makeSolidJpeg(width, height, identity) {
  const quant = Buffer.alloc(65);
  quant[0] = 0; // Pq=0, Tq=0
  quant.fill(16, 1); // flat quant table
  const sof = Buffer.alloc(8);
  sof[0] = 8; // precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // components
  sof[6] = 0x11; // sampling 1x1
  sof[7] = 0; // quant table 0
  const dhtDc = huffmanTable([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0]);
  const dhtAc = huffmanTable([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0]);
  dhtDc[0] = 0x00; // Tc=0 (DC)
  dhtAc[0] = 0x10; // Tc=1 (AC)
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);

  const blocksPerRow = Math.ceil(width / 8);
  const blockRows = Math.ceil(height / 8);
  const bitWriter = { byte: 0, count: 0, out: [] };
  const writeBit = (bit) => {
    bitWriter.byte = ((bitWriter.byte << 1) | (bit & 1)) & 0xff;
    bitWriter.count += 1;
    if (bitWriter.count === 8) {
      if (bitWriter.byte === 0xff) {
        bitWriter.out.push(0xff, 0x00); // byte stuffing
      }
      bitWriter.out.push(bitWriter.byte);
      bitWriter.byte = 0;
      bitWriter.count = 0;
    }
  };
  for (let i = 0; i < blocksPerRow * blockRows; i += 1) {
    writeBit(0); // DC symbol 0 (diff category 0, no extra bits)
    writeBit(0); // AC EOB symbol 0
  }
  while (bitWriter.count !== 0) {
    writeBit(1); // pad with 1-bits
  }

  const com = Buffer.from(`chapter:${identity.chapter} page:${identity.page}`, 'utf8');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    jpegSegment(0xdb, quant), // DQT
    jpegSegment(0xc0, sof), // SOF0 baseline
    jpegSegment(0xc4, dhtDc), // DHT DC
    jpegSegment(0xc4, dhtAc), // DHT AC
    jpegSegment(0xfe, com), // COM — deterministic per-image identity
    jpegSegment(0xda, sos), // SOS
    Buffer.from(bitWriter.out),
    bitWriter.count > 0 ? Buffer.from([bitWriter.byte]) : Buffer.alloc(0),
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

/** Chapter page counts (e2e.json): 1 = short, 2 = long (cancel/resume), 3 = tiny. */
function chapterPages() {
  const raw = E2E.chapterPages ?? {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
}

// Alpha Quest is the newest entry (latest = ORDER BY jdn DESC) and the
// only 'alpha' match for the FTS search step.
const ENTRIES = [
  {
    link: '/manga/alpha-quest',
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
    link: '/manga/beta-trails',
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
    link: '/manga/gamma-drift',
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
    link: '/manga/delta-harbor',
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
    link: '/manga/zeta-landing',
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

function main() {
  const args = parseArgs(process.argv);
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(args.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'api-github'), { recursive: true });
  fs.mkdirSync(path.join(out, 'site', 'manga'), { recursive: true });

  // 1. commits API fixture
  fs.writeFileSync(
    path.join(out, 'api-github', 'commits.json'),
    `${JSON.stringify([{ sha: E2E.commitsSha }], null, 2)}\n`,
    'utf8',
  );

  // 2. fixture zipball from the committed fixture lua tree
  const luaRoot = path.join(e2eDir, 'fixtures', 'lua', 'lua');
  const zipFiles = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      if (fs.statSync(file).isDirectory()) walk(file, relPath);
      else zipFiles.push({ path: relPath, content: fs.readFileSync(file, 'utf8') });
    }
  };
  walk(luaRoot, '');
  const zipRoot = `FMD2-${E2E.luaSha.slice(0, 10)}`;
  const zipball = buildZipball(zipRoot, zipFiles);
  const repoDir = path.join(out, 'codeload', E2E.repo, 'zip');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, E2E.luaSha), zipball);

  // 3. crafted catalog archive: masterlist db (DBDataProcess.pas schema)
  //    → real 7za -t7z archive at FMD2-DB/db/7z/<id>.7z
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-e2e-prep-'));
  const dbFile = path.join(tmp, `${E2E.catalogId}.db`);
  const db = new Database(dbFile);
  db.exec(
    'CREATE TABLE masterlist (' +
      '"link" TEXT NOT NULL PRIMARY KEY,"title" TEXT,"alttitles" TEXT,"authors" TEXT,' +
      '"artists" TEXT,"genres" TEXT,"status" TEXT,"summary" TEXT,"numchapter" INTEGER,"jdn" INTEGER)',
  );
  const insert = db.prepare(
    'INSERT INTO masterlist ("link","title","alttitles","authors","artists","genres","status","summary","numchapter","jdn") ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  db.transaction(() => {
    for (const entry of ENTRIES) {
      insert.run(
        args.mockBase + entry.link,
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
  db.close();

  const sevenZip = require.resolve('7zip-bin/linux/x64/7za');
  fs.chmodSync(sevenZip, 0o755);
  const sevenZipDir = path.join(out, 'FMD2-DB', 'db', '7z');
  fs.mkdirSync(sevenZipDir, { recursive: true });
  const packed = spawnSync(sevenZip, ['a', '-t7z', path.join(sevenZipDir, `${E2E.catalogId}.7z`), dbFile], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (packed.status !== 0) {
    console.error('7za failed:', packed.stdout, packed.stderr);
    process.exit(1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // 4. recorded manga-info page — chapter hrefs absolutized against the
  //    mock base (downloads then receive absolute chapter URLs through
  //    the §5.8 pipeline; the preview assertions key on the path suffix).
  const mangaPageRaw = fs.readFileSync(
    path.join(e2eDir, 'fixtures', 'upstream', 'site', 'manga', 'alpha-quest.html'),
    'utf8',
  );
  const mangaPage = mangaPageRaw.replaceAll('href="/manga/', `href="${args.mockBase}/manga/`);
  fs.mkdirSync(path.join(out, 'site', 'manga'), { recursive: true });
  fs.writeFileSync(path.join(out, 'site', 'manga', 'alpha-quest.html'), mangaPage, 'utf8');

  // 4b. the download fixture tree (§7.1 e2e): chapter pages → page
  //     containers → images, deterministic bytes per (chapter, page).
  const pagesByChapter = chapterPages();
  for (const [chapter, pages] of Object.entries(pagesByChapter)) {
    const chapterDir = path.join(out, 'site', 'manga', 'alpha-quest', 'ch', chapter);
    fs.mkdirSync(path.join(chapterDir, 'page'), { recursive: true });
    fs.mkdirSync(path.join(chapterDir, 'image'), { recursive: true });
    const containers = [];
    for (let page = 1; page <= pages; page += 1) {
      const containerUrl = `${args.mockBase}/manga/alpha-quest/ch/${chapter}/page/${page}`;
      containers.push(`    <li><a href="${containerUrl}">page ${page}</a></li>`);
      const imageUrl = `${args.mockBase}/manga/alpha-quest/ch/${chapter}/image/${page}.jpg`;
      fs.writeFileSync(
        path.join(chapterDir, 'page', `${page}.html`),
        `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Alpha Quest ch${chapter} p${page}</title></head>\n<body>\n  <img id="image" src="${imageUrl}" alt="page ${page}">\n</body>\n</html>\n`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(chapterDir, 'image', `${page}.jpg`),
        makeSolidJpeg(64, 40, { chapter, page }),
      );
    }
    fs.writeFileSync(
      path.join(out, 'site', 'manga', 'alpha-quest', 'ch', `${chapter}.html`),
      `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Alpha Quest — chapter ${chapter}</title></head>\n<body>\n  <h1 id="manga-title">Alpha Quest — Chapter ${chapter}</h1>\n  <div id="pages">\n    <ul>\n${containers.join('\n')}\n    </ul>\n  </div>\n</body>\n</html>\n`,
      'utf8',
    );
  }

  // 5. manifest (evidence)
  const manifest = {
    mockBase: args.mockBase,
    luaSha: E2E.luaSha,
    zipballRoot: zipRoot,
    zipballBytes: zipball.length,
    commitsSha: E2E.commitsSha,
    catalogId: E2E.catalogId,
    chapterPages: pagesByChapter,
    entries: ENTRIES.map((e) => ({ title: e.title, link: args.mockBase + e.link, jdn: e.jdn })),
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 6. compose env (the app override consumes this via env_file)
  const envVars = [
    `FMD2_REPO=${E2E.repo}`,
    `FMD2_LUA_SHA=${E2E.luaSha}`,
    'FMD2_CODELOAD_URL=http://e2e-mock:8081/codeload',
    'FMD_DB_URL=http://e2e-mock:8081/FMD2-DB/db',
    'FMD_DB_API_BASE=http://e2e-mock:8081/api-github',
    'FMD_BOOTSTRAP_CATALOGS=' + E2E.catalogId,
    'FMD_HTTP_ALLOW_HOSTS=e2e-mock',
    'FMD_STATIC_DIR=/app/web/dist-web',
    // D20 progress observability: fixture syncs finish in milliseconds;
    // stage pacing lets the compose e2e assert the banner + stage logs.
    'FMD_BOOTSTRAP_DELAY_MS=2500',
  ];
  fs.writeFileSync(path.join(out, 'e2e.env'), `${envVars.join('\n')}\n`, 'utf8');

  console.log(`prep: upstream tree at ${out} (zipball ${String(zipball.length)}B, catalog ${E2E.catalogId})`);
}

main();
