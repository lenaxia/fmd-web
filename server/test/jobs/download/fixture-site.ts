import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

/**
 * LOCAL fixture manga site (DESIGN §13 offline discipline: loopback
 * only). node:http serving a RECORDED chapter page (a real corpus seed
 * body) and deterministic synthetic images, with the capture counters
 * the integration tests assert on: per-path request counts (resume
 * proof), a live in-flight concurrency tracker with the observed peak
 * (site-limiter proof), and deliberately misbehaving handlers —
 * flaky (500-then-200 per-image retry), route-changing (the image only
 * exists under the BeforeDownloadImage-rewritten path), and slow
 * (cancellable in-flight downloads).
 */

export interface CapturedRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly at: number;
}

/** A tiny valid JPEG-shaped payload, content varies by tag. */
function imageBytes(tag: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J'.charCodeAt(0), 'F'.charCodeAt(0)]),
    Buffer.alloc(96, tag & 0xff),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const RECORDED_PAGE_FIXTURE =
  '/workspace/fmd-web/corpus/fixtures/seed/Hentai2Read/source.html';

export interface FixtureSiteOptions {
  /** Latency for the deliberately slow /img/slowN handler (ms). */
  readonly slowDelayMs?: number;
  /** Latency for regular image responses (ms). */
  readonly minImageMs?: number;
}

export class FixtureMangaSite {
  readonly requests: CapturedRequest[] = [];
  /** Server-side in-flight counter (the limiter assertion source). */
  inflight = 0;
  /** Peak observed in-flight request count since start (or last reset). */
  maxInflight = 0;

  private server: http.Server | undefined;
  private readonly flakyHits = new Map<string, number>();
  private readonly slowDelayMs: number;
  private readonly minImageMs: number;

  constructor(options: FixtureSiteOptions = {}) {
    this.slowDelayMs = options.slowDelayMs ?? 80;
    this.minImageMs = options.minImageMs ?? 10;
  }

  /** Start listening; returns the http://127.0.0.1:port base URL. */
  async start(): Promise<string> {
    const server = http.createServer((req, res) => {
      this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, 500).unref();
    });
  }

  /** All requests served under `pathPrefix` so far. */
  countFor(pathPrefix: string): number {
    return this.requests.filter((r) => r.path.startsWith(pathPrefix)).length;
  }

  /**
   * Wait until every in-flight request handler has finished, then re-check
   * across an extra event-loop turn. Call after a job cancel BEFORE
   * sampling request counts: a cancelled in-flight request may already
   * have crossed the wire (the abort destroys the client socket, but
   * bytes already sent are still parsed server-side), so its arrival can
   * land a few event-loop turns after the client run settles. Waiting
   * for handler quiescence makes any arrival recorded after this resolve
   * deterministically part of the next run's window.
   */
  async waitSettled(timeoutMs = 4000, stepMs = 5): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (this.inflight === 0) {
        await new Promise((r) => setTimeout(r, stepMs)); // one more turn: late parses
        if (this.inflight === 0) {
          return;
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitSettled: handlers never quiesced');
      }
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  /** Distinct requested paths under `pathPrefix` (order preserved). */
  pathsFor(pathPrefix: string): string[] {
    return this.requests.filter((r) => r.path.startsWith(pathPrefix)).map((r) => r.path);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const captured: CapturedRequest = {
      path: req.url ?? '',
      headers: req.headers,
      at: Date.now(),
    };
    this.requests.push(captured);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);

    const pathOnly = (req.url ?? '').split('?')[0] ?? '';
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.inflight = Math.max(0, this.inflight - 1);
    };

    const sendImage = (tag: number): void => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(imageBytes(tag));
      finish();
    };

    const sendStatus = (status: number, body: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(body);
      finish();
    };

    const later = (ms: number, then: () => void): void => {
      setTimeout(() => {
        try {
          then();
        } finally {
          finish();
        }
      }, ms);
    };

    // Recorded chapter page (a real corpus seed body).
    if (pathOnly === '/manga/chapter-1') {
      let body: string;
      try {
        body = readFileSync(RECORDED_PAGE_FIXTURE, 'utf8');
      } catch {
        body = '<html><body>recorded page unavailable</body></html>';
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
      finish();
      return;
    }

    // /img/slowN — deliberately slow so cancellation aborts in-flight.
    const slowMatch = /^\/img\/slow(\d+)$/.exec(pathOnly);
    if (slowMatch !== null) {
      const tag = Number(slowMatch[1] ?? 0);
      later(this.slowDelayMs, () => {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(imageBytes(tag));
        }
      });
      return;
    }

    // /img/flakyN — 502 on the first hit, 200 afterwards (per-image retry;
    // the FMD2 transport retry covers `ResultCode > 500`, :623-629).
    const flakyMatch = /^\/img\/flaky(\d+)$/.exec(pathOnly);
    if (flakyMatch !== null) {
      const key = pathOnly;
      const tag = Number(flakyMatch[1] ?? 0);
      const hits = (this.flakyHits.get(key) ?? 0) + 1;
      this.flakyHits.set(key, hits);
      later(this.minImageMs, () => {
        if (hits === 1) {
          sendStatus(502, 'flaky failure');
        } else {
          sendImage(tag);
        }
      });
      return;
    }

    // /img/route-aN only exists under its REWRITTEN name — the module's
    // BeforeDownloadImage must rewrite the URL for the download to work.
    if (pathOnly === '/img/route-a7' || pathOnly === '/img/route-a9') {
      later(this.minImageMs, () => sendStatus(404, 'route changed'));
      return;
    }
    const routeMatch = /^\/img\/route-(a\d+)-v2$/.exec(pathOnly);
    if (routeMatch !== null) {
      const tag = (routeMatch[1] ?? 'a0').charCodeAt(1);
      later(this.minImageMs, () => sendImage(tag));
      return;
    }

    // /img/pN — the regular chapter images.
    const pageMatch = /^\/img\/p(\d+)$/.exec(pathOnly);
    if (pageMatch !== null) {
      const tag = Number(pageMatch[1] ?? 0);
      later(this.minImageMs, () => sendImage(tag));
      return;
    }

    sendStatus(404, 'not found');
  }
}
