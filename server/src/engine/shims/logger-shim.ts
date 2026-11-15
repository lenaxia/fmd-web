import type { HostLogger, ModuleId } from '@fmd/contract';

/**
 * fmd.logger shim (DESIGN.md §5.7, `LuaLogger.pas:33-45`): the complete
 * LuaLogger method surface — `Send`, `SendWarning`, `SendError` — routed
 * to the module-correlated structured host logger. Level parity with
 * FMD2's MultiLog: Send → log, SendWarning → warn, SendError → error;
 * every record carries the calling module's id (§4 observability
 * correlation). Argument parity: `luaToString(L, 1)` (LuaLogger.pas:18/
 * 24/30 → LuaUtils.pas:206-213 = lua_tolstring) coerces strings and
 * numbers and yields '' for every other type (nil, booleans, tables —
 * the Pascal NULL-pointer AnsiString), never a Lua error.
 */

export interface LoggerShimOptions {
  readonly logger?: HostLogger | null;
  readonly moduleId?: ModuleId;
}

/** lua_tolstring coercion (LuaUtils.pas:206-213): string|number → text, else ''. */
function luaToStringCoerce(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** The `require 'fmd.logger'` host-lib table (LuaLogger.pas:33-39 order). */
export function makeLoggerShim(options: LoggerShimOptions): {
  Send(value: unknown): undefined;
  SendWarning(value: unknown): undefined;
  SendError(value: unknown): undefined;
} {
  const logger = options.logger ?? null;
  const moduleId = options.moduleId ?? '';
  const emit =
    (level: 'log' | 'warn' | 'error') =>
    (value: unknown): undefined => {
      logger?.write({ level, moduleId, message: luaToStringCoerce(value) });
      return undefined;
    };
  return {
    Send: emit('log'),
    SendWarning: emit('warn'),
    SendError: emit('error'),
  };
}
