import type { HostLogger } from '@fmd/contract';
import type { HttpAbortHandle } from '../contract.js';
import type { EventDeadlineController, EventDispatcher, LuaDispatcherShims, LuaEngine, LuaHost, LuaHostFactory } from '../contract.js';
import { LuaFactory } from 'wasmoon';
import { createContractDispatcher } from '../events/dispatcher.js';
import { WasmoonChunkCache } from './chunk-cache.js';
import { WasmoonLuaEngine } from './engine.js';
import { WasmoonModuleRegistry } from './init-pass.js';

/**
 * Typed Lua host (§5.12): compile-once chunk cache shared by every state,
 * Init-pass registry, per-worker engines, dispatcher factory (the §5.2
 * binding table lives with its only consumer in engine/events).
 *
 * The ONLY concrete LuaHost: constructed by the composition root (via
 * {@link WasmoonLuaHostFactory}) and injected as the contract LuaHost —
 * runtime/engine code never imports this class.
 */

export class WasmoonLuaHost implements LuaHost {
  readonly chunkCache: WasmoonChunkCache;
  readonly registry: WasmoonModuleRegistry;
  private readonly factory = new LuaFactory();

  constructor(readonly logger: HostLogger) {
    this.chunkCache = new WasmoonChunkCache(this.factory);
    this.registry = new WasmoonModuleRegistry(this.chunkCache, this.factory, logger);
  }

  async createEngine(logger?: HostLogger): Promise<WasmoonLuaEngine> {
    return new WasmoonLuaEngine(this.factory, this.chunkCache, logger ?? this.logger);
  }

  /**
   * Attach the §5.2 dispatcher (contract.json-driven) + watchdog to an
   * engine. `engine` is narrowed to the concrete class internally — safe
   * because engines are only obtainable from this host's `createEngine`.
   */
  createDispatcher(
    engine: LuaEngine,
    abort: HttpAbortHandle,
    deadline?: EventDeadlineController,
    shims?: LuaDispatcherShims,
  ): EventDispatcher {
    return createContractDispatcher(
      engine as WasmoonLuaEngine,
      abort,
      this.logger,
      deadline,
      undefined,
      undefined,
      shims,
    );
  }

  async dispose(): Promise<void> {
    // the chunk cache holds no long-lived state beyond the shared wasm
  }
}

/**
 * The wasmoon-backed LuaHostFactory (the composition root's injection
 * seam): runtime/engine code receives this as the contract interface —
 * test doubles substitute a fake factory without touching the runtime.
 */
export class WasmoonLuaHostFactory implements LuaHostFactory {
  createHost(logger: HostLogger): WasmoonLuaHost {
    return new WasmoonLuaHost(logger);
  }

  /** Isolated compile-only cache (own LuaFactory, never shares wasm state). */
  createChunkCache(): WasmoonChunkCache {
    return new WasmoonChunkCache(new LuaFactory());
  }
}

export function createLuaHostFactory(): LuaHostFactory {
  return new WasmoonLuaHostFactory();
}

export function createLuaHost(logger: HostLogger): WasmoonLuaHost {
  return new WasmoonLuaHost(logger);
}
