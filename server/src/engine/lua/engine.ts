import type { HostLogger } from '@fmd/contract';
import type { LuaChunkSetup, LuaChunkCache, LuaEngine } from '../contract.js';
import { LuaFactory, type LuaEngine as WasmoonEngine } from 'wasmoon';
import { createIdleEnvironment, installBaseEnvironment, type EngineEnvironment } from './base-globals.js';
import { loadChunkInto } from './chunk-loader.js';
import type { WasmoonChunkCache } from './chunk-cache.js';
import { FacadeBridge } from './facade.js';

/**
 * One per-worker wasmoon engine (§5.12 topology): fresh state on module
 * switch (`LuaWebsiteModuleHandler.pas:33-54`), GC stepped every N calls
 * (`LuaHandler.pas:136-141`), base event environment late-bound so the
 * dispatcher can attach abort/deadline/logger without re-registering.
 */

export const GC_STEP_CALL_THRESHOLD = 15;

export class WasmoonLuaEngine implements LuaEngine {
  private inner: WasmoonEngine | null = null;
  private bridge: FacadeBridge | null = null;
  private callCount = 0;
  private stateGeneration = 0;

  /** Late-bound event environment (dispatcher swaps it in at creation). */
  env: EngineEnvironment;

  constructor(
    private readonly factory: LuaFactory,
    readonly chunkCache: WasmoonChunkCache,
    logger: HostLogger,
  ) {
    this.env = createIdleEnvironment(logger);
  }

  get callsSinceGc(): number {
    return this.callCount;
  }

  /** Bumped on every module switch (fresh state); used to key facade caches. */
  get generation(): number {
    return this.stateGeneration;
  }

  async loadModule(
    fileName: string,
    preChunkSetup?: LuaChunkSetup,
  ): Promise<void> {
    const chunk = this.chunkCache.peek(fileName);
    if (chunk === undefined) {
      throw new Error(`chunk not compiled: ${fileName} (call chunkCache.get first)`);
    }
    // module switch → fresh Lua state (LuaWebsiteModuleHandler.pas:33-54)
    this.disposeInner();
    const engine = await this.factory.createEngine();
    this.bridge = new FacadeBridge(engine);
    installBaseEnvironment(engine, this.bridge, () => this.env);
    // optional §5.7 shim wiring BEFORE the chunk runs (modules `require`
    // templates/utils at top level — LuaPackage.pas registers loaders first)
    preChunkSetup?.(engine, this.bridge);
    loadChunkInto(engine, chunk);
    this.inner = engine;
    this.callCount = 0;
    this.stateGeneration += 1;
  }

  /** The facade bridge of the live state (dispatcher binding). */
  get debugBridge(): FacadeBridge {
    if (this.bridge === null) {
      throw new Error('no module loaded (call loadModule first)');
    }
    return this.bridge;
  }

  /** lua_gc stepping (LuaHandler.pas:136-141): two LUA_GCCOLLECT passes. */
  gcCollect(): void {
    // wasmoon's wasm build does not export lua_gc; collectgarbage("collect")
    // is the same LUA_GCCOLLECT entry point from inside the state.
    this.inner?.doStringSync('collectgarbage("collect") collectgarbage("collect")');
    this.callCount = 0;
  }

  stepCalls(): void {
    this.callCount += 1;
  }

  /** The live wasmoon engine (dispatcher + tests). */
  get innerEngine(): WasmoonEngine {
    if (this.inner === null) {
      throw new Error('no module loaded (call loadModule first)');
    }
    return this.inner;
  }

  /**
   * Contract LuaEngine member: evaluate a Lua snippet in the live module
   * state (host-side read-backs). Same behavior as reaching through
   * `innerEngine` — including the throw when no module is loaded.
   */
  doStringSync(code: string): unknown {
    return this.innerEngine.doStringSync(code);
  }

  async dispose(): Promise<void> {
    this.disposeInner();
  }

  private disposeInner(): void {
    if (this.inner !== null) {
      this.inner.global.close();
      this.inner = null;
    }
    if (this.bridge !== null) {
      this.bridge.dispose();
      this.bridge = null;
    }
  }
}

export type { LuaChunkCache };
