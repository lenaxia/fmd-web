/**
 * Local mock server cluster for the smoke suite's network-unavailable
 * fallback (task contract requirement 2): when the worker environment
 * cannot reach the seed sites, the SAME code path (PacedResolver →
 * host-mapped live curl resolver → real §5.4 pipeline → real modules →
 * contract dispatcher) is verified end-to-end against loopback servers
 * that emulate the site families (fixture pages, a login gate, a
 * Cloudflare-style 403, plus D18 probe routes).
 *
 * ARCHITECTURE NOTE: the servers run in a WORKER THREAD. The live
 * resolver fetch is a synchronous `spawnSync` curl on the caller's
 * thread — a same-thread node:http server could never accept() while
 * that call blocks, so every request would stall until the curl
 * max-time. A worker's independent event loop serves the connection
 * while the main thread is inside spawnSync. Loopback-only by
 * construction (127.0.0.1 ephemeral ports) so the vitest zero-network
 * guard stays green; the §5.4 egress policy must be constructed with
 * `{ allow: ['127.0.0.1'] }` for mock runs — that is `mockEgress()`.
 */

import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import { RecordedResponseResolver } from '../../src/engine/shims/http-shim.js';
import type { SiteDef } from './sites.js';
import type { SmokeResolver } from './pacing.js';

/** The §5.4 egress policy for loopback mock runs (default denies RFC1918 + loopback). */
export function mockEgress(): EgressPolicy {
  return new EgressPolicy({ allow: ['127.0.0.1'] });
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  protobuf: 'application/octet-stream',
};

/** Raw bytes the module should see for a route (structured-cloneable). */
export interface MockRoute {
  readonly path: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * Bodyless 403 — the deterministic hard-gate shape. FMD2 GET semantics
 * are `success = Size > 0` (httpsendthread.pas): an error page WITH a
 * body would count as a successful GET and parse to an empty result;
 * an empty body drives the module's net_problem branch (the honest
 * "blocked/unauthenticated" outcome the suite expects to classify).
 */

/** Deterministic binary garbage: not any known codec magic, high-bit heavy. */
const UNDECODABLE_GARBAGE = Buffer.from([
  0x4b, 0x1f, 0xd3, 0xa9, 0x02, 0xfe, 0x88, 0x41, 0x00, 0xd7, 0x93, 0x55, 0xbb, 0x6e, 0x21, 0x0c,
  0x77, 0x9a, 0xe4, 0x3f, 0x10, 0x8c, 0x66, 0xd2, 0x0a, 0xf5, 0x39, 0x71, 0xcb, 0x84, 0x5d, 0xe2,
]);

/** Build one mock server's route table from a site + its seed fixture. */
function routesForSite(seedDir: string, site: SiteDef): MockRoute[] {
  if (site.mock === 'login-gate' || site.mock === 'cloudflare-403') {
    return [
      {
        path: '*',
        status: 403,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.alloc(0),
      },
    ];
  }
  // Default: serve the module's own seed fixture (the corpus-captured
  // page) at every path — GetInfo parses whatever shape the module
  // requests; honest parse outcomes are the point, not forced passes.
  const manifest = JSON.parse(
    readFileSync(join(seedDir, site.name, 'manifest.json'), 'utf8'),
  ) as { entries: readonly { file: string; kind: string }[] };
  const entry = manifest.entries[0];
  if (entry === undefined) {
    throw new Error(`seed fixture missing for ${site.name}`);
  }
  return [
    {
      path: '*',
      status: 200,
      contentType: CONTENT_TYPES[entry.kind] ?? 'application/octet-stream',
      body: readFileSync(join(seedDir, site.name, entry.file)),
    },
  ];
}

/**
 * D18 probe routes — crafted responses for the detector, shaped after
 * curl 7.88's verified decode behavior:
 * - `/undecodable-gzip-claimed`: an ADVERTISED encoding (gzip) with
 *   garbage bytes — curl dies with error 61 mid-decode, the resolver
 *   salvages the headers, and the observation (2xx + claimed gzip +
 *   undecodable empty body) is exactly the D18 undecoded-body shape
 *   (a curl build without zstd hits this same shape on real zstd
 *   responses).
 * - `/unadvertised-br`: a VALID brotli body — curl decodes it fine;
 *   when the request advertises only `gzip, deflate` the claim is
 *   unadvertised → the informational D18 probe signal.
 * - `/clean-gzip`: a valid gzip body under a full advertisement — the
 *   negative control (no finding).
 */
function d18ProbeRoutes(): MockRoute[] {
  return [
    {
      path: '/undecodable-gzip-claimed',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: UNDECODABLE_GARBAGE,
      extraHeaders: { 'Content-Encoding': 'gzip' },
    },
    {
      path: '/unadvertised-br',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: brotliCompressSync(Buffer.from('<html>hello d18 br probe</html>', 'utf8')),
      extraHeaders: { 'Content-Encoding': 'br' },
    },
    {
      path: '/clean-gzip',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: gzipSync(Buffer.from('hello smoke d18 clean probe', 'utf8')),
      extraHeaders: { 'Content-Encoding': 'gzip' },
    },
  ];
}

export interface MockCluster {
  /** real origin ('https://host') → loopback origin ('http://127.0.0.1:port'). */
  readonly urlMap: Readonly<Record<string, string>>;
  /** site name → bound port; '__d18probe' for the probe server. */
  readonly ports: Readonly<Record<string, number>>;
  dispose(): void;
}

/**
 * The worker's serving loop (CJS eval source — no TS pipeline in the
 * worker): binds every spec's server on 127.0.0.1 ephemeral ports,
 * reports the bound ports, then serves until terminated. Route match:
 * exact path, else the '*' catch-all, else 404 (a real offline
 * degrade shape).
 */
const WORKER_SOURCE = `
const { createServer } = require('node:http');
const { workerData, parentPort } = require('node:worker_threads');
const specs = workerData;
const servers = [];
const ports = {};
let remaining = specs.length;
for (const spec of specs) {
  const server = createServer((req, res) => {
    const route = spec.routes.find((r) => r.path === '*' || r.path === req.url);
    if (route === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found (mock)');
      return;
    }
    const headers = { 'Content-Type': route.contentType, ...(route.extraHeaders ?? {}) };
    res.writeHead(route.status, headers);
    res.end(route.body);
  });
  server.listen(0, '127.0.0.1', () => {
    ports[spec.key] = server.address().port;
    remaining -= 1;
    if (remaining === 0) {
      parentPort.postMessage({ type: 'ready', ports });
    }
  });
  servers.push(server);
}
`;

/**
 * Start the cluster: one worker thread hosting every suite site's mock
 * server (+ the D18 probe server).
 */
export async function startMockCluster(seedDir: string, sites: readonly SiteDef[]): Promise<MockCluster> {
  const specs = [
    ...sites.map((site) => ({
      key: site.name,
      origin: new URL(site.url).origin,
      routes: routesForSite(seedDir, site),
    })),
    { key: '__d18probe', origin: 'http://d18.probe.invalid', routes: d18ProbeRoutes() },
  ];
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: specs });
  const ports = await new Promise<Record<string, number>>((resolve, reject) => {
    worker.once('message', (msg: { type: string; ports?: Record<string, number> }) => {
      if (msg.type === 'ready' && msg.ports !== undefined) {
        resolve(msg.ports);
      } else {
        reject(new Error(`mock worker sent unexpected message: ${JSON.stringify(msg)}`));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`mock worker exited before binding (code ${code})`));
      }
    });
  });

  const urlMap: Record<string, string> = {};
  for (const spec of specs) {
    const port = ports[spec.key];
    if (port === undefined) {
      throw new Error(`mock worker did not report a port for ${spec.key}`);
    }
    urlMap[spec.origin] = `http://127.0.0.1:${port}`;
  }

  return {
    urlMap,
    ports: Object.freeze({ ...ports }),
    dispose(): void {
      void worker.terminate();
    },
  };
}

/**
 * Host-mapping resolver: rewrites known real origins to the loopback
 * cluster before the live curl resolver fires. Unknown origins pass
 * through unchanged (curl then fails honestly → transport classification).
 * Sits INSIDE the PacedResolver so pacing/D18/request-log evidence keys
 * on the REAL site URLs.
 */
export class MockClusterResolver extends RecordedResponseResolver {
  constructor(
    private readonly inner: SmokeResolver,
    private readonly mapping: Readonly<Record<string, string>>,
  ) {
    super([]);
  }

  override resolve(
    method: string,
    url: string,
    body: string,
    mimeType: string,
    headers: Readonly<Record<string, string>>,
  ): ReturnType<SmokeResolver['resolve']> {
    try {
      const parsed = new URL(url);
      const mapped = this.mapping[parsed.origin];
      if (mapped !== undefined) {
        return this.inner.resolve(
          method,
          mapped + parsed.pathname + parsed.search,
          body,
          mimeType,
          headers,
        );
      }
    } catch {
      // fall through to the original URL
    }
    return this.inner.resolve(method, url, body, mimeType, headers);
  }
}
