import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildApp, type ApiServices, type AppOptions, DEFAULT_INFO_CACHE_TTL_MS } from './api/app.js';
import {
  InMemoryFavoriteService,
  InMemoryJobService,
  InMemoryLibraryService,
  InMemoryModuleService,
  type CatalogService,
  type FavoriteService,
  type InfoService,
  type JobService,
  type LibraryService,
  type SyncService,
} from './api/services.js';
import type { HealthStatus, ReadinessStatus } from '@fmd/contract';

/**
 * Server entry point. The ONE §10 Fastify app (`buildApp`) powers both
 * real sockets (raw http bridged through `app.inject` — same code path
 * the integration tests exercise) and the Docker healthcheck targets.
 *
 * The default service assembly is the in-memory stand-in bundle until
 * the db/engine runtime stories wire the SQLite adapters; /healthz and
 * /readyz are fully functional from boot (Phase-0 contract kept).
 */

export const SERVER_VERSION: string = '0.1.0';
export const DEFAULT_PORT: number = 3000;

/** Bounded shutdown: SIGTERM drains, hard exit after this many ms (§4). */
export const SHUTDOWN_TIMEOUT_MS: number = 5_000;

export interface DefaultServicesOptions {
  readonly modules?: ApiServices['modules'];
  readonly catalogs?: CatalogService;
  readonly info?: InfoService;
  readonly jobs?: JobService;
  readonly sync?: SyncService;
  readonly library?: LibraryService;
  readonly favorites?: FavoriteService;
  readonly readiness?: () => ReadinessStatus;
}

/** Production service assembly (placeholder adapters until the db/engine wiring lands). */
export function createDefaultServices(opts: DefaultServicesOptions = {}): ApiServices {
  return {
    modules: opts.modules ?? new InMemoryModuleService([]),
    catalogs: opts.catalogs ?? {
      getMeta: (): undefined => undefined,
      latest: (): never => {
        throw new Error('no catalogs installed');
      },
      byTitle: (): never => {
        throw new Error('no catalogs installed');
      },
      search: (): never => {
        throw new Error('no catalogs installed');
      },
    },
    info: opts.info ?? {
      getInfo: async (): Promise<never> => {
        throw new Error('info engine not wired yet');
      },
    },
    jobs: opts.jobs ?? new InMemoryJobService(),
    library: opts.library ?? new InMemoryLibraryService(),
    favorites: opts.favorites ?? new InMemoryFavoriteService(),
    sync: opts.sync ?? {
      syncModules: async (): Promise<never> => {
        throw new Error('sync engine not wired yet');
      },
      syncCatalog: async (): Promise<never> => {
        throw new Error('catalog sync not wired yet');
      },
      syncAllCatalogs: async (): Promise<readonly never[]> => [],
    },
    ...(opts.readiness !== undefined ? { readiness: opts.readiness } : {}),
  };
}

export function createApp(services: ApiServices = createDefaultServices()): ReturnType<typeof buildApp> {
  const options: AppOptions = {
    version: SERVER_VERSION,
    ...(process.env['FMD_WEB_PASSWORD'] !== undefined && process.env['FMD_WEB_PASSWORD'] !== ''
      ? { auth: { password: process.env['FMD_WEB_PASSWORD'] } }
      : {}),
    infoCacheTtlMs: DEFAULT_INFO_CACHE_TTL_MS,
  };
  return buildApp(services, options);
}

interface BufferedRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolveBody): void => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer): void => {
      chunks.push(chunk);
    });
    req.on('end', (): void => {
      resolveBody(chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (): void => {
      resolveBody(undefined);
    });
  });
}

/**
 * Raw-http → Fastify bridge: every request (healthcheck included) runs
 * through the same app the inject tests cover.
 */
export async function respondAsync(app: ReturnType<typeof buildApp>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: string | undefined = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const injected: BufferedRequest = {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    ...(body !== undefined ? { body } : {}),
  };
  const reply = await app.inject({
    method: injected.method as 'GET',
    url: injected.url,
    headers: { ...req.headers } as Record<string, string>,
    ...(injected.body !== undefined
      ? { payload: injected.body }
      : {}),
  });
  const headers = reply.headers;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      res.setHeader(name, value);
    }
  }
  res.statusCode = reply.statusCode;
  // rawPayload (Buffer) keeps binary-exact bodies (static assets); the
  // string payload is the fallback for inject responses without one.
  const raw = (reply as { rawPayload?: unknown }).rawPayload;
  res.end(raw instanceof Buffer ? raw : reply.payload);
}

export function respond(app: ReturnType<typeof buildApp>): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void respondAsync(app, req, res);
  };
}

export function createServer(services: ApiServices = createDefaultServices()): Server {
  const app = createApp(services);
  return createHttpServer(respond(app));
}

export function startServer(port: number = DEFAULT_PORT, services: ApiServices = createDefaultServices()): Server {
  const server = createServer(services);
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

export type { HealthStatus, ReadinessStatus, ApiServices, AppOptions };
export { DEFAULT_INFO_CACHE_TTL_MS };
