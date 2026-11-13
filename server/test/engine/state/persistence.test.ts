import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AntiBotInterceptor, type InterceptableRequest } from '../../../src/engine/state/antibot.js';
import { ModuleStateService } from '../../../src/engine/state/module-state.js';
import type { ModuleSharedState } from '../../../src/engine/state/module-state.js';
import {
  InMemoryModuleStatePersistence,
  type PersistedModuleState,
} from '../../../src/engine/state/persistence.js';

/**
 * Persistence round-trips (§9 module_state.cookies/ua): bypassed clearance
 * must survive a service restart — a NEW ModuleStateService over the SAME
 * store rehydrates the cookie jar + settings so downloads keep working
 * without a second bypass.
 */

/** Scripted 403-antibot request (unit-level bypass persistence flow). */
class ScriptedRequest implements InterceptableRequest {
  userAgent = 'DefaultUA/1.0';
  terminated = false;
  asr = false;
  resets = 0;
  private lastView = { resultCode: 403, contentType: 'text/html', server: 'cloudflare' };

  constructor(private readonly module: ModuleSharedState) {}

  get method(): string {
    return 'GET';
  }

  get url(): string {
    return 'https://example.com/chapter/1/page-1.webp';
  }

  setAllowServerErrorResponse(value: boolean): void {
    this.asr = value;
  }

  reset(): void {
    this.resets += 1;
  }

  view(): { resultCode: number; contentType: string; server: string } {
    return this.lastView;
  }

  async execute(): Promise<boolean> {
    // The mocked origin accepts the clearance cookie; before it exists the
    // request 403s on the antibot page (success ⇔ Document.Size > 0).
    if (this.module.cookies.get('cf_clearance') === 'bypassed') {
      this.lastView = { resultCode: 200, contentType: 'image/png', server: 'cloudflare' };
      return true;
    }
    this.lastView = { resultCode: 403, contentType: 'text/html', server: 'cloudflare' };
    return false;
  }
}

describe('module_state persistence round-trip (§9)', () => {
  it('persist → new service instance (restart) rehydrates cookies/ua/storage/options', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    const serviceA = new ModuleStateService({ persistence });
    const state = await serviceA.forModule('mod');
    await state.cookies.write((jar) => {
      jar.set('cf_clearance', 'bypassed');
      jar.set('anon', 'seed');
    });
    // settings.cookies is the persisted mirror (FMD2 Settings.HTTP.Cookies);
    // the interceptor keeps it in sync with the jar on bypass success.
    await state.settings.setCookies('cf_clearance=bypassed;anon=seed');
    await state.settings.setUserAgent('BypassUA/1.0');
    state.storage.set('reload', 'true');
    state.settings.setOption('mirror', 'http://m');
    await state.persist();

    // --- service restart: a fresh instance over the same store ---
    const serviceB = new ModuleStateService({ persistence });
    const rehydrated = await serviceB.forModule('mod');
    const jar = await rehydrated.cookies.snapshot();
    expect(jar.entries['cf_clearance']).toBe('bypassed');
    expect(jar.entries['anon']).toBe('seed');
    const settings = await rehydrated.settings.snapshot();
    expect(settings.cookies).toBe('cf_clearance=bypassed;anon=seed');
    expect(settings.userAgent).toBe('BypassUA/1.0');
    expect(settings.options['mirror']).toBe('http://m');
    expect(rehydrated.storage.getOrEmpty('reload')).toBe('true');
  });

  it('a bypassed interceptor persists module_state.cookies/ua for the restart (AC3)', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    const serviceA = new ModuleStateService({ persistence });
    const moduleA = await serviceA.forModule('webtoon');
    moduleA.storage.set('reload', 'true');

    const interceptor = new AntiBotInterceptor();
    const request = new ScriptedRequest(moduleA);
    const outcome = await interceptor.intercept(request, moduleA, {
      bypassExecutor: {
        available: true,
        bypass: async (ctx) => {
          ctx.module.cookies.set('cf_clearance', 'bypassed');
          (ctx.request as ScriptedRequest).userAgent = 'BypassUA/1.0';
          return true;
        },
      },
    });
    expect(outcome.result).toBe(true);
    // The interceptor itself persisted (module_state.cookies/ua):
    expect(persistence.row('webtoon')).toMatchObject({
      cookies: 'cf_clearance=bypassed',
      ua: 'BypassUA/1.0',
    });

    // --- restart ---
    const serviceB = new ModuleStateService({ persistence });
    const moduleB = await serviceB.forModule('webtoon');
    expect(moduleB.cookies.get('cf_clearance')).toBe('bypassed');
    expect((await moduleB.settings.snapshot()).userAgent).toBe('BypassUA/1.0');
  });

  it('a pre-existing store seeds a fresh service (disk-like restart)', async () => {
    const row: PersistedModuleState = {
      cookies: 'sid=abc; theme=dark',
      ua: 'PersistedUA/9.0',
      enabled: false,
      options: { quality: 'high' },
      storage: { session: 'token123' },
    };
    const service = new ModuleStateService({
      persistence: new InMemoryModuleStatePersistence({ webtoon: row }),
    });
    const state = await service.forModule('webtoon');
    const jar = await state.cookies.snapshot();
    expect(jar.requestHeader).toBe('sid=abc; theme=dark');
    const settings = await state.settings.snapshot();
    expect(settings.userAgent).toBe('PersistedUA/9.0');
    expect(settings.enabled).toBe(false);
    expect(settings.options['quality']).toBe('high');
    expect(state.storage.getOrEmpty('session')).toBe('token123');
  });
});

/** Functional proof: after a restart the rehydrated clearance WORKS. */
describe('restart survival over the loopback mock server', () => {
  const server = {
    port: 0,
    server: null as http.Server | null,
    async start(): Promise<void> {
      this.server = http.createServer((req, res) => {
        const cookieHeader = String(req.headers.cookie ?? '');
        if (cookieHeader.includes('cf_clearance=bypassed')) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end('PNGDATA');
        } else {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', Server: 'cloudflare' });
          res.end('<html>Just a moment...</html>');
        }
      });
      await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
      this.port = (this.server!.address() as { port: number }).port;
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    },
  };

  beforeAll(() => server.start());
  afterAll(() => server.stop());

  async function loopbackGet(
    module: { cookiesSnapshotHeader(): string; addServerCookie(s: string): void },
    path: string,
  ): Promise<{ status: number; bodyLength: number }> {
    const headers: Record<string, string> = {};
    const cookieHeader = module.cookiesSnapshotHeader();
    if (cookieHeader !== '') {
      headers.Cookie = cookieHeader;
    }
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
    const body = await res.text();
    void module;
    return { status: res.status, bodyLength: body.length };
  }

  it('clearance persisted before the restart serves the post-restart download (plain path, no bypass)', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    // --- pre-restart: bypass persists clearance ---
    const serviceA = new ModuleStateService({ persistence });
    const moduleA = await serviceA.forModule('webtoon');
    await moduleA.cookies.write((jar) => jar.set('cf_clearance', 'bypassed'));
    await moduleA.settings.setCookies('cf_clearance=bypassed');
    await moduleA.settings.setUserAgent('BypassUA/1.0');
    await moduleA.persist();

    // --- restart over the same store ---
    const serviceB = new ModuleStateService({ persistence });
    const moduleB = await serviceB.forModule('webtoon');
    // Post-restart download succeeds on the PLAIN path — no bypass executor.
    const outcome = await new AntiBotInterceptor().intercept(
      {
        method: 'GET',
        url: `http://127.0.0.1:${server.port}/img-post-restart.webp`,
        terminated: false,
        userAgent: 'BypassUA/1.0',
        view: () => ({ resultCode: 200, contentType: 'image/png', server: '' }),
        setAllowServerErrorResponse: () => undefined,
        reset: () => undefined,
        execute: async () => {
          const r = await loopbackGet(
            { cookiesSnapshotHeader: () => moduleB.cookies.snapshotSync().requestHeader, addServerCookie: () => undefined },
            '/img-post-restart.webp',
          );
          return r.status === 200 && r.bodyLength > 0;
        },
      },
      moduleB,
    );
    expect(outcome).toEqual({ result: true, antibotHit: false, path: 'plain' });
  });
});
