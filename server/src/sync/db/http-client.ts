/**
 * Rate-budgeted catalog HTTP layer (DESIGN.md §6.1–§6.2): every request
 * passes the token bucket (10 req/s, burst 50) before hitting the wire.
 * Blob fetches are conditional (ETag / If-None-Match) — a 304 skips the
 * download entirely, so unchanged catalogs cost one round-trip header.
 *
 * The transport is injectable for offline integration tests (loopback
 * mock raw.githubusercontent server); the default is global `fetch`.
 */
import type { SyncClock, TokenBucket } from './rate-budget.js';

export interface SyncHttpOptions {
  /** Auth (GitHub API needs a token for real rate limits; anonymous ok
   * for low-volume deployments). */
  readonly token?: string;
  readonly userAgent?: string;
  /** Timeout per request in ms. */
  readonly timeoutMs?: number;
}

/** Minimal response projection the sync layer consumes. */
export interface SyncHttpResponse {
  readonly status: number;
  readonly etag: string;
  readonly body: Buffer;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SyncHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly budget: TokenBucket,
    private readonly clock: SyncClock,
    options: SyncHttpOptions = {},
    fetchImpl?: FetchLike,
  ) {
    this.token = options.token;
    this.userAgent = options.userAgent ?? 'fmd-web catalog sync';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  }

  /** GET JSON (commits API) under the rate budget. A non-empty `etag`
   * rides as If-None-Match — a 304 returns `data: null` without a body
   * (FMD2 parity: GitHubRepoV3 last_commit_etag). */
  async getJson(url: string, etag: string = ''): Promise<{ data: unknown; etag: string; status: number }> {
    const headers: Record<string, string> = {};
    if (etag !== '') {
      headers['If-None-Match'] = etag;
    }
    const res: SyncHttpResponse = await this.request(url, headers);
    if (res.status === 304) {
      return { data: null, etag: res.etag, status: 304 };
    }
    const text: string = res.body.toString('utf8');
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch (err: unknown) {
      throw new Error(`sync: malformed JSON from ${sanitizeUrl(url)}: ${String((err as Error).message)}`);
    }
    return { data, etag: res.etag, status: res.status };
  }

  /**
   * Conditional GET of a catalog blob. `etag` (from a previous response)
   * rides as If-None-Match; status 304 means unchanged (body empty).
   * 403/429 surfaces GitHub rate-limit responses as a typed error so the
   * batch can stop cleanly and stay resumable.
   */
  async getBlob(url: string, etag: string): Promise<SyncHttpResponse> {
    const headers: Record<string, string> = {};
    if (etag !== '') {
      headers['If-None-Match'] = etag;
    }
    const res: SyncHttpResponse = await this.request(url, headers);
    if (res.status === 403 || res.status === 429) {
      throw new RateLimitedError(sanitizeUrl(url), res.status);
    }
    if (res.status !== 200 && res.status !== 304) {
      throw new Error(`sync: blob fetch failed (${sanitizeUrl(url)}): HTTP ${String(res.status)}`);
    }
    return res;
  }

  private async request(url: string, extraHeaders: Record<string, string>): Promise<SyncHttpResponse> {
    await this.budget.acquire(1);
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/vnd.github+json, application/octet-stream, */*',
      ...extraHeaders,
    };
    if (this.token !== undefined) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const controller: AbortController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const res: Response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      const body: Buffer = Buffer.from(await res.arrayBuffer());
      const etagHeader: string | null = res.headers.get('etag');
      return {
        status: res.status,
        etag: etagHeader === null ? '' : etagHeader.trim(),
        body,
      };
    } finally {
      clearTimeout(timer);
      // Keep the clock dependency meaningful for budget pacing tests:
      // the bucket alone paces; this anchor documents the pairing.
      void this.clock.now();
    }
  }
}

/** Stable message prefix of rate-limit failures (§6.1 batch stop). */
export const RATE_LIMIT_MESSAGE_PREFIX = 'sync: rate limited';

/** GitHub-shaped rate-limit failure (403 with rate body, or 429). The
 * batch keeps its pending set and stops — resumable on the next run. */
export class RateLimitedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${RATE_LIMIT_MESSAGE_PREFIX} (HTTP ${String(status)}) at ${url}`);
    this.name = 'RateLimitedError';
  }
}

/** Strip query strings from URLs in error text (no token leakage). */
function sanitizeUrl(url: string): string {
  const q: number = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
