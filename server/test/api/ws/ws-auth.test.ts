/**
 * R4 /ws upgrade auth (real loopback WebSockets, offline), updated for
 * the token-only world (owner decision 2026-11): the optional-password
 * credential wall is REMOVED — the hub is open. Browser live tiles
 * connect with no credentials; `Authorization: Bearer` and `?token=`
 * remain accepted spellings for script clients (they authenticate, a
 * credential is never demanded).
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

interface Running {
  readonly app: FastifyInstance;
  readonly hub: WsHub;
  readonly port: number;
  close(): Promise<void>;
}

async function startServer(auth?: AuthConfig): Promise<Running> {
  const hub = new WsHub({ tickIntervalMs: 0 });
  const harness = buildHarness({ ...(auth !== undefined ? { auth } : {}), wsHub: hub });
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

const servers: Running[] = [];
async function server(auth?: AuthConfig): Promise<Running> {
  const s = await startServer(auth);
  servers.push(s);
  return s;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
  }
});

// ── open hub: no credential is ever demanded ─────────────────────────

describe('R4 /ws upgrade: open hub (token-only world)', (): void => {
  it('browser live tiles connect with NO credentials, token configured or not', async (): Promise<void> => {
    const withToken = await server({ apiToken: TOKEN });
    const ws = await tryConnect(withToken.port);
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(withToken.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();

    const withoutToken = await server();
    const ws2 = await tryConnect(withoutToken.port);
    ws2.send(JSON.stringify({ type: 'hello' }));
    const id2 = publish(withoutToken.hub);
    expect((await nextFrame(ws2)).id).toBe(id2);
    ws2.close();
  });

  it('the Authorization header is accepted (and serves the hub)', async (): Promise<void> => {
    const s = await server({ apiToken: TOKEN });
    const ws = await tryConnect(s.port, { headers: { authorization: `Bearer ${TOKEN}` } });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });

  it('the ?token= query param still connects (browser WS clients)', async (): Promise<void> => {
    const s = await server({ apiToken: TOKEN });
    const ws = await tryConnect(s.port, { path: `/ws?token=${TOKEN}` });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });

  it('a WRONG or stale token never rejects the handshake (a credential only labels, never gates)', async (): Promise<void> => {
    const s = await server({ apiToken: TOKEN });
    const ws = await tryConnect(s.port, { headers: { authorization: `Bearer ${'b'.repeat(64)}` } });
    ws.send(JSON.stringify({ type: 'hello' }));
    const id = publish(s.hub);
    expect((await nextFrame(ws)).id).toBe(id);
    ws.close();
  });
});
