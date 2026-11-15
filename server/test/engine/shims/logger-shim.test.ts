import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { makeLoggerShim } from '../../../src/engine/shims/logger-shim.js';
import { installRequireShim } from '../../../src/engine/shims/lua-require.js';

/**
 * fmd.logger proofs (DESIGN.md §5.7, LuaLogger.pas): the complete
 * LuaLogger API (Send / SendWarning / SendError — LuaLogger.pas:33-45)
 * routed to the structured host logger with module-id correlation.
 * Levels mirror FMD2's MultiLog: Send → log, SendWarning → warn,
 * SendError → error. The real consumer shapes (VyManga.lua:95
 * `require 'fmd.logger'.SendWarning(...)`, websitebypass.lua:13
 * `LOGGER = require 'fmd.logger'`) are exercised end-to-end.
 */

describe('makeLoggerShim — luaToString coercion (LuaUtils.pas:206-213)', (): void => {
  it('routes strings/numbers, coerces everything else to empty string', (): void => {
    const logger = createMemoryLogger();
    const shim = makeLoggerShim({ logger, moduleId: 'M1' });
    shim.Send('plain');
    shim.Send(42);
    shim.Send(true); // lua_tolstring: booleans → NULL → ''
    shim.SendWarning('');
    logger.clear();
    shim.SendError('boom');
    const records = logger.forModule('M1');
    expect(records).toEqual([{ level: 'error', moduleId: 'M1', message: 'boom' }]);
  });

  it('without a logger the calls are silent no-ops', (): void => {
    const shim = makeLoggerShim({});
    expect(() => shim.SendError('dropped')).not.toThrow();
  });
});

describe("require 'fmd.logger' — LuaLogger API + module-correlated structured output", (): void => {
  const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-logger-shim-'));
  const logger = createMemoryLogger();
  let engine: LuaEngine;

  beforeAll(async (): Promise<void> => {
    mkdirSync(luaRoot, { recursive: true });
    writeFileSync(join(luaRoot, 'placeholder.lua'), 'return true');
    engine = await new LuaFactory().createEngine();
    installRequireShim(engine, { luaRoot, moduleId: 'VyManga', logger });
  });

  afterAll((): void => {
    engine.global.close();
    rmSync(luaRoot, { recursive: true, force: true });
  });

  it('exposes exactly the LuaLogger.pas method surface', (): void => {
    // host libs cross as wasmoon userdata proxies (like fmd.duktape) —
    // method presence, not pairs()
    const r = engine.doStringSync(`
      local t = require 'fmd.logger'
      return tostring(t.Send ~= nil) .. ',' .. tostring(t.SendWarning ~= nil) .. ',' ..
             tostring(t.SendError ~= nil)
    `) as string;
    expect(r).toBe('true,true,true');
  });

  it('Send/SendWarning/SendError carry MultiLog levels + the module id', (): void => {
    logger.clear();
    const r = engine.doStringSync(`
      local log = require 'fmd.logger'
      log.Send('getting manga info')
      log.SendWarning('deprecated endpoint')
      log.SendError('network failure')
      return 'done'
    `) as string;
    expect(r).toBe('done');
    const records = logger.forModule('VyManga');
    expect(records.map((rec): readonly [string, string, string] => [rec.level, rec.moduleId, rec.message]))
      .toEqual([
        ['log', 'VyManga', 'getting manga info'],
        ['warn', 'VyManga', 'deprecated endpoint'],
        ['error', 'VyManga', 'network failure'],
      ]);
  });

  it("the VyManga.lua consumer shape: require 'fmd.logger'.SendWarning(...) in one expression", (): void => {
    logger.clear();
    engine.doStringSync(`require 'fmd.logger'.SendWarning('VyManga: chapter URL is not cached')`);
    const records = logger.forModule('VyManga');
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.message).toBe('VyManga: chapter URL is not cached');
  });

  it("the websitebypass.lua consumer shape: LOGGER = require 'fmd.logger' then LOGGER.Send", (): void => {
    logger.clear();
    engine.doStringSync(`
      local LOGGER = require 'fmd.logger'
      LOGGER.Send('bypass module loaded')
    `);
    const records = logger.forModule('VyManga');
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('log');
  });

  it('module attribution stays scoped — other modules see no records', (): void => {
    logger.clear();
    engine.doStringSync(`require 'fmd.logger'.SendError('only for VyManga')`);
    expect(logger.forModule('VyManga')).toHaveLength(1);
    expect(logger.forModule('ComicK')).toHaveLength(0);
  });

  it('coercion parity: nil and boolean arguments log empty strings, never error', (): void => {
    logger.clear();
    const r = engine.doStringSync(`
      local log = require 'fmd.logger'
      log.Send(nil)
      log.Send(true)
      return 'ok'
    `) as string;
    expect(r).toBe('ok');
    const records = logger.forModule('VyManga');
    expect(records).toHaveLength(2);
    expect(records[0]?.message).toBe('');
    expect(records[1]?.message).toBe('');
  });
});
