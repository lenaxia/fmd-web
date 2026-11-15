/**
 * `/ws` transport wiring (DESIGN.md §10): attaches the D19 hub to any
 * node http(s) server via the `upgrade` event — no @fastify/websocket
 * dependency; `WebSocketServer({ noServer: true })` completes the
 * handshake for matching requests and everything else is rejected with
 * a plain-HTTP 404 so the socket never leaks.
 *
 * Frame flow: text frames → `hub.onMessage`, `close` → `hub.onClose`,
 * send/close/bufferedAmount adapt onto the hub's `HubSocket` seam (so
 * hub tests run without sockets at all).
 */
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WsHub, type HubSocket, type WsSubscription } from './hub.js';

export const DEFAULT_WS_PATH = '/ws';

export interface WsAttachOptions {
  /** Upgrade path handled by this hub (default `/ws`). */
  readonly path?: string;
  /**
   * Auth gate run BEFORE the handshake completes (default: allow all).
   * The §10 optional password auth hands its session-cookie check in
   * here; returning false (or rejecting) responds 401 and destroys the
   * socket.
   */
  readonly authenticate?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

function adaptSocket(ws: WebSocket): HubSocket {
  return {
    send: (data: string): void => {
      ws.send(data);
    },
    close: (code?: number, reason?: string): void => {
      ws.close(code, reason);
    },
    get bufferedAmount(): number {
      return ws.bufferedAmount;
    },
  };
}

function rejectUpgrade(socket: import('node:net').Socket, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export interface WsAttachment {
  /** Detach the upgrade handler, close all subscriber sockets + the hub. */
  dispose(): void;
}

/**
 * Wire `hub` onto `server`'s upgrade event. Returns a disposer (also
 * registered nowhere automatically — callers own the lifecycle; the
 * app-level wiring hooks Fastify's `onClose`).
 */
export function attachWebSocketHub(
  server: Server,
  hub: WsHub,
  options: WsAttachOptions = {},
): WsAttachment {
  const path = options.path ?? DEFAULT_WS_PATH;
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';
    if (pathname !== path) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    void Promise.resolve()
      .then(async () => options.authenticate?.(req) ?? true)
      .then((allowed: boolean) => {
        if (!allowed) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws: WebSocket): void => {
          const sub: WsSubscription = hub.connect(adaptSocket(ws));
          ws.on('message', (data: unknown): void => {
            hub.onMessage(sub, String(data));
          });
          ws.on('close', (): void => {
            hub.onClose(sub);
          });
          ws.on('error', (): void => {
            ws.close();
          });
        });
      })
      .catch(() => {
        rejectUpgrade(socket, 500, 'Internal Server Error');
      });
  };

  server.on('upgrade', onUpgrade);

  return {
    dispose(): void {
      server.off('upgrade', onUpgrade);
      wss.close();
      hub.close();
    },
  };
}
