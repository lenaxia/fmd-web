import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import vm from 'node:vm';
import type { HostLogger, ModuleId } from '@fmd/contract';

/**
 * Duktape shim v0 (DESIGN.md §5.7, `LuaDuktape.pas` + `Duktape.pas`):
 * one method, `ExecJS(js)`, on `require 'fmd.duktape'` — implemented via
 * `node:vm` with a 5 s timeout. JS-side CommonJS `require()` (FMD2
 * initializes `duk_module_duktape_init` + `Duktape.modSearch`,
 * Duktape.pas:88-89; 77 modules require files from inside JS — e.g.
 * templates/Madara.lua:178-179): `module`/`exports` cached per heap,
 * jailed to the synced `lua/` tree. FMD2 creates ONE Duktape heap per
 * ExecJS call (Duktape.pas:84) — the main script and every required
 * module share that single global scope (a module's `var CryptoJS` is
 * visible to later requires), and the heap dies with the call. Error
 * semantics: a JS error makes `ExecJS` return nil (LuaDuktape.pas:18-24);
 * JS `print` routes to the host log (Duktape.pas:90). `Duktape.enc/dec`
 * polyfilled (hex/base64/utf8).
 */

export const EXECJS_TIMEOUT_MS = 5000;

/** Minimal `Duktape` global: enc/dec polyfill + version marker. */
export const duktapeGlobal: Record<string, unknown> = {
  version: 20603, // duktape 2.x marker (FMD2 ships duktape 2.x)
  enc(mode: string, data: unknown): string {
    const s = typeof data === 'string' ? data : String(data ?? '');
    switch (mode) {
      case 'hex':
        return Buffer.from(s, 'utf8').toString('hex');
      case 'base64':
        return Buffer.from(s, 'utf8').toString('base64');
      case 'utf8':
        return s;
      default:
        throw new Error(`Duktape.enc: unsupported mode "${mode}"`);
    }
  },
  dec(mode: string, data: unknown): string {
    const s = typeof data === 'string' ? data : String(data ?? '');
    switch (mode) {
      case 'hex':
        return Buffer.from(s, 'hex').toString('utf8');
      case 'base64':
        return Buffer.from(s, 'base64').toString('utf8');
      case 'utf8':
        return s;
      default:
        throw new Error(`Duktape.dec: unsupported mode "${mode}"`);
    }
  },
};

export interface DuktapeShimOptions {
  /** The synced lua/ tree all JS requires resolve (and are jailed) inside. */
  readonly luaRoot: string;
  readonly logger: HostLogger | null;
  /** Module id attribution for print/log routing. */
  readonly moduleId: ModuleId;
}

function logJsPrint(logger: HostLogger | null, moduleId: ModuleId, level: 'log' | 'warn' | 'error', args: unknown[]): void {
  logger?.write({
    level,
    moduleId,
    message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\t'),
  });
}

/**
 * One Duktape heap equivalent: a single vm context shared by the ExecJS
 * main script and every module it requires (FMD2 heap-per-call).
 */
export class DuktapeHeap {
  private readonly rootAbs: string;
  private readonly moduleCache = new Map<string, Record<string, unknown>>();
  private readonly context: vm.Context;

  constructor(options: DuktapeShimOptions) {
    this.rootAbs = resolve(options.luaRoot);
    this.heapLogger = options.logger;
    this.heapModuleId = options.moduleId;
    const logger = options.logger;
    const moduleId = options.moduleId;
    this.context = vm.createContext({
      Duktape: duktapeGlobal,
      print: (...args: unknown[]) => logJsPrint(logger, moduleId, 'log', args),
      console: {
        log: (...args: unknown[]) => logJsPrint(logger, moduleId, 'log', args),
        warn: (...args: unknown[]) => logJsPrint(logger, moduleId, 'warn', args),
        error: (...args: unknown[]) => logJsPrint(logger, moduleId, 'error', args),
      },
      JSON,
      Math,
      require: (name: string): unknown => this.require(name),
    });
  }

  private isJailed(path: string): boolean {
    return path.startsWith(this.rootAbs + sep) || path === this.rootAbs;
  }

  /**
   * Resolve a module name: JS-style paths (with extension or `/`) are
   * taken as given (`utils/crypto-js.min.js`); bare dotted Lua-style
   * names (`utils.json`) map to the lua tree with extension fallbacks.
   */
  private resolveName(name: string): string {
    const candidates: string[] = [];
    if (name.endsWith('.js') || name.endsWith('.json') || name.includes('/')) {
      candidates.push(name);
    }
    const rel = name.replace(/\./g, '/');
    candidates.push(rel, `${rel}.js`, `${rel}.json`);
    for (const candidate of candidates) {
      const full = resolve(this.rootAbs, candidate);
      if (!this.isJailed(full)) {
        throw new Error(`require "${name}": escapes the lua tree jail`);
      }
      try {
        if (statSync(full).isFile()) {
          return full;
        }
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`require "${name}": not found in lua tree`);
  }

  private run(source: string, filename: string): unknown {
    const script = new vm.Script(source, { filename });
    return script.runInContext(this.context, { timeout: EXECJS_TIMEOUT_MS });
  }

  private readonly heapLogger: HostLogger | null;
  private readonly heapModuleId: ModuleId;

  /** The CommonJS `require` exposed to executed JS (heap-scoped cache). */
  require = (name: string): unknown => {
    const fileName = this.resolveName(name);
    const cached = this.moduleCache.get(fileName);
    if (cached !== undefined) {
      return cached;
    }
    const source = readFileSync(fileName, 'utf8');
    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    this.moduleCache.set(fileName, moduleObj.exports);
    const wrapper = this.run(
      `(function (module, exports, require, print, Duktape) {\n${source}\n})`,
      fileName,
    ) as (m: unknown, e: unknown, r: (s: string) => unknown, p: unknown, d: unknown) => void;
    wrapper(
      moduleObj,
      moduleObj.exports,
      this.require,
      (...args: unknown[]) => logJsPrint(this.heapLogger, this.heapModuleId, 'log', args),
      duktapeGlobal,
    );
    this.moduleCache.set(fileName, moduleObj.exports);
    return moduleObj.exports;
  };

  /** Eval the main script (duk_peval semantics); completion value out. */
  peval(source: string): unknown {
    return this.run(source, 'ExecJS');
  }
}

/**
 * duk_safe_to_string result text. Object/array completion values render
 * as their JSON source text — the observable FMD2 behavior the Madara
 * template relies on (it gsubs `\/`, `[`, `]` and gmatches quoted
 * strings out of the ExecJS output, templates/Madara.lua:184-186).
 */
function stringifyResult(result: unknown): string {
  if (typeof result === 'object' && result !== null) {
    try {
      return JSON.stringify(result);
    } catch {
      // fall through to String()
    }
  }
  return String(result);
}

/**
 * The `require 'fmd.duktape'` lib table: exactly one method `ExecJS`
 * (plus a debug `require` passthrough used by tests).
 */
export function makeDuktapeShim(options: DuktapeShimOptions): Record<string, (...args: unknown[]) => unknown> {
  return {
    ExecJS: (js: unknown): string | undefined => {
      const heap = new DuktapeHeap(options);
      try {
        const result = heap.peval(typeof js === 'string' ? js : String(js ?? ''));
        return result === undefined || result === null ? '' : stringifyResult(result);
      } catch (error) {
        // LuaDuktape.pas:18-24 — log + nil, never a Lua exception
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.write({
          level: 'error',
          moduleId: options.moduleId,
          message: `Duktape.ExecJS() ${message}`,
        });
        return undefined;
      }
    },
    require: (name: unknown): unknown => {
      const heap = new DuktapeHeap(options);
      try {
        return heap.require(typeof name === 'string' ? name : String(name ?? ''));
      } catch {
        return undefined;
      }
    },
  };
}

/** Convenience: one heap for direct require use in tests. */
export class DuktapeJsRuntime extends DuktapeHeap {}
