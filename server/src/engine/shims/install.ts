import type { HostLogger, ModuleId } from '@fmd/contract';
import type { HttpAbortHandle } from '../contract.js';
import type { LuaChunkSetup, LuaFacadeBridge, LuaFacadeSpec, LuaHost, LuaModuleDescriptor, LuaStateSurface } from '../contract.js';
import { readFileSync } from 'node:fs';
import { parseQueryDocument, type DuckDocument, type SwallowSharedDeduper } from './txquery-shim.js';
import { TxQueryShim } from './txquery-facade.js';
import {
  makeHttpShim,
  type CookieJarPort,
  type EgressPolicy,
  type HttpDocument,
  type HostGatePort,
  type HttpTransportPort,
  type RecordedResponseResolver,
} from './http-shim.js';
import type { ProxyConfig } from './http-proxy.js';
import type { BypassExecutorPort } from '../sidecar/bypass-adapter.js';
import { installRequireShim } from './lua-require.js';
// The ONE sanctioned src-side import of the migration module (D4): it
// supplies the FMD2 EncryptString key to the fmd.crypto Lua surface
// (LuaCrypto.pas parity). The eslint `no-restricted-imports` boundary
// whitelists exactly this file + the import CLI + tests; native storage
// never touches the key (see fmd2-crypto.ts module doc).
import { FMD2_ENCRYPT_KEY } from '../../tools/import/fmd2-crypto.js';

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
  /** §5.3 shared cookie jar port (cookie persistence across objects). */
  readonly sharedCookies?: CookieJarPort;
  /** Per-host connection gate (limits + host-level delays). */
  readonly gate?: HostGatePort;
  /** Egress policy (default: deny RFC1918/link-local). */
  readonly egress?: EgressPolicy;
  /** Transport override (default: recorded fixtures; loopback for integration tests). */
  readonly transport?: HttpTransportPort;
  /** Filesystem jail root for Document LoadFromFile/SaveToFile (§5.4). */
  readonly fsJail?: string;
  /**
   * Settings-provided default proxy for THIS module (the per-module
   * override, else the global config — §9/§10 settings): exact SetProxy
   * field semantics; a module's own SetProxy call overrides at runtime.
   */
  readonly initialProxy?: ProxyConfig;
  /**
   * §5.11 browser sidecar adapter: when present the `fmd.subprocess`
   * stub routes RunCommandHide to it (bounded concurrency 2, 60 s
   * timeout, health-gated); without it the denied stub stands (§5.7).
   */
  readonly bypass?: BypassExecutorPort;
  /**
   * §5.6 run-level expression-failure dedup (observability): shared
   * across every engine this process creates, so the max-1-WARN bound
   * per (module, expression-template) holds for the whole run and the
   * suppressed counters feed the metrics endpoint.
   */
  readonly swallowDeduper?: SwallowSharedDeduper;
  /**
   * FMD2 EncryptString key for the fmd.crypto Lua surface (LuaCrypto.pas
   * calls uBaseUnit's hardcoded-key EncryptString). Defaults to
   * `FMD2_ENCRYPT_KEY` — the migration module is the ONLY holder of the
   * literal (D4 isolation; see fmd2-crypto.ts module doc). Override for
   * tests that need the shim unwired.
   */
  readonly fmd2CryptoKey?: string;
}

export interface InstalledShims {
  readonly txquery: TxQueryShim;
  /** Bind a fresh request-scoped HTTP object (dispatcher HTTP factory). */
  readonly makeHTTP: () => LuaFacadeSpec;
  /** HTTP Document facade id → backing stream (ParseHTML resolution). */
  readonly documents: Map<number, HttpDocument>;
}

/**
 * The engine surface the installer needs — the contract's structural
 * LuaStateSurface (wasmoon's engine and test doubles both satisfy it).
 */
type EngineLike = LuaStateSurface;

/**
 * Install the v0 shims on an engine with base globals present (the
 * CreateTXQuery stub is replaced). Re-runs are idempotent per engine.
 */
export function installShims(
  engine: EngineLike,
  bridge: LuaFacadeBridge,
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
    ...(options.swallowDeduper !== undefined ? { swallowDeduper: options.swallowDeduper } : {}),
  });

  installRequireShim(engine, {
    luaRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
    moduleId: options.moduleId,
    logger: options.logger,
    fmd2CryptoKey: options.fmd2CryptoKey ?? FMD2_ENCRYPT_KEY,
    // fmd.imagepuzzle DeScramble resolves its TStream arguments (the
    // HTTP.Document facades) through this map (facade __fmd_id marker).
    documents,
    // §5.11 browser sidecar adapter → the fmd.subprocess stub routes
    // RunCommandHide to it (absent = denied stub, §5.10 known-broken)
    ...(options.bypass !== undefined ? { bypass: options.bypass } : {}),
  });

  const makeHTTP = (): LuaFacadeSpec =>
    makeHttpShim(bridge, {
      resolver: options.resolver,
      abort: options.abort,
      documents,
      ...(options.sharedCookies !== undefined ? { sharedCookies: options.sharedCookies } : {}),
      ...(options.gate !== undefined ? { gate: options.gate } : {}),
      ...(options.egress !== undefined ? { egress: options.egress } : {}),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(options.fsJail !== undefined ? { fsJail: options.fsJail } : {}),
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
): LuaChunkSetup {
  return (engine, bridge) => {
    installShims(engine, bridge, options);
  };
}

/** Read + compile a real module file, running its Init() pass. */
export async function loadRealModuleFile(
  host: LuaHost,
  luaRoot: string,
  relativeFile: string,
  extraSetup?: LuaChunkSetup,
): Promise<readonly LuaModuleDescriptor[]> {
  const source = readFileSync(`${luaRoot}/${relativeFile}`, 'utf8');
  await host.chunkCache.get(relativeFile, source);
  return host.registry.loadFile(relativeFile, source, extraSetup);
}
