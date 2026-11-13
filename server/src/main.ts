import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import type { HealthStatus, ReadinessStatus } from '@fmd/contract';

/**
 * Placeholder server entry point (Phase-0 scaffold).
 *
 * Serves /healthz + /readyz so the Docker image has a real (if minimal)
 * non-root process with a healthcheck target. Fastify routes, WS hub,
 * engine and jobs arrive in later stories (DESIGN.md §10–§11).
 */

export const SERVER_VERSION: string = '0.1.0';
export const DEFAULT_PORT: number = 3000;

/** Bounded shutdown: SIGTERM drains, hard exit after this many ms (§4). */
export const SHUTDOWN_TIMEOUT_MS: number = 5_000;

export function respond(req: IncomingMessage, res: ServerResponse): void {
  const url: string = req.url ?? '/';
  if (url === '/healthz') {
    const body: HealthStatus = { status: 'ok', version: SERVER_VERSION };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  if (url === '/readyz') {
    const body: ReadinessStatus = { ready: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

export function createServer(): Server {
  return createHttpServer(respond);
}

export function startServer(port: number = DEFAULT_PORT): Server {
  const server: Server = createServer();
  server.listen(port);
  process.on('SIGTERM', (): void => {
    server.close((): void => {
      process.exit(0);
    });
    // Never hang the drain past the bound (§4 graceful shutdown).
    setTimeout((): void => {
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  });
  return server;
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(invoked).href
) {
  const port: number =
    process.env['PORT'] !== undefined && process.env['PORT'] !== ''
      ? Number.parseInt(process.env['PORT'], 10)
      : DEFAULT_PORT;
  startServer(port);
}
