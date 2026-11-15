import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostLogger } from '@fmd/contract';
import { toStr } from '../lua/base-globals.js';
import { makeDuktapeShim } from './duktape-shim.js';
import { installPbShim } from './pb-shim.js';
import { installCryptoShim } from './crypto-shim.js';
import { installGzipShim } from './gzip-shim.js';
import { installImagePuzzleShim } from './imagepuzzle-shim.js';
import { makeMangaFoxWatermarkShim } from './mangafoxwatermark-shim.js';
import type { HttpDocument } from './http-pipeline.js';
import { makeLoggerShim } from './logger-shim.js';
import { makePcre2Shim } from './pcre2-shim.js';
import { makeSubprocessShim } from '../sidecar/subprocess-stub.js';
import { REQUIRE_SHIM_REGISTRY } from './require-registry.js';
import type { BypassExecutorPort } from '../sidecar/bypass-adapter.js';

export { REQUIRE_SHIM_REGISTRY };

/**
 * Lua-side `require` shim (DESIGN.md §5.7, `LuaPackage.pas`): host libs
 * for the `fmd.*` prefix (registered like `AddLib`), plain file chunks
 * from the synced lua/ tree for everything else (`utils.json` →
 * `lua/utils/json.lua`), standard `package.loaded` caching.
 * `fmd.crypto` and `fmd.gzip` (binary compressed bodies) install through
 * their own byte-exact base64 bridges (`crypto-shim.ts` / `gzip-shim.ts`)
 * via `package.preload`.
 *
 * Host-lib registration is DRIVEN by `REQUIRE_SHIM_REGISTRY`
 * (require-registry.ts) — the single source of truth the CI drift check
 * holds contract.json's `requireShims[].status` against.
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
  /**
   * §5.11 browser sidecar adapter: present → `fmd.subprocess` routes
   * RunCommandHide to it; absent → the denied stub (RunCommand* → nil).
   */
  readonly bypass?: BypassExecutorPort;
  /**
   * FMD2 EncryptString key injected into the fmd.crypto bridge (the
   * hardcoded uBaseUnit constant lives ONLY in the migration module
   * `tools/import/fmd2-crypto.ts`; `install.ts` wires it here). Unset →
   * EncryptString/DecryptString return '' (unwired).
   */
  readonly fmd2CryptoKey?: string;
  /**
   * Facade id → backing HTTP document stream (install.ts's documents
   * map) — the fmd.imagepuzzle DeScramble resolves its two TStream
   * arguments through the facade `__fmd_id` marker (LuaImagePuzzle.pas
   * luaToUserData stream arguments; HTTP.Document in module code).
   * Absent (bare-registry installs) → unresolvable streams exit
   * silently (ImagePuzzle.pas:159-162 Assigned guard).
   */
  readonly documents?: Map<number, HttpDocument>;
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

/**
 * Table factories for every registry row the loader serves as a host
 * lib / preload table (keyed by the registry `require` name). Each
 * factory reproduces the exact registration call it replaces.
 */
const hostLibFactories: Readonly<Record<string, (options: LuaRequireOptions) => unknown>> = {
  'fmd.env': (options) => ({
    Directory: '',
    ExeName: 'fmd-web',
    Version: options.env?.version ?? '0.1.0',
    Revision: options.env?.revision ?? '0000',
    // LuaFMD.pas:24 binds LUA_REPO_FOLDER (FMDOptions.pas:297: FMD_DIRECTORY
    // + 'lua' + PathDelim) — the trailing delimiter is part of the surface:
    // FanFox.lua:36 concatenates 'extras\\mangafoxtemplate' onto it.
    LuaDirectory: `${options.luaRoot}/`,
    SelectedLanguage: options.env?.selectedLanguage ?? 'en',
  }),
  'fmd.duktape': (options) =>
    makeDuktapeShim({
      luaRoot: options.luaRoot,
      logger: options.logger ?? null,
      moduleId: options.moduleId ?? '',
    }),
  'fmd.fileutil': () => makeFileUtilShim(),
  // fmd.mangafoxwatermark (LuaMangaFox.pas:41-52 lib registration): plain
  // function table — LoadTemplate/RemoveWatermark marshal as scalars.
  'fmd.mangafoxwatermark': (options) =>
    makeMangaFoxWatermarkShim({
      luaRoot: options.luaRoot,
      logger: options.logger ?? null,
      moduleId: options.moduleId ?? '',
    }),
  'fmd.logger': (options) =>
    makeLoggerShim({
      ...(options.logger !== null && options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.moduleId !== undefined ? { moduleId: options.moduleId } : {}),
    }),
  'fmd.pcre2': (options) =>
    makePcre2Shim({
      ...(options.logger !== null && options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.moduleId !== undefined ? { moduleId: options.moduleId } : {}),
    }),
  subprocess: (options) =>
    makeSubprocessShim({
      ...(options.bypass !== undefined ? { bypass: options.bypass } : {}),
      logger: options.logger ?? null,
      moduleId: options.moduleId ?? '',
    }),
};

export function installRequireShim(engine: RequireEngineLike, options: LuaRequireOptions): void {
  const libs = new Map<string, unknown>();

  // §5.7 registry rows → host libs / preload tables. Every host-lib row
  // in REQUIRE_SHIM_REGISTRY must have a factory here; package-preload
  // rows (fmd.crypto, fmd.gzip, pb) are skipped — they install through
  // their own engine-bound bridges below (base64 byte-exact, see
  // crypto-shim.ts / gzip-shim.ts / pb-shim.ts); a missing host-lib
  // factory is a registry/factory inconsistency and fails loud at
  // install time.
  for (const entry of REQUIRE_SHIM_REGISTRY) {
    if (entry.loaderKey === null || entry.servedBy === 'package-preload') {
      continue;
    }
    const factory = hostLibFactories[entry.require];
    if (factory === undefined) {
      throw new Error(
        `require-shim registry row "${entry.require}" (loaderKey ${entry.loaderKey}) has no host-lib factory`,
      );
    }
    libs.set(entry.loaderKey, factory(options));
  }
  // fmd.crypto (registry row: package-preload): byte-exact base64
  // bridge via package.preload (crypto-shim.ts).
  installCryptoShim(engine as Parameters<typeof installCryptoShim>[0], {
    ...(options.fmd2CryptoKey !== undefined ? { encryptKey: options.fmd2CryptoKey } : {}),
  });
  // fmd.gzip (registry row: package-preload): byte-exact base64 bridge
  // via package.preload — Inflate's compressed bodies are binary
  // (Happymh.lua `plain:sub(5)`), text marshalling would corrupt them
  // (gzip-shim.ts).
  installGzipShim(engine as Parameters<typeof installGzipShim>[0], {
    logger: options.logger ?? null,
    moduleId: options.moduleId ?? '',
  });
  // pb (registry row: package-preload): byte-exact base64 bridge +
  // two-value pb.load (lua-protobuf contract — pb-shim.ts).
  installPbShim(engine as Parameters<typeof installPbShim>[0]);
  // fmd.imagepuzzle (registry row: package-preload): Lua-object preload +
  // the DeScramble host function; streams resolve through the documents
  // map (ImagePuzzle.pas luaToUserData TStream arguments).
  installImagePuzzleShim(engine as Parameters<typeof installImagePuzzleShim>[0], {
    ...(options.documents !== undefined ? { documents: options.documents } : {}),
    logger: options.logger ?? null,
    moduleId: options.moduleId ?? '',
  });

  // resolve one require name to its content:
  // - registered host lib (fmd.*) → the lib table itself
  //   (`pb` resolves through package.preload['pb'] before searchers run)
  // - otherwise the lua tree file (`name.dots → path.lua`)
  engine.global.set('__fmd_get_lib', (name: unknown) => {
    const key = toStr(name);
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

  // Lua glue: two searchers (host lib, file chunk). `pb` is served by
  // installPbShim's package.preload above (checked by require() before
  // the searchers run).
  engine.doStringSync(`
    package = package or {}
    package.loaded = package.loaded or {}
    package.preload = package.preload or {}
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
