import type { HostLogger, HttpAbortHandle, LuaModuleDescriptor, ModuleId } from '@fmd/contract';
import type { FacadeBridge, FacadeSpec } from '../lua/facade.js';
import type { WasmoonLuaHost } from '../lua/host.js';
import { readFileSync } from 'node:fs';
import type { LuaEngine as WasmoonEngine } from 'wasmoon';
import { parseQueryDocument, type DuckDocument } from './txquery-shim.js';
import { TxQueryShim } from './txquery-facade.js';
import { makeHttpShim, type HttpDocument, type RecordedResponseResolver } from './http-shim.js';
import { installRequireShim } from './lua-require.js';

/**
 * v0 shim installer (DESIGN.md §5.4/§5.6/§5.7): wires the real offline
 * shims into a fresh wasmoon engine — HTTP (recorded resolver), TXQuery
 * (FontoXPath + linkedom), the Lua require machinery (fmd.* libs + lua
 * tree file chunks + `package.preload['pb']`) — replacing the inert
 * §5.1 stubs. The dispatcher binds a fresh HTTP object per event call
 * through `makeHTTP`.
 */

export const FMD2_LUA_ROOT = '/workspace/FMD2/lua';

export interface InstallShimsOptions {
  readonly luaRoot?: string;
  readonly resolver: RecordedResponseResolver;
  readonly abort: HttpAbortHandle;
  readonly logger: HostLogger;
  readonly moduleId: ModuleId;
  readonly env?: {
    readonly version?: string;
    readonly revision?: string;
    readonly selectedLanguage?: string;
  };
}

export interface InstalledShims {
  readonly txquery: TxQueryShim;
  /** Bind a fresh request-scoped HTTP object (dispatcher HTTP factory). */
  readonly makeHTTP: () => FacadeSpec;
  /** HTTP Document facade id → backing stream (ParseHTML resolution). */
  readonly documents: Map<number, HttpDocument>;
}

/** The engine surface the installer needs (wasmoon LuaEngine). */
interface EngineLike {
  global: { set(name: string, value: unknown): void };
  doStringSync(code: string): unknown;
}

/**
 * Install the v0 shims on an engine with base globals present (the
 * CreateTXQuery stub is replaced). Re-runs are idempotent per engine.
 */
export function installShims(
  engine: EngineLike,
  bridge: FacadeBridge,
  options: InstallShimsOptions,
): InstalledShims {
  const luaRoot = options.luaRoot ?? FMD2_LUA_ROOT;
  const documents = new Map<number, HttpDocument>();

  // Facade identity marker (additive, no facade.ts edit): wrap
  // __fmd_facade_new so every facade table carries a rawset `__fmd_id`.
  // Lets shims resolve facade arguments (IXQValue state, HTTP document
  // streams) when a table crosses the bridge as a plain JS copy.
  engine.doStringSync(`
    local real_facade_new = __fmd_facade_new
    function __fmd_facade_new(id, target)
      local t = real_facade_new(id, target)
      if rawget(t, '__fmd_id') == nil then rawset(t, '__fmd_id', id) end
      return t
    end
  `);

  const txquery = new TxQueryShim({
    bridge,
    engine,
    logger: options.logger,
    moduleId: options.moduleId,
    documents,
  });

  installRequireShim(engine, {
    luaRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
    moduleId: options.moduleId,
    logger: options.logger,
  });

  const makeHTTP = (): FacadeSpec =>
    makeHttpShim(bridge, {
      resolver: options.resolver,
      abort: options.abort,
      documents,
    }).spec;

  // CreateTXQuery: HTTP.Document facade | HTML string | none
  // (LuaXQuery.pas:209-212)
  engine.global.set('__fmd_new_txquery', (arg?: unknown) => {
    let doc: DuckDocument;
    if (typeof arg === 'string') {
      doc = parseQueryDocument('html', arg);
    } else if (arg !== undefined && arg !== null && typeof arg === 'object') {
      const marker = (arg as Record<string, unknown>)['__fmd_id'];
      const state = typeof marker === 'number' ? documents.get(marker) : undefined;
      doc = parseQueryDocument('html', state?.toString() ?? '');
    } else {
      doc = parseQueryDocument('html', '');
    }
    return txquery.createTxQuery(doc);
  });
  engine.doStringSync(
    `function CreateTXQuery(_document_or_html)
       -- createTxQuery already materialized the facade table (and wired
       -- the Lua-side method closures); resolve it — a second
       -- __fmd_facade_new would clobber the wired slots
       return __fmd_facades[__fmd_new_txquery(_document_or_html)]
     end`,
  );

  return {
    txquery,
    makeHTTP,
    documents,
  };
}

/**
 * Init-pass hook factory: installs the require shim (+ real TXQuery) on
 * the Init engine so module Init() bodies can `require 'fmd.env'` etc.
 */
export function initShimsHook(
  options: InstallShimsOptions,
): (engine: WasmoonEngine, bridge: FacadeBridge) => void {
  return (engine, bridge) => {
    installShims(engine, bridge, options);
  };
}

/** Read + compile a real module file, running its Init() pass. */
export async function loadRealModuleFile(
  host: WasmoonLuaHost,
  luaRoot: string,
  relativeFile: string,
  extraSetup?: (engine: WasmoonEngine, bridge: FacadeBridge) => void,
): Promise<readonly LuaModuleDescriptor[]> {
  const source = readFileSync(`${luaRoot}/${relativeFile}`, 'utf8');
  await host.chunkCache.get(relativeFile, source);
  return host.registry.loadFile(relativeFile, source, extraSetup);
}
