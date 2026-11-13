import type { HostLogger, LuaModuleDescriptor, ModuleRegistry } from '@fmd/contract';
import { LuaFactory, type LuaEngine as WasmoonEngine } from 'wasmoon';
import { createIdleEnvironment, installBaseEnvironment } from './base-globals.js';
import { loadChunkBuffer } from './chunk-loader.js';
import type { WasmoonChunkCache } from './chunk-cache.js';
import { FacadeBridge } from './facade.js';
import { ModuleBacking } from './module-facade.js';

/**
 * Init pass (§5.1, `LuaWebsiteModules.pas:472-497` `DoInit` + `:523-533`):
 * per module file — fresh Lua state with the base globals, chunk from the
 * compile-once cache, `NewWebsiteModule()` available ONLY while `Init()`
 * runs, multi-module files supported, registrations missing `ID` or `Name`
 * dropped. The state is discarded afterwards, so `NewWebsiteModule` can
 * never leak into the event-call environment.
 */

export class WasmoonModuleRegistry implements ModuleRegistry {
  private readonly modulesList: LuaModuleDescriptor[] = [];

  constructor(
    private readonly chunkCache: WasmoonChunkCache,
    private readonly factory: LuaFactory,
    private readonly logger: HostLogger,
  ) {}

  get modules(): readonly LuaModuleDescriptor[] {
    return this.modulesList;
  }

  byId(id: string): LuaModuleDescriptor | undefined {
    return this.modulesList.find((m) => m.id === id);
  }

  async loadFile(
    fileName: string,
    source: string,
    extraSetup?: (engine: WasmoonEngine, bridge: FacadeBridge) => void,
  ): Promise<readonly LuaModuleDescriptor[]> {
    const chunk = await this.chunkCache.get(fileName, source);
    const engine = await this.factory.createEngine();
    const bridge = new FacadeBridge(engine);
    const env = createIdleEnvironment(this.logger);
    installBaseEnvironment(engine, bridge, () => env);
    // optional shim wiring (§5.7 require etc.) before the chunk runs
    extraSetup?.(engine, bridge);

    const pending: ModuleBacking[] = [];
    // NewWebsiteModule(): fresh registration + facade per call (:467-470)
    engine.global.set('__fmd_new_registration', () => {
      const backing = new ModuleBacking();
      pending.push(backing);
      const id = pending.length - 1;
      bridge.register(id, backing.spec(bridge));
      return id;
    });
    engine.doStringSync(`
      function NewWebsiteModule()
        return __fmd_facade_new(__fmd_new_registration(), '')
      end
    `);

    try {
      const loaded = loadChunkBuffer(engine.global.lua, engine.global.address, chunk);
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      // Init() must exist (:489-491)
      const init = callGlobal(engine, 'Init');
      if (!init.ok) {
        throw new Error(init.error);
      }
    } catch (error) {
      this.logger.write({
        level: 'error',
        moduleId: '',
        message: `LUA>DoInit("${fileName}")> ${errorMessage(error)}`,
      });
      return [];
    } finally {
      // NewWebsiteModule is available ONLY during Init()
      engine.doStringSync('NewWebsiteModule = nil');
      engine.global.close();
    }

    const descriptors: LuaModuleDescriptor[] = [];
    for (const backing of pending) {
      // drop registrations missing ID or Name (:523-533)
      if (backing.id === '' || backing.name === '') {
        continue;
      }
      descriptors.push(backing.toDescriptor(fileName));
    }
    this.modulesList.push(...descriptors);
    return descriptors;
  }
}

function callGlobal(engine: WasmoonEngine, name: string): { ok: true } | { ok: false; error: string } {
  const wasm = engine.global.lua;
  const state = engine.global.address;
  wasm.lua_getglobal(state, name);
  if (wasm.lua_type(state, -1) !== 6 /* LUA_TFUNCTION */) {
    wasm.lua_pop(state, 1);
    // FMD2 message shape: LuaWebsiteModules.pas:489-491
    return { ok: false, error: 'no function name "Init()"' };
  }
  const result = wasm.lua_pcallk(state, 0, 1, 0, 0, null);
  if (result !== 0) {
    const message = wasm.lua_tolstring(state, -1, null);
    wasm.lua_settop(state, 0);
    return { ok: false, error: `LuaCallFunction("${name}") ${message ?? String(result)}` };
  }
  wasm.lua_settop(state, 0);
  return { ok: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
