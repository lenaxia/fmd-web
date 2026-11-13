import type { EventDeadlineController, EventDispatcher, HostLogger, HttpAbortHandle, LuaHost } from '@fmd/contract';
import { LuaFactory } from 'wasmoon';
import { createContractDispatcher } from '../events/dispatcher.js';
import { WasmoonChunkCache } from './chunk-cache.js';
import { WasmoonLuaEngine } from './engine.js';
import { WasmoonModuleRegistry } from './init-pass.js';

/**
 * Typed Lua host (§5.12): compile-once chunk cache shared by every state,
 * Init-pass registry, per-worker engines, dispatcher factory (the §5.2
 * binding table lives with its only consumer in engine/events).
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

  /** Attach the §5.2 dispatcher (contract.json-driven) + watchdog to an engine. */
  createDispatcher(
    engine: WasmoonLuaEngine,
    abort: HttpAbortHandle,
    deadline?: EventDeadlineController,
  ): EventDispatcher {
    return createContractDispatcher(engine, abort, this.logger, deadline);
  }

  async dispose(): Promise<void> {
    // the chunk cache holds no long-lived state beyond the shared wasm
  }
}

export function createLuaHost(logger: HostLogger): WasmoonLuaHost {
  return new WasmoonLuaHost(logger);
}
