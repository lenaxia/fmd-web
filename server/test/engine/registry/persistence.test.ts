import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModuleSyncService } from '../../../src/engine/registry/module-sync.js';
import { InMemoryModuleRegistryPersistence } from '../../../src/engine/registry/persistence.js';
import { StartupRegistryService } from '../../../src/engine/registry/startup.js';
import { createLuaHostFactory } from '../../../src/engine/lua/host.js';
import { FMD2_LUA_ROOT } from '../../../src/engine/shims/install.js';

/**
 * module_state registry persistence (§9): restart → the SAME registry from
 * the persisted rows WITHOUT re-running the Init pass; a changed lua SHA
 * (edited tree / new sync) triggers a fresh sweep (re-Init). Each test
 * starts from an EMPTY store (a fresh app.db stand-in).
 */

const SEED_FILES = ['AsuraScans.lua', 'Comicaso.lua', 'EHentai.lua', 'HentaiFox.lua', 'Tapas.lua'] as const;

/** ModuleSyncService test double counting sweeps (the re-Init detector). */
class CountingSync extends ModuleSyncService {
  sweepCount = 0;
  override async sweep() {
    this.sweepCount += 1;
    return super.sweep();
  }
}

describe('startup registry — SHA-gated persistence', () => {
  let modulesDir: string;

  beforeAll(() => {
    modulesDir = mkdtempSync(join(tmpdir(), 'fmd-registry-persist-'));
    for (const file of SEED_FILES) {
      cpSync(join(FMD2_LUA_ROOT, 'modules', file), join(modulesDir, file));
    }
  });

  afterAll(() => {
    rmSync(modulesDir, { recursive: true, force: true });
  });

  function makeSync(): CountingSync {
    return new CountingSync({ luaRoot: FMD2_LUA_ROOT, modulesDir, hostFactory: createLuaHostFactory() });
  }

  it('first boot sweeps and persists id/name/root_url/category/options/file/capabilities rows', async () => {
    const store = new InMemoryModuleRegistryPersistence();
    const first = makeSync();
    const registry = new StartupRegistryService(first, store);
    const boot = await registry.boot();

    expect(boot.source).toBe('sweep');
    expect(first.sweepCount).toBe(1);
    expect(store.size).toBeGreaterThanOrEqual(SEED_FILES.length + 1); // EHentai = 2 modules
    expect(store.sha).toBe(boot.treeSha);
    for (const row of Object.values(store.loadAll().rows)) {
      expect(row.id.length).toBeGreaterThan(0); // FMD2 enforces nothing on the ID string
      expect(row.name).not.toBe('');
      expect(row.file).not.toBe('');
      expect(typeof row.rootURL).toBe('string');
      expect(typeof row.category).toBe('string');
      expect(Array.isArray(row.options)).toBe(true);
      expect(row.capabilities.requires_subprocess).toBeTypeOf('boolean');
      expect(Array.isArray(row.capabilities.events)).toBe(true);
    }
  });

  it('restart over the same store: same registry, NO re-Init (cache)', async () => {
    const store = new InMemoryModuleRegistryPersistence();
    const registryA = new StartupRegistryService(makeSync(), store);
    const bootA = await registryA.boot();
    expect(bootA.source).toBe('sweep');

    // a fresh service over the SAME persistence = the restarted process
    const restarted = makeSync();
    expect(restarted.sweepCount).toBe(0);
    const registryB = new StartupRegistryService(restarted, store);
    const bootB = await registryB.boot();
    expect(bootB.source).toBe('cache');
    expect(restarted.sweepCount).toBe(0); // the Init pass never re-ran
    expect(bootB.treeSha).toBe(bootA.treeSha);
    expect(bootB.modules).toEqual(bootA.modules);
    expect(registryB.modules).toEqual(registryA.modules);
    expect(registryB.byId(bootA.modules[0]?.id ?? '')).toEqual(bootA.modules[0]);
    expect(registryB.knownBroken()).toEqual(registryA.knownBroken());
  });

  it('boot is memoized per service instance (no repeated sweep)', async () => {
    const store = new InMemoryModuleRegistryPersistence();
    const sync = makeSync();
    const registry = new StartupRegistryService(sync, store);
    const first = await registry.boot();
    const second = await registry.boot();
    expect(first).toBe(second);
    expect(sync.sweepCount).toBe(1);
  });

  it('a changed lua SHA triggers a fresh sweep (re-Init) and replaces the rows', async () => {
    const store = new InMemoryModuleRegistryPersistence();
    const registryA = new StartupRegistryService(makeSync(), store);
    const cached = await registryA.boot();
    expect(cached.source).toBe('sweep');

    // "new lua/ sync landed": edit one module file → tree SHA changes
    const edited = join(modulesDir, 'HentaiFox.lua');
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n-- sync touch: new revision\n`);

    const registryB = new StartupRegistryService(makeSync(), store);
    const fresh = await registryB.boot();
    expect(fresh.source).toBe('sweep');
    expect(fresh.treeSha).not.toBe(cached.treeSha);
    expect(store.sha).toBe(fresh.treeSha);
    // registry content survives the re-Init (a comment-only change)
    expect(fresh.modules.map((m) => m.id).sort()).toEqual(cached.modules.map((m) => m.id).sort());

    // and a THIRD boot over the untouched tree caches again
    const registryC = new StartupRegistryService(makeSync(), store);
    expect((await registryC.boot()).source).toBe('cache');
  });
});
