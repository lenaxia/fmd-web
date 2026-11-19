/**
 * Site-availability opportunistic-write seam (dead-site discovery):
 * the availabilitySink wired into the REAL engine + §5.4 shims fires
 * from EXISTING traffic — no scattered try/catches, one classification
 * per dispatch via the §5.2 readback. Hermetic transport-port mocks
 * (the same shapes the net_problem diagnosability suite pins):
 *
 *  - slow-origin timeout (transport ok:false 'timeout') → unreachable
 *    + reason;
 *  - Cloudflare 523 WITH a body → HTTP.Get "succeeds" (Size>0), the
 *    module parse fails net_problem, the readback still names 523 →
 *    unreachable;
 *  - parked-domain 405 with an EMPTY body → net_problem but a 4xx
 *    readback → NO sink call (record untouched);
 *  - a clean 200 answer the module parses → reachable.
 */
import { describe, expect, it } from 'vitest';
import { EngineInfoService } from '../../../src/engine/services/module-info.js';
import type {
  AvailabilitySink,
  SiteAvailabilityOutcome,
} from '../../../src/engine/services/availability.js';
import { createLuaHostFactory } from '../../../src/engine/lua/host.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import type { HttpTransportPort, RawHttpRequest, RawHttpResult } from '../../../src/engine/shims/http-transport.js';
import type { RegistrationRecord } from '../../../src/engine/registry/capabilities.js';
import { fileURLToPath } from 'node:url';

const LUA_ROOT = fileURLToPath(new URL('../../../../e2e/fixtures/lua/lua/', import.meta.url));
const MODULE_ID = 'e2ee000000000000000000000000ca7a';
const MANGA_URL = 'https://mock.test/manga/alpha-quest';

const INFO_BODY = Buffer.from(
  '<html><body>' +
    '<h1 id="manga-title">Alpha Quest</h1>' +
    '<span id="authors">Author A</span>' +
    '<span id="genres">Action</span>' +
    '<span id="status">Ongoing</span>' +
    '<p id="summary">A quest.</p>' +
    '<ul id="chapters"><li><a href="/manga/alpha-quest/c001">Ch.001</a></li></ul>' +
    '</body></html>',
);

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

const CF_523_RESULT: RawHttpResult = {
  ok: true,
  error: '',
  status: 523,
  statusText: 'Origin Unreachable',
  headers: [['Content-Type', 'text/html']],
  setCookie: [],
  body: Buffer.from('<html><body><h1>523 Origin Unreachable</h1></body></html>'),
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

const OK_200_RESULT: RawHttpResult = {
  ok: true,
  error: '',
  status: 200,
  statusText: 'OK',
  headers: [['Content-Type', 'text/html']],
  setCookie: [],
  body: INFO_BODY,
};

function collectingSink(): { outcomes: SiteAvailabilityOutcome[]; sink: AvailabilitySink } {
  const outcomes: SiteAvailabilityOutcome[] = [];
  return {
    outcomes,
    sink: (moduleId, outcome): void => {
      expect(moduleId).toBe(MODULE_ID);
      outcomes.push(outcome);
    },
  };
}

describe('module-info availability sink (opportunistic write seam)', () => {
  it(
    'transport timeout → GetInfo fails AND the sink records unreachable + reason',
    async (): Promise<void> => {
      const { outcomes, sink } = collectingSink();
      const service = new EngineInfoService({
        luaRoot: LUA_ROOT,
        modules: () => [registration()],
        transport: failingTransport(TIMEOUT_RESULT),
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: sink,
        hostFactory: createLuaHostFactory(),
      });
      try {
        await expect(service.getInfo(MODULE_ID, MANGA_URL)).rejects.toMatchObject({
          status: 502,
          code: 'upstream_error',
        });
      } finally {
        await service.dispose();
      }
      expect(outcomes).toEqual([{ verdict: 'unreachable', reason: 'timeout after 15000ms' }]);
    },
    60_000,
  );

  it(
    'Cloudflare 523 with body → the module "succeeds" on the error page (N/A title parity) but the 523 readback still records unreachable',
    async (): Promise<void> => {
      const { outcomes, sink } = collectingSink();
      const service = new EngineInfoService({
        luaRoot: LUA_ROOT,
        modules: () => [registration()],
        transport: failingTransport(CF_523_RESULT),
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: sink,
        hostFactory: createLuaHostFactory(),
      });
      try {
        // Size>0 makes HTTP.Get TRUE, the module parses the error page
        // and returns no_error (uData.pas:137 N/A-title parity) — the
        // dispatch does NOT fail, which is exactly why classification
        // is STATUS-FIRST: the 523 readback names the dead origin.
        const info = await service.getInfo(MODULE_ID, MANGA_URL);
        expect(info.title).toBe('N/A');
      } finally {
        await service.dispose();
      }
      expect(outcomes).toEqual([{ verdict: 'unreachable', reason: 'Origin Unreachable' }]);
    },
    60_000,
  );

  it(
    'parked-domain 405 empty body → net_problem but NO sink call (4xx abstains)',
    async (): Promise<void> => {
      const { outcomes, sink } = collectingSink();
      const service = new EngineInfoService({
        luaRoot: LUA_ROOT,
        modules: () => [registration()],
        transport: failingTransport(EMPTY_405_RESULT),
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: sink,
        hostFactory: createLuaHostFactory(),
      });
      try {
        await expect(service.getInfo(MODULE_ID, MANGA_URL)).rejects.toMatchObject({
          status: 502,
          code: 'upstream_error',
        });
      } finally {
        await service.dispose();
      }
      expect(outcomes).toEqual([]);
    },
    60_000,
  );

  it(
    'a clean 200 the module parses → success AND the sink records reachable',
    async (): Promise<void> => {
      const { outcomes, sink } = collectingSink();
      const service = new EngineInfoService({
        luaRoot: LUA_ROOT,
        modules: () => [registration()],
        transport: failingTransport(OK_200_RESULT),
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: sink,
        hostFactory: createLuaHostFactory(),
      });
      try {
        const info = await service.getInfo(MODULE_ID, MANGA_URL);
        expect(info.title).toBe('Alpha Quest');
      } finally {
        await service.dispose();
      }
      expect(outcomes).toEqual([{ verdict: 'reachable' }]);
    },
    60_000,
  );

  it(
    'a throwing sink never takes the traffic path down (fire-and-forget contract)',
    async (): Promise<void> => {
      const service = new EngineInfoService({
        luaRoot: LUA_ROOT,
        modules: () => [registration()],
        transport: failingTransport(OK_200_RESULT),
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: (): void => {
          throw new Error('store is on fire');
        },
        hostFactory: createLuaHostFactory(),
      });
      try {
        const info = await service.getInfo(MODULE_ID, MANGA_URL);
        expect(info.title).toBe('Alpha Quest');
      } finally {
        await service.dispose();
      }
    },
    60_000,
  );
});
