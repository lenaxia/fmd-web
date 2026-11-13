import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { createContractDispatcher, type DispatcherShims } from '../../../src/engine/events/dispatcher.js';
import {
  installShims,
  initShimsHook,
  loadRealModuleFile,
  FMD2_LUA_ROOT,
} from '../../../src/engine/shims/install.js';
import { RecordedResponseResolver, type RecordedResponse } from '../../../src/engine/shims/http-shim.js';
import type { EventContext, EventDispatchResult, LuaModuleDescriptor } from '@fmd/contract';
import type { MemoryLogger } from '../../../src/engine/lua/logger.js';
import type { WasmoonLuaEngine } from '../../../src/engine/lua/engine.js';
import { makeMangaInfoSpec } from '../../../src/engine/lua/mangainfo.js';
import type { WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { readFileSync } from 'node:fs';

/**
 * Offline E2E harness (Phase-0 seed flows): real FMD2 module files run
 * through the wasmoon host with the §5.4/§5.6/§5.7 v0 shims — every HTTP
 * response resolved from recorded fixtures (NO live network), TXQuery on
 * FontoXPath + linkedom, Duktape on node:vm, pb on protobufjs.
 */

export interface HarnessSession {
  readonly host: WasmoonLuaHost;
  readonly engine: WasmoonLuaEngine;
  readonly logger: MemoryLogger;
  readonly resolver: RecordedResponseResolver;
  readonly descriptor: LuaModuleDescriptor;
  readonly dispatch: (event: string, context?: EventContext) => EventDispatchResult;
  readonly runLua: (code: string) => unknown;
  /** Bind a fresh HTTP facade global (probe/testing use). */
  readonly bindHTTP: () => void;
  /** Bind a fresh MANGAINFO facade global (probe/testing use). */
  readonly bindMangaInfo: () => void;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /** Module file relative to the lua root, e.g. `modules/Hentai2Read.lua`. */
  readonly moduleFile: string;
  readonly responses: readonly RecordedResponse[];
  /** Prefer the module whose ID matches (multi-module files: EHentai). */
  readonly pickModule?: (descriptors: readonly LuaModuleDescriptor[]) => LuaModuleDescriptor;
  readonly shims?: DispatcherShims;
  readonly luaRoot?: string;
  /** Module id attributed to shim logs (descriptor id once known). */
  readonly envSelectedLanguage?: string;
}

export async function openSession(options: HarnessOptions): Promise<HarnessSession> {
  const logger = createMemoryLogger();
  const host = createLuaHost(logger);
  const luaRoot = options.luaRoot ?? FMD2_LUA_ROOT;
  const abort = new DeadlineAbortHandle(createDeadlineCells());
  const resolver = new RecordedResponseResolver([...options.responses]);

  const hook = initShimsHook({
    resolver,
    abort,
    logger,
    moduleId: options.moduleFile,
    ...(options.envSelectedLanguage !== undefined
      ? { env: { selectedLanguage: options.envSelectedLanguage } }
      : {}),
    ...(options.luaRoot !== undefined ? { luaRoot: options.luaRoot } : {}),
  });
  const descriptors = await loadRealModuleFile(host, luaRoot, options.moduleFile, hook);
  if (descriptors.length === 0) {
    const initLog = logger.records.map((r) => r.message).join('\n');
    throw new Error(`Init pass produced no module for ${options.moduleFile}:\n${initLog}`);
  }
  const descriptor =
    options.pickModule !== undefined
      ? options.pickModule(descriptors)
      : descriptors[0];
  if (descriptor === undefined) {
    throw new Error(`no module descriptor for ${options.moduleFile}`);
  }

  const engine = await host.createEngine();
  let installed: ReturnType<typeof installShims> | undefined;
  await engine.loadModule(options.moduleFile, (inner, bridge) => {
    // shims must exist BEFORE the chunk runs: site modules `require`
    // templates/utils at chunk top level (LuaPackage.pas loader order)
    installed = installShims(inner, bridge, {
      resolver,
      abort,
      logger,
      moduleId: descriptor.id,
      luaRoot,
    });
  });
  const shimKit = installed;
  if (shimKit === undefined) {
    throw new Error('shim install did not run');
  }
  const bridge = engine.debugBridge;

  const dispatcher = createContractDispatcher(engine, abort, logger, undefined, undefined, undefined, {
    makeHTTP: shimKit.makeHTTP,
    ...(options.shims?.account !== undefined ? { account: options.shims.account } : {}),
  });

  return {
    host,
    engine,
    logger,
    resolver,
    descriptor,
    dispatch: (event, context) => dispatcher.dispatch(descriptor, event, context),
    runLua: (code: string) => engine.innerEngine.doStringSync(code),
    bindHTTP: () => {
      bridge.create('HTTP', shimKit.makeHTTP());
    },
    bindMangaInfo: () => {
      bridge.create('MANGAINFO', makeMangaInfoSpec(bridge).spec);
    },
    async dispose(): Promise<void> {
      await engine.dispose();
      await host.dispose();
    },
  };
}

/** Read a corpus seed fixture body (never the network). */
export function readSeedFixture(...path: string[]): string {
  return readFileSync(`/workspace/fmd-web/corpus/fixtures/seed/${path.join('/')}`, 'utf8');
}
