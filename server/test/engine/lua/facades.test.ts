import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import type { WasmoonLuaEngine } from '../../../src/engine/lua/engine.js';
import type { WasmoonLuaHost } from '../../../src/engine/lua/host.js';

/**
 * Facade-surface tests (§5.1/§5.5 stubs): the TStrings/HTTP/TXQuery/Storage
 * surfaces driven from Lua through a real engine — surface shape, typed
 * reads/writes, silent no-ops on unknown keys.
 */

describe('engine facades (§5.1/§5.5 surface stubs)', () => {
  let host: WasmoonLuaHost;
  let engine: WasmoonLuaEngine;

  beforeEach(async () => {
    host = createLuaHost(createMemoryLogger());
    engine = await host.createEngine();
    await host.chunkCache.get('facades.lua', 'FACADES_PLACEHOLDER = true');
    await engine.loadModule('facades.lua');
  });

  afterEach(async () => {
    await engine.dispose();
    await host.dispose();
  });

  it('TStrings: Add/Get/Set[i]/Count/Clear/Delete/IndexOf/Reverse/Sort from Lua', async () => {
    const bridge = engine.debugBridge;
    const { makeTStrings } = await import('../../../src/engine/lua/stubs.js');
    const handle = makeTStrings(bridge);
    bridge.create('LIST', handle.spec);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    // FMD2 modules call facade methods with DOT syntax (args start at 1,
    // LuaClass.pas:94-169 fetches the object from the userdata)
    expect(run(`LIST.Add('b') LIST.Add('a') return LIST.Count`)).toBe(2);
    expect(run(`return LIST[0]`)).toBe('b');
    expect(run(`return LIST.Get(1)`)).toBe('a');
    expect(run(`LIST[1] = 'c' return LIST[1]`)).toBe('c');
    expect(run(`return LIST.IndexOf('c')`)).toBe(1);
    expect(run(`LIST.Delete(1) return LIST.Count`)).toBe(1);
    expect(run(`LIST.Add('aa') LIST.Sort() return LIST[0]`)).toBe('aa');
    expect(run(`LIST.Reverse() return LIST[0]`)).toBe('b');
    expect(run(`LIST.Clear() return LIST.Count`)).toBe(0);
    expect(handle.values).toEqual([]);
  });

  it('TStrings: Values[name] and Strings[i] sub-facades', async () => {
    const bridge = engine.debugBridge;
    const { makeTStrings } = await import('../../../src/engine/lua/stubs.js');
    const handle = makeTStrings(bridge);
    bridge.create('PROPS', handle.spec);
    engine.innerEngine.doStringSync(`
      PROPS.Values['session'] = 'abc'
      PROPS.Strings[1] = 'zero'
    `);
    expect(handle.values).toEqual(['session=abc', 'zero']);
    expect(
      engine.innerEngine.doStringSync(`return PROPS.Values['session'] .. '|' .. PROPS.Strings[1]`),
    ).toBe('abc|zero');
    expect(handle.spec.get('Text')).toBe('session=abc\nzero');
  });

  it('HTTP stub: shape, offline GET=false, Terminated read, typed defaults', async () => {
    const bridge = engine.debugBridge;
    const { makeHTTPSpec } = await import('../../../src/engine/lua/stubs.js');
    const { DeadlineAbortHandle, createDeadlineCells } = await import(
      '../../../src/engine/lua/abort.js'
    );
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    bridge.create('HTTP', makeHTTPSpec(() => abort, bridge));
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return HTTP.GET('https://x.example')`)).toBe(false);
    expect(run(`return HTTP.RetryCount`)).toBe(0);
    expect(run(`return HTTP.MaxRedirect`)).toBe(5);
    expect(run(`return HTTP.Terminated`)).toBe(false);
    expect(run(`HTTP.UserAgent = 'fmd-web' return HTTP.UserAgent`)).toBe('fmd-web');
    // read-only props cannot be written
    run(`HTTP.Terminated = true`);
    expect(run(`return HTTP.Terminated`)).toBe(false);
    // header write through the TStrings facade
    run(`HTTP.Headers.Values['accept'] = 'text/html'`);
    expect(run(`return HTTP.Headers.Values['accept']`)).toBe('text/html');
  });

  it('TXQuery stub: constructor surface with empty results', async () => {
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(
      run(`
      local x = CreateTXQuery('<html/>')
      return x ~= nil and x.XPathString('//a') == '' and x.XPathCount('//a') == 0
    `),
    ).toBe(true);
  });

  it('pascal base globals callable from Lua: Trim/MaybeFillHost/GetBetween/Separate*', async () => {
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return Trim('  x ')`)).toBe('x');
    expect(run(`return MaybeFillHost('https://b.example', '/p/1')`)).toBe('https://b.example/p/1');
    expect(run(`return MaybeFillHost('https://b.example', 'https://o.example/p')`)).toBe(
      'https://o.example/p',
    );
    expect(run(`return GetBetween('(', ')', 'a(b)c')`)).toBe('b');
    expect(run(`return SeparateLeft('k=v', '=') .. '|' .. SeparateRight('k=v', '=')`)).toBe('k|v');
    expect(run(`return MangaInfoStatusIfPos('ongoing', 'ongoing', 'end')`)).toBe('1');
  });
});
