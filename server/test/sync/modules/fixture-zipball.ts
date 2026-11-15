import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../../../src/sync/modules/zipball.js';

/**
 * Fixture zipball builder (offline): real FMD2 module sources from the
 * local checkout, packed as a stored-entry zip with a codeload-shaped root
 * directory (`FMD2-<sha10>`). No committed binaries — archives are built
 * in the test's tmp dirs at runtime.
 */

const testDir = dirname(fileURLToPath(import.meta.url));

export function resolveFmd2LuaDir(): string {
  const fromEnv = process.env['FMD2_LUA_DIR'];
  if (fromEnv !== undefined && existsSync(fromEnv)) {
    return fromEnv;
  }
  let dir = testDir;
  for (;;) {
    const candidate = join(dir, 'FMD2', 'lua');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('FMD2 lua dir not found (set FMD2_LUA_DIR)');
    }
    dir = parent;
  }
}

export interface FixtureFile {
  /** Path relative to the zipball root (posix, e.g. `modules/11Toon.lua`). */
  readonly path: string;
  readonly content: string | Buffer;
}

export interface FixtureZipball {
  readonly bytes: Buffer;
  readonly root: string;
  readonly files: readonly FixtureFile[];
}

/**
 * Build a zip archive (stored entries) with every file under
 * `<root>/<subdir>` — the codeload shape is `<root>/lua/...` (the sync
 * service extracts the `lua/` subtree); pass '' for root-level files.
 */
export function buildFixtureZipball(
  root: string,
  files: readonly FixtureFile[],
  subdir: string = 'lua',
): FixtureZipball {
  const prefix = subdir === '' ? `${root}/` : `${root}/${subdir}/`;
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(`${prefix}${file.path}`, 'utf8');
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, data);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(0, 10); // method
    entry.writeUInt16LE(0, 12); // mod time
    entry.writeUInt16LE(0, 14); // mod date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk start
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);

    offset += local.length + data.length;
  }

  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { bytes: Buffer.concat([...chunks, centralDir, eocd]), root, files };
}

/** Codeload root-dir convention: `<RepoName>-<first 10 hex of the SHA>`. */
export function zipballRootFor(repoBase: string, sha: string): string {
  return `${repoBase}-${sha.slice(0, 10)}`;
}

// --- real-source fixture trees ------------------------------------------------

/** The pinned FMD2 commit the local checkout sits at (test constant). */
export const FIXTURE_SHA = '97c903b340d2b0fd82871dba1b0aa5f04a1790e8';
export const FIXTURE_REPO = 'dazedcat19/FMD2';

export const REAL_MODULE_FILES = ['11Toon.lua', 'AsuraScans.lua', 'Hentai2Read.lua', 'YoungAceUp.lua'] as const;

export const REAL_TREE_SUPPORT_FILES = [
  { path: 'templates/Madara.lua', source: 'templates/Madara.lua' },
  { path: 'utils/jsunpack.lua', source: 'utils/jsunpack.lua' },
  { path: 'modules/MangaPlus.proto', source: 'modules/MangaPlus.proto' },
] as const;

function readReal(path: string): string {
  return readFileSync(join(resolveFmd2LuaDir(), path), 'utf8');
}

/** v1 tree: four real module files + templates/utils + a non-lua asset. */
export function fixtureTreeV1(): FixtureFile[] {
  return [
    ...REAL_MODULE_FILES.map((file) => ({ path: `modules/${file}`, content: readReal(`modules/${file}`) })),
    ...REAL_TREE_SUPPORT_FILES.map((f) => ({ path: f.path, content: readReal(f.source) })),
  ];
}

/** v2 tree: v1 with one module renamed (same ID), one removed, one added. */
export function fixtureTreeV2(): FixtureFile[] {
  const kept = fixtureTreeV1().filter((f) => f.path !== 'modules/Hentai2Read.lua');
  const renamed = kept.map((f): FixtureFile =>
    f.path === 'modules/11Toon.lua'
      ? { path: f.path, content: (f.content as string).replace("m.Name                     = '11Toon'", "m.Name                     = '11Toon Classic'") }
      : f,
  );
  return [
    ...renamed,
    {
      path: 'modules/CraftedFixture.lua',
      content: [
        'function Init()',
        "  local m = NewWebsiteModule()",
        "  m.ID = 'aaaacccc111122223333444455556666'",
        "  m.Name = 'CraftedFixture'",
        "  m.RootURL = 'https://craftedfixture.example'",
        'end',
        '',
      ].join('\n'),
    },
  ];
}

/** v1 tree plus a file that cannot parse — the staged-Init refusal fixture. */
export function fixtureTreeWithBrokenModule(): FixtureFile[] {
  return [
    ...fixtureTreeV1(),
    {
      path: 'modules/Broken.lua',
      content: 'function Init(\n  this is not lua }} }\n',
    },
  ];
}

/** A zipball whose root names a DIFFERENT commit than the one requested. */
export function fixtureZipballWrongSha(files: readonly FixtureFile[], repoBase: string): FixtureZipball {
  const impostorSha = '0000000000abcdefabcdefabcdefabcdefabcd';
  return buildFixtureZipball(zipballRootFor(repoBase, impostorSha), files);
}

export const FIXTURE_IDS = {
  elevenToon: 'c7b742a4dc8a451fa95baec1aa183b39',
  asuraScans: '7103ae6839ea46ec80cdfc2c4b37c803',
  hentai2Read: '053da85062184626a0a1ff6d57c3c955',
  youngAceUp: '9398095f450f4a1f9f0cc5c3ea145f0b',
  craftedFixture: 'aaaacccc111122223333444455556666',
} as const;
