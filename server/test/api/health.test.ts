/**
 * Health + runtime-entry tests: /healthz /readyz through the Fastify
 * app, and the main.ts raw-http → app.inject bridge (the Docker
 * healthcheck path) over a real loopback socket (offline policy:
 * loopback is allowed, external network is not).
 */
import type { AddressInfo } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildHarness } from './helpers.js';
import { createApp, createDefaultServices, SERVER_VERSION, respond } from '../../src/main.js';

async function withLoopback(fn: (port: number) => Promise<void>): Promise<void> {
  const app = createApp(createDefaultServices());
  const server = createHttp(respond(app));
  const listening = new Promise<void>((resolve, reject): void => {
    server.once('listening', resolve as () => void);
    server.once('error', reject);
  });
  server.listen(0);
  await listening;
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve): void => {
      server.close((): void => resolve());
    });
    await app.close();
  }
}

describe('health probes (§10)', (): void => {
  it('healthz + readyz over the Fastify app', async (): Promise<void> => {
    const h = buildHarness();
    const health = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', version: '0.1.0-test' });

    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true });
  });

  it('readyz reflects the readiness probe seam (503 while not ready)', async (): Promise<void> => {
    const h = buildHarness({ readiness: () => ({ ready: false, reason: 'registry sweep pending' }) });
    const res = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ready: false, reason: 'registry sweep pending' });
  });
});

describe('main.ts bridge: raw http → Fastify app (healthcheck path)', (): void => {
  it('serves healthz/readyz/modules through the same app over a loopback socket', async (): Promise<void> => {
    await withLoopback(async (port): Promise<void> => {
      const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', version: SERVER_VERSION });

      const ready = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ready: true });

      const modules = await fetch(`http://127.0.0.1:${String(port)}/api/modules`);
      expect(modules.status).toBe(200);
      expect((await modules.json() as { count: number }).count).toBe(0); // default assembly starts empty

      const miss = await fetch(`http://127.0.0.1:${String(port)}/definitely-not-a-route`);
      expect(miss.status).toBe(404);
    });
  });

  it('the bridge passes POST bodies through to the app (a write over the raw socket)', async (): Promise<void> => {
    const { createApp: build, createDefaultServices: services } = await import('../../src/main.js');
    const app = build(services());
    const server = createHttp(respond(app));
    const listening = new Promise<void>((resolve, reject): void => {
      server.once('listening', resolve as () => void);
      server.once('error', reject);
    });
    server.listen(0);
    await listening;
    const port = (server.address() as AddressInfo).port;
    try {
      // Token-only world: no login route exists — a state-changing
      // POST through the raw bridge proves body/method passthrough and
      // the open (*arr auth-None) contract in one shot.
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/modules/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'no-such-category', enabled: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated?: number };
      expect(body.updated).toBe(0);
    } finally {
      await new Promise<void>((resolve): void => {
        server.close((): void => resolve());
      });
      await app.close();
    }
  });
});
