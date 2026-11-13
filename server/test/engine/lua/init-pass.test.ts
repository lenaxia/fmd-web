import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LuaModuleDescriptor } from '@fmd/contract';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';

/**
 * §5.1 Init pass over the seed module set: typed descriptors must match a
 * committed golden JSON (IDs, names, RootURLs, options incl. combobox
 * INDEX defaults). Regenerate with UPDATE_GOLDEN=1 after an intentional
 * change (offline; the .lua sources are the source of truth).
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(testDir, '..', 'golden', 'init-pass.golden.json');

function findFmd2LuaDir(): string {
  const fromEnv = process.env['FMD2_LUA_DIR'];
  if (fromEnv !== undefined && existsSync(fromEnv)) {
    return fromEnv;
  }
  let dir = dirname(testDir);
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

const FMD2_LUA_DIR = findFmd2LuaDir();

/** ≥10 real FMD2 modules, require-free, diverse Init bodies. */
const SEED_FILES: readonly string[] = [
  '11Toon.lua',
  '18Kami.lua',
  '8Muses.lua',
  'AsuraScans.lua',
  'Comicaso.lua',
  'Desu.lua',
  'DynastyScans.lua',
  'FlameComics.lua',
  'Hentai2Read.lua',
  'HentaiFox.lua',
  'InManga.lua',
  'Luscious.lua',
  'Manta.lua',
  'TCBScans.lua',
  'TuMangaOnline.lua',
  'YoungAceUp.lua',
];

const FIXTURE_FILES: readonly { name: string; content: string }[] = [
  { name: 'options-showcase.lua', content: readFixture('options-showcase.lua') },
  { name: 'multi-module.lua', content: readFixture('multi-module.lua') },
  { name: 'dropped-modules.lua', content: readFixture('dropped-modules.lua') },
];

function readFixture(name: string): string {
  return readFileSync(join(testDir, '..', 'fixtures', name), 'utf8');
}

interface GoldenEntry {
  readonly file: string;
  readonly modules: readonly LuaModuleDescriptor[];
}

async function runInitPass(): Promise<GoldenEntry[]> {
  const logger = createMemoryLogger();
  const host = createLuaHost(logger);
  try {
    const entries: GoldenEntry[] = [];
    for (const file of SEED_FILES) {
      const source = readFileSync(join(FMD2_LUA_DIR, 'modules', file), 'utf8');
      entries.push({ file, modules: await host.registry.loadFile(file, source) });
    }
    for (const fixture of FIXTURE_FILES) {
      entries.push({
        file: fixture.name,
        modules: await host.registry.loadFile(fixture.name, fixture.content),
      });
    }
    return entries;
  } finally {
    await host.dispose();
  }
}

describe('Init pass (§5.1) — seed module set vs golden JSON', () => {
  it('produces ≥10 typed descriptors with stable IDs/names/RootURLs/options', async () => {
    const entries = await runInitPass();
    const totalModules = entries.reduce((sum, e) => sum + e.modules.length, 0);
    expect(totalModules).toBeGreaterThanOrEqual(10);
    // every seed file registers exactly one module
    for (const entry of entries.filter((e) => !FIXTURE_FILES.some((f) => f.name === e.file))) {
      expect(entry.modules.length).toBe(1);
    }
    // fixtures prove multi-module + drop rules
    expect(entries.find((e) => e.file === 'multi-module.lua')?.modules.length).toBe(2);
    expect(entries.find((e) => e.file === 'dropped-modules.lua')?.modules.map((m) => m.name)).toEqual([
      'DropSurvivor',
    ]);
  });

  it('matches the committed golden JSON', async () => {
    const entries = await runInitPass();
    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(entries, null, 2)}\n`);
    }
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenEntry[];
    expect(entries).toEqual(golden);
  });

  it('descriptors carry the options API incl. combobox INDEX defaults', async () => {
    const entries = await runInitPass();
    const showcase = entries.find((e) => e.file === 'options-showcase.lua')?.modules[0];
    expect(showcase).toBeDefined();
    expect(showcase?.accountSupport).toBe(true);
    expect(showcase?.options).toEqual([
      { name: 'dark_mode', kind: 'checkbox', defaultValue: true },
      { name: 'session', kind: 'edit', defaultValue: 'abc123' },
      { name: 'concurrency', kind: 'spinedit', defaultValue: 3 },
      { name: 'quality', kind: 'combobox', defaultValue: 2, items: ['Low', 'Medium', 'High'] },
    ]);
    // real modules with options: Comicaso (edit), Manta (edit)
    const comicaso = entries.find((e) => e.file === 'Comicaso.lua')?.modules[0];
    expect(comicaso?.options).toEqual([{ name: 'session', kind: 'edit', defaultValue: '' }]);
  });

  it('unknown properties no-op silently and keys are case-sensitive (§5.1)', async () => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    try {
      const source = `
function Init()
  local m = NewWebsiteModule()
  m.ID = '9999aaaabbbbccccddddeeeeffff0000'
  m.Name = 'LuaClassSemantics'
  m.RootURL = 'https://luaclassexample.example'
  m.TypoProperty = 'dropped'      -- unknown set: silent no-op
  m.NAME = 'wrong-case-dropped'   -- case-sensitive keys
  local _unused = m.doesNotExist  -- unknown get: nil, no error
end
`;
      const modules = await host.registry.loadFile('luaclassemantics.lua', source);
      expect(modules.length).toBe(1);
      expect(modules[0]?.name).toBe('LuaClassSemantics');
      expect(logger.records.filter((r) => r.level === 'error').length).toBe(0);
    } finally {
      await host.dispose();
    }
  });

  it('attributes print() to the file scope and tolerates files without Init', async () => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    try {
      const noInit = await host.registry.loadFile('noinit.lua', 'local x = 1');
      expect(noInit.length).toBe(0);
      expect(logger.records.some((r) => r.message.includes('no function name "Init()"'))).toBe(true);

      const printer = await host.registry.loadFile(
        'printer.lua',
        `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'eeee0000111122223333444455556666'
  m.Name = 'Printer'
  print('hello', true, 42)
end
`,
      );
      expect(printer.length).toBe(1);
      const printRecord = logger.records.find((r) => r.message === 'hello\ttrue\t42');
      expect(printRecord).toBeDefined();
    } finally {
      await host.dispose();
    }
  });
});
