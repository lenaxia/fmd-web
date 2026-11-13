import { describe, expect, it, afterAll } from 'vitest';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { createLuaHost, type WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { installShims, FMD2_LUA_ROOT } from '../../../src/engine/shims/install.js';
import { RecordedResponseResolver, type RecordedResponse } from '../../../src/engine/shims/http-shim.js';
import type { InstalledShims } from '../../../src/engine/shims/install.js';

/**
 * §5.4 Lua round-trip: a real wasmoon state drives the shim exactly
 * like a site module — through the FacadeBridge (LuaClass-style
 * metatables, §5.1) — proving the Lua glue, not just the JS spec.
 *
 * Contract rows exercised through Lua:
 * | Row    | Lua surface                                        | Test                      |
 * |--------|-----------------------------------------------------|---------------------------|
 * | R-LUA1 | `HTTP.GET(url)` boolean + `HTTP.ResultCode/LastURL` | lua get round-trip        |
 * | R-LUA2 | `HTTP.Headers.Values['k'] = v` reaches the wire     | lua header on the wire    |
 * | R-LUA3 | `HTTP.Document.ToString()` reads the body           | (with R-LUA1)             |
 * | R-LUA4 | `HTTP.POST(url, data)` body + text/html rewrite     | lua post rewrite          |
 * | R-LUA5 | `HTTP.XHR(url)` sends X-Requested-With              | lua xhr                   |
 * | R-LUA6 | cookie methods (`AddServerCookies`/`GetCookies`)    | lua cookies               |
 * | R-LUA7 | properties get/set (`RetryCount`, `Compress`, …)    | (with R-LUA1)             |
 */

describe('http-shim §5.4 Lua round-trip', () => {
  const hosts: WasmoonLuaHost[] = [];

  afterAll(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.dispose()));
  });

  async function openLua(responses: RecordedResponse[]): Promise<{
    run: (code: string) => unknown;
    resolver: RecordedResponseResolver;
  }> {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    hosts.push(host);
    const luaRoot = FMD2_LUA_ROOT;
    await host.chunkCache.get('__http_probe.lua', 'function Init() end');
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    const resolver = new RecordedResponseResolver(responses);
    const engine = await host.createEngine();
    let kit: InstalledShims | undefined;
    await engine.loadModule('__http_probe.lua', (inner, bridge) => {
      kit = installShims(inner, bridge, {
        resolver,
        abort,
        logger,
        moduleId: 'http-probe',
        luaRoot,
      });
      bridge.create('HTTP', kit.makeHTTP());
    });
    if (kit === undefined) {
      throw new Error('shim install did not run');
    }
    return {
      run: (code: string) => engine.innerEngine.doStringSync(code),
      resolver,
    };
  }

  it('GET + headers + document + properties through Lua (R-LUA1/2/3/7)', async () => {
    const { run, resolver } = await openLua([
      { url: 'http://mock.test/lua-page', status: 200, body: 'lua-body' },
    ]);
    const result = run(`
      HTTP.Headers.Values['X-Probe'] = 'lua-value'
      local probeBefore = HTTP.Headers.Values['X-Probe']
      local ok = HTTP.GET('http://mock.test/lua-page')
      return {
        ok = ok,
        code = HTTP.ResultCode,
        url = HTTP.LastURL,
        body = HTTP.Document.ToString(),
        probe = probeBefore,
        probeAfter = HTTP.Headers.Values['X-Probe'],
        retry = HTTP.RetryCount,
        compress = HTTP.Compress,
        maxRedirect = HTTP.MaxRedirect,
        cookiesEnabled = HTTP.EnabledCookies,
        mime = HTTP.MimeType,
      }
    `) as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    expect(result['code']).toBe(200);
    expect(result['url']).toBe('http://mock.test/lua-page');
    expect(result['body']).toBe('lua-body');
    expect(result['probe']).toBe('lua-value');
    // the response replaced the Headers facade (synapse Clear quirk)
    expect(result['probeAfter']).toBe('');
    expect(result['retry']).toBe(0);
    expect(result['compress']).toBe(true);
    expect(result['maxRedirect']).toBe(5);
    expect(result['cookiesEnabled']).toBe(true);
    expect(result['mime']).toBe('text/html; charset=utf-8'); // response Content-Type
    expect(resolver.requests[0]?.headers['X-Probe']).toBe('lua-value');
    expect(resolver.requests[0]?.headers['DNT']).toBe('1'); // constructor Reset set
  });

  it('POST rewrite through Lua (R-LUA4)', async () => {
    const { run, resolver } = await openLua([
      { url: 'http://mock.test/lua-post', status: 200, body: 'ok' },
    ]);
    const result = run(`
      HTTP.Headers.Values['Content-Type'] = 'text/html'
      local ok = HTTP.POST('http://mock.test/lua-post', 'q=1&r=2')
      return { ok = ok, mime = HTTP.MimeType }
    `) as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    // after the response, MimeType follows the received Content-Type
    expect(result['mime']).toBe('text/html; charset=utf-8');
    expect(resolver.requests[0]?.body).toBe('q=1&r=2');
    expect(resolver.requests[0]?.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded; charset=UTF-8',
    );
  });

  it('XHR + cookies through Lua (R-LUA5/6)', async () => {
    const { run, resolver } = await openLua([
      { url: 'http://mock.test/lua-xhr', status: 200, body: 'xhr-body', headers: { 'Set-Cookie': 'luaCookie=42; Path=/' } },
    ]);
    const result = run(`
      local ok = HTTP.XHR('http://mock.test/lua-xhr')
      HTTP.AddServerCookies('manual=1')
      return {
        ok = ok,
        cookies = HTTP.GetCookies(),
        xhrCookie = HTTP.Cookies.Values['luaCookie'],
      }
    `) as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    expect(result['xhrCookie']).toBe('42');
    expect(String(result['cookies'])).toContain('luaCookie=42');
    expect(String(result['cookies'])).toContain('manual=1');
    expect(resolver.requests[0]?.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });
});
