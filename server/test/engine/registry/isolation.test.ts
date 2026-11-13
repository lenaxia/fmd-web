import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModuleSyncService } from '../../../src/engine/registry/module-sync.js';
import { FMD2_LUA_ROOT } from '../../../src/engine/shims/install.js';

/**
 * Per-file error isolation (the acceptance-criteria corrupted-file proof):
 * a deliberately corrupted module file must be captured per file and must
 * NOT break the sweep — every other file still registers. Four corruption
 * classes: Lua syntax error, Init() throwing, a require of a missing
 * library, and a registration dropped for missing ID/Name.
 */

const GOOD_FILES = ['AsuraScans.lua', 'Comicaso.lua', 'HentaiFox.lua', 'YoungAceUp.lua'] as const;

const CORRUPTED_FILES: readonly { readonly file: string; readonly content: string; readonly errorPattern: RegExp }[] = [
  {
    file: 'zz-broken-syntax.lua',
    content: 'function Init(\n  local m = NewWebsiteModule()\n',
    errorPattern: /syntax|unexpected|near/,
  },
  {
    file: 'zz-throwing-init.lua',
    content: `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'aaaa0000111122223333444455556666'
  m.Name = 'ThrowingInit'
  error('deliberate init boom')
end
`,
    errorPattern: /deliberate init boom/,
  },
  {
    file: 'zz-bad-require.lua',
    content: `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'bbbb0000111122223333444455556666'
  m.Name = 'BadRequire'
  require 'utils.definitely-missing-library'
end
`,
    errorPattern: /definitely-missing-library|not found|no field|error/,
  },
  {
    file: 'zz-no-id.lua',
    content: `
function Init()
  local m = NewWebsiteModule()
  m.Name = 'NoIdDropped'
end
`,
    errorPattern: /registered no module|Init/,
  },
];

describe('corrupted-file isolation', () => {
  let modulesDir: string;
  let sync: ModuleSyncService;

  beforeAll(() => {
    modulesDir = mkdtempSync(join(tmpdir(), 'fmd-registry-isolation-'));
    // 4 real, known-good module files + 4 corrupted ones
    for (const file of GOOD_FILES) {
      cpSync(join(FMD2_LUA_ROOT, 'modules', file), join(modulesDir, file));
    }
    for (const bad of CORRUPTED_FILES) {
      writeFileSync(join(modulesDir, bad.file), bad.content);
    }
    sync = new ModuleSyncService({ luaRoot: FMD2_LUA_ROOT, modulesDir });
  });

  afterAll(() => {
    rmSync(modulesDir, { recursive: true, force: true });
  });

  it('every good file registers despite the corrupted siblings', async () => {
    const result = await sync.sweep();
    expect(result.summary.totalFiles).toBe(GOOD_FILES.length + CORRUPTED_FILES.length);
    for (const file of GOOD_FILES) {
      const entry = result.files.find((f) => f.file === file);
      expect(entry?.ok, file).toBe(true);
      expect(entry?.registrations.length, file).toBeGreaterThanOrEqual(1);
    }
  });

  it('each corrupted file is captured individually with its own error', async () => {
    const result = await sync.sweep();
    expect(result.summary.failedFiles).toBe(CORRUPTED_FILES.length);
    for (const bad of CORRUPTED_FILES) {
      const entry = result.files.find((f) => f.file === bad.file);
      expect(entry?.ok, bad.file).toBe(false);
      expect(entry?.registrations.length, bad.file).toBe(0);
      expect(entry?.error ?? '', bad.file).toMatch(bad.errorPattern);
    }
    expect(result.summary.failures.map((f) => f.file).sort()).toEqual(
      CORRUPTED_FILES.map((b) => b.file).sort(),
    );
  });

  it('the sweep itself never throws and returns a consistent summary', async () => {
    const result = await sync.sweep();
    expect(result.summary.registeredFiles).toBe(GOOD_FILES.length);
    expect(result.summary.registeredFiles + result.summary.failedFiles).toBe(result.summary.totalFiles);
    expect(result.registrations.length).toBe(
      result.files.reduce((sum, f) => sum + f.registrations.length, 0),
    );
  });
});
