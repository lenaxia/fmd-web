/**
 * R4 /ws upgrade auth (real loopback WebSockets, offline): the upgrade
 * gate keys on the PASSWORD flow only (*arr semantics) — Authorization
 * header preferred, `?token=` query param for browser WS clients, the
 * session cookie also granting when the password flow is on. Password
 * off (even with a token present) keeps the open hub; password on:
 * wrong or missing credentials reject the handshake with a plain-HTTP
 * 401 before any hub state exists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocket as WsClient } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildHarness } from '../helpers.js';
import { WsHub } from '../../../src/api/ws/hub.js';
import type { AuthConfig } from '../../../src/api/auth.js';
import type { JobT } from '@fmd/contract';

const HOST = '127.0.0.1';
const TOKEN = 'a'.repeat(64);
const PASSWORD = 'hunter2';

interface Running {
  readonly app: FastifyInstance;
  readonly hub: WsHub;
  readonly port: number;
  close(): Promise<void>;
}

async function startServer(auth: AuthConfig): Promise<Running> {
  const hub = new WsHub({ tickIntervalMs: 0 });
  const harness = buildHarness({ auth, wsHub: hub });
  const app = harness.app;
  await app.listen({ port: 0, host: HOST });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    hub,
    port,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

interface ConnectOptions {
  readonly path?: string;
  readonly headers?: Record<string, string>;
}

/** Open a socket; resolves on 'open', rejects on the handshake error. */
function tryConnect(port: number, opts: ConnectOptions = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${String(port)}${opts.path ?? '/ws'}`, {
      headers: opts.headers,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connect timed out'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function expectRejected(port: number, opts: ConnectOptions): Promise<void> {
  await expect(tryConnect(port, opts)).rejects.toThrow(/401/);
}

let jobSeq = 0;
function publish(hub: WsHub): string {
  jobSeq += 1;
  const job: JobT = {
    id: `j${String(jobSeq)}`,
    type: 'download',
    moduleId: 'a'.repeat(32),
    payload: { moduleId: 'a'.repeat(32), mangaUrl: 'https://ex.org/manga', chapterLink: `ch/${String(jobSeq)}` },
    state: 'queued',
    priority: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return hub.publish(job).id;
}

/** Full end-to-end proof: hello → publish → the frame arrives on the wire. */
function nextFrame(ws: WsClient, timeoutMs = 5000): Promise<{ type: string; id?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('frame timed out'));
    }, timeoutMs);
    function onMessage(data: unknown): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(JSON.parse(String(data)) as { type: string; id?: string });
    }
    ws.once('message', onMessage);
  });
}

async function loginCookie(server: Running): Promise<string> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'] as string;
  return setCookie.split(';')[0] ?? '';
}

const servers: Running[] = [];
async function server(auth: AuthConfig): Promise<Running> {
  const s = await startServer(auth);
  servers.push(s);
  return s;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
  }
});

// ── token present + password unset → OPEN upgrade (*arr) ────────────

describe('R4 /ws upgrade: token present + password unset → open upgrade', (): void => {
  it('browser live tiles connect with NO credentials (a token never gates)', async (): Promise<void> => {
    const s = await server({ password: undefined, apiToken: TOKEN });
    const ws = await tryConnect(s.port);
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });

  it('the Authorization header is still accepted (and serves the hub)', async (): Promise<void> => {
    const s = await server({ password: undefined, apiToken: TOKEN });
    const ws = await tryConnect(s.port, { headers: { authorization: `Bearer ${TOKEN}` } });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });

  it('the ?token= query param still connects (browser WS clients)', async (): Promise<void> => {
    const s = await server({ password: undefined, apiToken: TOKEN });
    const ws = await tryConnect(s.port, { path: `/ws?token=${TOKEN}` });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });

  it('a WRONG token is simply ignored when the password is off (open upgrade)', async (): Promise<void> => {
    const s = await server({ password: undefined, apiToken: TOKEN });
    const ws = await tryConnect(s.port, { headers: { authorization: `Bearer ${'b'.repeat(64)}` } });
    ws.close();
  });
});

describe('R4 /ws upgrade: token + password deployment', (): void => {
  it('a browser session cookie also grants the upgrade', async (): Promise<void> => {
    const s = await server({ password: PASSWORD, apiToken: TOKEN });
    await expectRejected(s.port, {});
    const cookie = await loginCookie(s);
    const ws = await tryConnect(s.port, { headers: { cookie } });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });

  it('the Bearer token still grants alongside the cookie flow', async (): Promise<void> => {
    const s = await server({ password: PASSWORD, apiToken: TOKEN });
    const ws = await tryConnect(s.port, { headers: { authorization: `Bearer ${TOKEN}` } });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });
});

// ── password unset → open hub ────────────────────────────────────────

describe('R4 /ws upgrade: password-less deployments keep the open hub', (): void => {
  it('no auth at all: open upgrade (no-auth deployments)', async (): Promise<void> => {
    const s = await server({ password: undefined });
    const ws = await tryConnect(s.port);
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });
});

// ── password on (token absent) → cookie-gated hub ────────────────────

describe('R4 /ws upgrade: password-only deployment', (): void => {
  it('anonymous upgrade rejects (401); a browser session cookie grants it', async (): Promise<void> => {
    const s = await server({ password: PASSWORD });
    await expectRejected(s.port, {});
    const cookie = await loginCookie(s);
    const ws = await tryConnect(s.port, { headers: { cookie } });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });
});
