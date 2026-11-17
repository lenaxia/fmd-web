import type { HostLogger, ModuleId } from '@fmd/contract';
import type { HttpAbortHandle } from '../contract.js';
import { DeadlineAbortHandle, blockingSleep, createDeadlineCells } from './abort.js';
import type { FacadeBridge } from './facade.js';
import {
  getBetween,
  mangaInfoStatusIfPos,
  maybeFillHost,
  separateLeft,
  separateRight,
  trimLua,
} from './pascal-strings.js';
import { makeTXQuerySpec } from './stubs.js';
import type { LuaEngine as WasmoonEngine } from 'wasmoon';

/**
 * §5.1 base globals (`LuaBase.pas:78-97`, `LuaBaseUnit.pas`, `LuaSynaUtil.pas`,
 * `LuaWebsiteModules.pas:481-493`): print, sleep, CreateTXQuery (stub —
 * §5.6 is its own story), Trim, MaybeFillHost, MangaInfoStatusIfPos,
 * GetBetween, SeparateLeft, SeparateRight. `NewWebsiteModule` is
 * registered only by the Init pass (§5.1: available ONLY during Init()).
 */

/** Per-state event environment, late-bound (dispatcher swaps it in). */
export interface EngineEnvironment {
  abort: HttpAbortHandle;
  cells: Int32Array;
  logger: HostLogger;
  moduleId: ModuleId;
}

export function createIdleEnvironment(logger: HostLogger): EngineEnvironment {
  return {
    abort: new DeadlineAbortHandle(createDeadlineCells()),
    cells: createDeadlineCells(),
    logger,
    moduleId: '',
  };
}

/** lua_tostring coercion (nil/absent → ''). */
export function toStr(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

/** lua_tointeger coercion (numbers truncate, numeric strings convert, else 0). */
export function toInteger(value: unknown): number {
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return 0;
}

/** Lua truthiness: everything except nil and false. */
export function toBool(value: unknown): boolean {
  return !(value === undefined || value === null || value === false);
}

export function installBaseEnvironment(
  engine: WasmoonEngine,
  bridge: FacadeBridge,
  envProvider: () => EngineEnvironment,
): void {
  // print → structured logger with module attribution (§5.1, LuaBase.pas:60-77)
  engine.global.set('print', (...args: unknown[]) => {
    const env = envProvider();
    env.logger.write({
      level: 'log',
      moduleId: env.moduleId,
      message: args.map((a) => (typeof a === 'boolean' ? (toBool(a) ? 'true' : 'false') : toStr(a))).join('\t'),
    });
  });

  // sleep(ms) → real blocking sleep on the worker thread (§5.1, LuaBase.pas:72-76)
  engine.global.set('sleep', (ms: unknown) => {
    const env = envProvider();
    blockingSleep(toInteger(ms), env.abort, env.cells);
  });

  engine.global.set('Trim', (s: unknown, chars?: unknown) => {
    return chars === undefined ? trimLua(toStr(s)) : trimLua(toStr(s), toStr(chars));
  });
  engine.global.set('MaybeFillHost', (host: unknown, url: unknown) => {
    return maybeFillHost(toStr(host), toStr(url));
  });
  engine.global.set(
    'MangaInfoStatusIfPos',
    (s: unknown, ongoing?: unknown, completed?: unknown, hiatus?: unknown, cancelled?: unknown) => {
      return mangaInfoStatusIfPos(
        toStr(s),
        toStr(ongoing),
        toStr(completed),
        toStr(hiatus),
        toStr(cancelled),
      );
    },
  );
  engine.global.set('GetBetween', (pairBegin: unknown, pairEnd: unknown, value: unknown) => {
    return getBetween(toStr(pairBegin), toStr(pairEnd), toStr(value));
  });
  engine.global.set('SeparateLeft', (value: unknown, delimiter: unknown) => {
    return separateLeft(toStr(value), toStr(delimiter));
  });
  engine.global.set('SeparateRight', (value: unknown, delimiter: unknown) => {
    return separateRight(toStr(value), toStr(delimiter));
  });

  // CreateTXQuery(...) stub (§5.6 is its own story; constructor shape per
  // LuaXQuery.pas:209-212 — HTTP.Document | HTML string | none).
  engine.global.set('__fmd_new_txquery', () => bridge.create('', makeTXQuerySpec()));
  engine.doStringSync(
    'function CreateTXQuery(_document_or_html) return __fmd_facade_new(__fmd_new_txquery(), \'\') end',
  );
}
