import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostLogger } from '@fmd/contract';
import { toStr } from '../lua/base-globals.js';
import { makeDuktapeShim } from './duktape-shim.js';
import { makePbShim } from './pb-shim.js';
import { installCryptoShim } from './crypto-shim.js';

/**
 * Lua-side `require` shim (DESIGN.md §5.7, `LuaPackage.pas`): host libs
 * for the `fmd.*` prefix (registered like `AddLib`), plain file chunks
 * from the synced lua/ tree for everything else (`utils.json` →
 * `lua/utils/json.lua`), standard `package.loaded` caching.
 * `fmd.crypto` installs through its own byte-exact base64 bridge
 * (`crypto-shim.ts`) via `package.preload`.
 */

export interface LuaRequireOptions {
  /** The synced lua/ tree root. */
  readonly luaRoot: string;
  /** fmd.env values (§5.7 fmd.env row). */
  readonly env?: {
    readonly version?: string;
    readonly revision?: string;
    readonly selectedLanguage?: string;
  };
  /** Per-module attribution for Duktape print/log routing. */
  readonly moduleId?: string;
  readonly logger?: HostLogger | null;
}

/** fmd.fileutil v0 subset (LuaFileUtil.pas:33-39 — pure helpers). */
export function makeFileUtilShim(): Record<string, (...args: unknown[]) => unknown> {
  return {
    ExtractFileName: (s: unknown) => toStr(s).replace(/^.*[/\\]/, ''),
    ExtractFileNameOnly: (s: unknown) => toStr(s).replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, ''),
  };
}

/**
 * The wasmoon engine surface the require shim needs.
 */
export interface RequireEngineLike {
  global: { set(name: string, value: unknown): void };
  doStringSync(code: string): unknown;
}

export function installRequireShim(engine: RequireEngineLike, options: LuaRequireOptions): void {
  const libs = new Map<string, unknown>();

  const envTable: Record<string, unknown> = {
    Directory: '',
    ExeName: 'fmd-web',
    Version: options.env?.version ?? '0.1.0',
    Revision: options.env?.revision ?? '0000',
    LuaDirectory: options.luaRoot,
    SelectedLanguage: options.env?.selectedLanguage ?? 'en',
  };
  libs.set('fmd.env', envTable);
  libs.set('fmd.duktape', makeDuktapeShim({ luaRoot: options.luaRoot, logger: options.logger ?? null, moduleId: options.moduleId ?? '' }));
  libs.set('fmd.fileutil', makeFileUtilShim());
  libs.set('pb', makePbShim());
  // fmd.crypto: byte-exact base64 bridge via package.preload (crypto-shim.ts).
  installCryptoShim(engine as Parameters<typeof installCryptoShim>[0]);

  // resolve one require name to its content:
  // - registered host lib (fmd.*, pb) → the lib table itself
  // - otherwise the lua tree file (`name.dots → path.lua`)
  engine.global.set('__fmd_get_lib', (name: unknown) => {
    const key = toStr(name);
    if (key === 'pb') {
      return libs.get('pb');
    }
    if (key.startsWith('fmd.')) {
      return libs.get(key);
    }
    return undefined;
  });
  engine.global.set('__fmd_read_file_chunk', (name: unknown) => {
    const key = toStr(name);
    if (key.startsWith('fmd.') || key === 'pb') {
      return undefined;
    }
    const rootAbs = resolve(options.luaRoot);
    const rel = key.replace(/\./g, '/');
    for (const candidate of [`${rel}.lua`, `${rel}/init.lua`]) {
      const full = resolve(rootAbs, candidate);
      if (full.startsWith(rootAbs)) {
        try {
          return readFileSync(full, 'utf8');
        } catch {
          // try the next candidate
        }
      }
    }
    return undefined;
  });

  // Lua glue: two searchers (host lib, file chunk) + preload['pb'].
  engine.doStringSync(`
    package = package or {}
    package.loaded = package.loaded or {}
    package.preload = package.preload or {}
    package.preload['pb'] = __fmd_get_lib('pb')
    function __fmd_lib_searcher(name)
      local lib = __fmd_get_lib(name)
      if lib == nil then return nil end
      return function() return lib end
    end
    function __fmd_file_searcher(name)
      local src = __fmd_read_file_chunk(name)
      if src == nil then return nil end
      local fn, err = load(src, '@' .. name:gsub('%.', '/') .. '.lua')
      if fn == nil then error(err, 0) end
      return fn
    end
    table.insert(package.searchers or package.loaders, 1, __fmd_file_searcher)
    table.insert(package.searchers or package.loaders, 1, __fmd_lib_searcher)
  `);
}
