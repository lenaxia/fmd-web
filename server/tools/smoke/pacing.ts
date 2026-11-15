/**
 * Rate limiting + fixed-UA enforcement for the live smoke suite
 * (DESIGN.md §13.2): every suite run paces requests to ≥1 per second
 * per SITE (host) and stamps a FIXED User-Agent on every request so
 * runs are comparable and operators can identify smoke traffic
 * upstream. The harness's own request log is the evidence surface:
 * `assertRequestLog` re-checks both invariants over the recorded
 * entries and the report carries the violations list (empty = clean).
 *
 * Documented divergence (suite-only): the fixed UA REPLACES whatever
 * the pipeline/module set — the suite is an observability run, not a
 * compatibility gate, and a stable identity is worth more to it than
 * per-module UA parity.
 */

import { RecordedResponseResolver, type ResolvedRecordedResponse } from '../../src/engine/shims/http-shim.js';
import { bodyLooksLikeText, type D18Observation } from './d18.js';

/** Fixed UA — documented in runbook.md; sites see one stable identity. */
export const SMOKE_USER_AGENT =
  'fmd-web-live-smoke/1.0 (opt-in nightly suite; DESIGN.md §13.2; not a browser)';

/** Default per-site pacing: 1 request per second (task contract). */
export const DEFAULT_MIN_GAP_MS = 1000;

/**
 * Synchronous sleep for the synchronous §5.4 facade: the resolver
 * protocol has no async surface, so pacing blocks the CLI thread via
 * Atomics.wait (the live fetch itself is a synchronous curl subprocess
 * already — the event loop is not serving anything else mid-run).
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + ms;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    try {
      Atomics.wait(cell, 0, 0, remaining);
    } catch {
      const spinUntil = deadline;
      while (Date.now() < spinUntil) {
        /* degrade to busy-wait where Atomics.wait is unavailable */
      }
      return;
    }
  }
}

/** One entry of the harness's own request log (the evidence surface). */
export interface RequestLogEntry {
  readonly ts: string;
  readonly method: string;
  /** The URL the harness was asked for (pre host-mapping — stable IDs). */
  readonly url: string;
  readonly host: string;
  /** Response status (0 = transport failure: DNS/TLS/timeout/curl). */
  readonly status: number;
  readonly userAgent: string;
  /** Wall clock of the request (curl subprocess window). */
  readonly durationMs: number;
}

/** Extract host from a URL — unknown shapes degrade to '(unparsed)'. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparsed)';
  }
}

/**
 * Invariant check over the harness's own request log: every entry used
 * the fixed UA and every same-host pair is ≥`minGapMs` apart (the
 * 1 req/s per site contract). Returns human-readable violations —
 * an empty array is the clean-run assertion.
 */
export function assertRequestLog(
  entries: readonly RequestLogEntry[],
  options: { readonly minGapMs: number; readonly userAgent: string },
): string[] {
  const violations: string[] = [];
  const lastPerHost = new Map<string, number>();
  for (const entry of entries) {
    if (entry.userAgent !== options.userAgent) {
      violations.push(
        `UA violation: ${entry.method} ${entry.url} sent "${entry.userAgent}" (expected "${options.userAgent}")`,
      );
    }
    const last = lastPerHost.get(entry.host);
    if (last !== undefined) {
      const gap = Date.parse(entry.ts) - last;
      if (gap < options.minGapMs) {
        violations.push(
          `rate violation: ${entry.method} ${entry.url} fired ${gap}ms after the previous request to ${entry.host} (min ${options.minGapMs}ms)`,
        );
      }
    }
    lastPerHost.set(entry.host, Date.parse(entry.ts));
  }
  return violations;
}

/**
 * The wire-truth Accept-Encoding for requests that carry no explicit
 * header: with `--compressed`, curl injects its own built-in list —
 * for this environment's curl build (7.88, features brotli zstd) that
 * is `gzip, deflate, br, zstd`. Recording this as the advertisement
 * keeps the D18 detector honest: a gzip answer to a request we never
 * explicitly advertised is NOT an unadvertised-encoding finding, and
 * a zstd answer on such requests was legitimately negotiated (curl
 * decodes it). The D18-relevant scenario (app advertises
 * gzip,deflate,br; server answers zstd) rides the pipeline's explicit
 * `Accept-Encoding` header (D13) and stays fully detectable.
 */
export const CURL_COMPRESSED_DEFAULT_ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

/** Minimal resolver protocol both transports satisfy (§5.4 shim). */
export interface SmokeResolver {
  resolve(
    method: string,
    url: string,
    body: string,
    mimeType: string,
    headers: Readonly<Record<string, string>>,
  ): ResolvedRecordedResponse;
}

/**
 * Paced + UA-stamped resolver wrapper. Wraps ANY resolver satisfying
 * the §5.4 protocol (the live curl resolver; the mock host-mapping
 * resolver for loopback runs) and enforces, per SITE host:
 *   ≥ minGapMs since the last request to the same host,
 * plus the FIXED UA on every request. D18 observations and the request
 * log ride the wrapper so evidence survives regardless of transport.
 */
export class PacedResolver extends RecordedResponseResolver implements SmokeResolver {
  readonly requestLog: RequestLogEntry[] = [];
  readonly d18Observations: D18Observation[] = [];
  /** Transport-level failures (status 0) — per-host keyed. */
  readonly transportFailuresByHost = new Map<string, number>();
  private readonly lastPerHost = new Map<string, number>();

  constructor(
    private readonly inner: SmokeResolver,
    private readonly minGapMs: number = DEFAULT_MIN_GAP_MS,
  ) {
    // No recorded entries — this wrapper always delegates to `inner`.
    super([]);
  }

  get transportFailureCount(): number {
    let n = 0;
    for (const count of this.transportFailuresByHost.values()) {
      n += count;
    }
    return n;
  }

  override resolve(
    method: string,
    url: string,
    body: string,
    mimeType: string,
    headers: Readonly<Record<string, string>>,
  ): ResolvedRecordedResponse {
    const host = hostOf(url);
    const last = this.lastPerHost.get(host);
    if (last !== undefined) {
      sleepSync(this.minGapMs - (Date.now() - last));
    }
    // Fixed UA — FORCE (replaces pipeline/module values; documented).
    const stamped: Record<string, string> = { ...headers, 'User-Agent': SMOKE_USER_AGENT };
    const acceptEncoding = stamped['Accept-Encoding'] ?? CURL_COMPRESSED_DEFAULT_ACCEPT_ENCODING;
    const startedAt = Date.now();
    const response = this.inner.resolve(method, url, body, mimeType, stamped);
    const durationMs = Date.now() - startedAt;
    const ts = Date.now();
    this.lastPerHost.set(host, ts);
    this.requestLog.push({
      ts: new Date(ts).toISOString(),
      method,
      url,
      host,
      status: response.status,
      userAgent: SMOKE_USER_AGENT,
      durationMs,
    });
    if (response.status === 0) {
      this.transportFailuresByHost.set(host, (this.transportFailuresByHost.get(host) ?? 0) + 1);
    }
    const raw = Buffer.from(response.body, 'utf8');
    this.d18Observations.push({
      url,
      requestAcceptEncoding: acceptEncoding,
      responseContentEncoding: response.headers.get('Content-Encoding') ?? '',
      status: response.status,
      bodyFirstBytesHex: raw.subarray(0, 8).toString('hex'),
      bodyLooksText: bodyLooksLikeText(raw),
      bodyLength: raw.length,
    });
    return response;
  }
}
