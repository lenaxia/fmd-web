import { describe, expect, it } from 'vitest';
import { EngineInfoService } from '../../../src/engine/services/module-info.js';
import { createLuaHostFactory } from '../../../src/engine/lua/host.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import type { HttpTransportPort, RawHttpRequest, RawHttpResult } from '../../../src/engine/shims/http-transport.js';
import type { RegistrationRecord } from '../../../src/engine/registry/capabilities.js';
import { fileURLToPath } from 'node:url';

/**
 * net_problem diagnosability regression (the MangaPark incident):
 * GET /api/info for a dying site must NAME the failing hop in its
 * upstream_error instead of the bare 'GetInfo returned net_problem'
 * that made parked-domain and slow-origin failures unattributable.
 *
 * Both live failure flavors are mocked at the transport port (hermetic
 * — no sockets; the RecordedHttpTransport path can't express a
 * transport-level failure):
 *  - slow-origin hang: Cloudflare holds a dying origin ~20s past the
 *    15s request timeout → transport ok:false 'timeout' (the live
 *    mangapark.net 523 behavior);
 *  - parked domain: the module's POST /apo/ lands on a parking server
 *    that answers 405 with an EMPTY body → the Size>0 rule fails the
 *    request while the response status line stays readable (the live
 *    mangapark.me behavior).
 *
 * E2ESeed.GetInfo is HTTP.GET(url)-shaped, so the same module serves
 * both cases through the REAL engine + shims.
 */

const LUA_ROOT = fileURLToPath(new URL('../../../../e2e/fixtures/lua/lua/', import.meta.url));
const MODULE_ID = 'e2ee000000000000000000000000ca7a';
const MANGA_URL = 'https://mock.test/manga/alpha-quest';

function registration(): RegistrationRecord {
  return {
    id: MODULE_ID,
    name: 'E2ESeed',
    rootURL: '',
    category: 'English',
    accountSupport: false,
    options: [],
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: ['GetInfo', 'GetPageNumber', 'GetImageURL'],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
    file: 'E2ESeed.lua',
  };
}

function failingTransport(result: RawHttpResult): HttpTransportPort {
  return {
    send(request: RawHttpRequest): RawHttpResult {
      void request;
      return result;
    },
  };
}

const TIMEOUT_RESULT: RawHttpResult = {
  ok: false,
  error: 'timeout after 15000ms',
  status: 0,
  statusText: '',
  headers: [],
  setCookie: [],
  body: new Uint8Array(0),
};

const EMPTY_405_RESULT: RawHttpResult = {
  ok: true,
  error: '',
  status: 405,
  statusText: 'Method Not Allowed',
  headers: [['Content-Type', 'text/html']],
  setCookie: [],
  body: new Uint8Array(0),
};

async function withService(
  transport: HttpTransportPort,
  run: (service: EngineInfoService) => Promise<void>,
): Promise<void> {
  const service = new EngineInfoService({
    luaRoot: LUA_ROOT,
    modules: () => [registration()],
    transport,
    egress: new EgressPolicy({ allow: ['*'] }),
    hostFactory: createLuaHostFactory(),
  });
  try {
    await run(service);
  } finally {
    await service.dispose();
  }
}

describe('module-info net_problem diagnosability', () => {
  it('transport timeout: the upstream_error names the hop (HTTP 500: timeout …)', async (): Promise<void> => {
    await withService(failingTransport(TIMEOUT_RESULT), async (service) => {
      await expect(service.getInfo(MODULE_ID, MANGA_URL)).rejects.toMatchObject({
        status: 502,
        code: 'upstream_error',
        message: `GetInfo returned net_problem for ${MANGA_URL} (HTTP 500: timeout after 15000ms)`,
      });
    });
  }, 60_000);

  it('parked-domain 405 with empty body: the upstream_error carries the status line', async (): Promise<void> => {
    await withService(failingTransport(EMPTY_405_RESULT), async (service) => {
      await expect(service.getInfo(MODULE_ID, MANGA_URL)).rejects.toMatchObject({
        status: 502,
        code: 'upstream_error',
        message: `GetInfo returned net_problem for ${MANGA_URL} (HTTP 405: Method Not Allowed)`,
      });
    });
  }, 60_000);
});
