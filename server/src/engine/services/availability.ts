/**
 * Site availability (dead-site discovery, tsk-amber-pivot-refrains):
 * the ONE classification seam shared by every opportunistic traffic
 * path (GetInfo, directory walk, download hooks) and the manual
 * registry Check probe. Classification reuses the §5.2 dispatch
 * readback surface — the request-scoped HTTP ResultCode/ResultString
 * the 6beb4d5 attribution already surfaces — and is CONSERVATIVE and
 * one-directional per confidence:
 *
 * - transport-class failures (DNS, connect refused, timeout, TLS —
 *   the pipeline's synthetic HTTP 500 + transport error text) and the
 *   real HTTP 5xx/523 family (Cloudflare origin-unreachable) →
 *   `unreachable` + a short reason;
 * - 2xx/3xx answers → `reachable` (a later success flips an
 *   `unreachable` record back automatically — self-healing by
 *   construction, no timers);
 * - HTTP 4xx (403/429 anti-bot, rate-limit, a parked domain's 405
 *   lander) → NO verdict: the origin is alive but possibly blocking;
 *   the record is left untouched;
 * - ResultCode 0 / unreadable (no HTTP use, abort, egress-policy
 *   deny — OUR policy, never site health) → NO verdict.
 *
 * The transport-refusal prefixes below mirror the wire-level logging
 * filter in http-transport.ts: those synthetic 500s are platform
 * policy (loopback gating, scheme refusal, buffer caps), not origin
 * state, and must never mark a site dead.
 */

/** What a classified HTTP outcome asks the record to become. */
export interface SiteAvailabilityOutcome {
  readonly verdict: 'reachable' | 'unreachable';
  /** Short human reason (unreachable only; capped). */
  readonly reason?: string;
}

/** Sink shape every engine service accepts (fire-and-forget, never throws). */
export type AvailabilitySink = (moduleId: string, outcome: SiteAvailabilityOutcome) => void;

/** Engine-side policy refusals — platform, not origin (see module doc). */
const TRANSPORT_POLICY_PREFIXES: readonly string[] = [
  'loopback transport refuses',
  'transport supports http/https only',
  'response exceeds the loopback result buffer',
];

const REASON_MAX_CHARS = 160;

function shortReason(resultString: string, resultCode: number): string {
  const text = resultString.trim().replace(/\s+/g, ' ');
  if (text === '') {
    return `HTTP ${String(resultCode)}`;
  }
  return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS - 1)}…` : text;
}

/**
 * Classify one HTTP outcome from the §5.2 request-scoped readback
 * (HTTP.ResultCode/ResultString after a dispatch, or the probe
 * pipeline's final state). Pure; returns undefined when the outcome
 * carries no confident verdict (record unchanged).
 */
export function classifyHttpOutcome(
  resultCode: number,
  resultString: string,
): SiteAvailabilityOutcome | undefined {
  if (!Number.isFinite(resultCode)) {
    return undefined;
  }
  const code = Math.trunc(resultCode);
  if (code >= 500) {
    // The pipeline maps transport failures onto a synthetic 500 with
    // the transport's error text (6beb4d5); real 5xx/523 answers keep
    // their status line. Both are origin-trouble EXCEPT the engine's
    // own policy refusals.
    const text = resultString.trim();
    if (TRANSPORT_POLICY_PREFIXES.some((prefix): boolean => text.startsWith(prefix))) {
      return undefined;
    }
    return { verdict: 'unreachable', reason: shortReason(resultString, code) };
  }
  if (code >= 200 && code < 400) {
    return { verdict: 'reachable' };
  }
  return undefined;
}

/**
 * Best-effort readback of the request-scoped HTTP object after a
 * dispatch (the httpFailureDetail seam, factored): the engine global
 * `HTTP` survives the dispatch, so ResultCode/ResultString name the
 * last hop. Returns undefined when nothing readable is there (module
 * never touched HTTP, or the env was cleared).
 */
export function readHttpOutcome(
  runLua: (code: string) => unknown,
): { readonly resultCode: number; readonly resultString: string } | undefined {
  try {
    const code = Number(runLua('return HTTP.ResultCode'));
    const text = String(runLua('return HTTP.ResultString') ?? '');
    if (!Number.isFinite(code)) {
      return undefined;
    }
    return { resultCode: code, resultString: text };
  } catch {
    return undefined;
  }
}

/** Serialize an outcome for the engine-thread wire (plain JSON). */
export interface SerializedAvailabilityOutcome {
  readonly moduleId: string;
  readonly verdict: 'reachable' | 'unreachable';
  readonly reason?: string;
}

export function serializeOutcome(
  moduleId: string,
  outcome: SiteAvailabilityOutcome,
): SerializedAvailabilityOutcome {
  return {
    moduleId,
    verdict: outcome.verdict,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

// ── manual Check probe (Settings registry row) ───────────────────────

import { ApiError } from '@fmd/contract';
import { CookieJar, CookieStore } from '../shims/http-cookies.js';
import { HttpPipeline } from '../shims/http-pipeline.js';
import type { EgressPolicy, HttpTransportPort } from '../shims/http-shim.js';
import type { RawProxy } from '../shims/http-transport.js';
import type { ProxyConfig } from '../shims/http-proxy.js';
import type { RegistrationRecord } from '../registry/capabilities.js';

export interface RootUrlProbeOptions {
  readonly transport: HttpTransportPort;
  readonly egress: EgressPolicy;
  /** Registry rows (the RootURL source — the module's own address). */
  readonly modules: readonly RegistrationRecord[];
  readonly moduleId: string;
  /** Settings-resolved proxy (the module's effective posture). */
  readonly proxy?: ProxyConfig;
}

/**
 * ONE manual probe of the module RootURL through the module's own HTTP
 * path — the §5.4 HttpPipeline over the engine transport (DEFAULT
 * engine User-Agent, Referer = RootURL for hotlink-checked landers,
 * the settings-resolved proxy). Synchronous by the pipeline's nature:
 * run it on the engine worker thread in production (the caller owns
 * that placement). Throws typed ApiErrors for address problems; a
 * completed probe ALWAYS returns its raw outcome (classification is
 * the caller's one seam).
 */
export function runRootUrlProbe(options: RootUrlProbeOptions): {
  readonly resultCode: number;
  readonly resultString: string;
} {
  const registration = options.modules.find((m) => m.id === options.moduleId);
  if (registration === undefined) {
    throw new ApiError(404, 'not_found', `unknown module: ${options.moduleId}`);
  }
  const rootUrl = registration.rootURL.trim();
  if (!/^https?:\/\//i.test(rootUrl)) {
    throw new ApiError(
      400,
      'validation_error',
      `module ${options.moduleId} has no http(s) RootURL to probe (got ${JSON.stringify(rootUrl)})`,
    );
  }
  const proxy = options.proxy;
  const pipeline = new HttpPipeline({
    transport: options.transport,
    egress: options.egress,
    cookies: new CookieStore(new CookieJar()),
    isTerminated: (): boolean => false,
    ...(proxy !== undefined && proxy.type !== '' && proxy.host !== ''
      ? {
          proxyProvider: (): RawProxy => ({
            type: proxy.type === 'HTTP' ? 'HTTP' : proxy.type === 'SOCKS4' ? 'SOCKS4' : 'SOCKS5',
            host: proxy.host,
            port: proxy.port,
            user: proxy.user,
            pass: proxy.pass,
          }),
        }
      : {}),
  });
  // Module-appropriate posture: the engine default User-Agent rides the
  // pipeline; Referer = RootURL mirrors the module HTTP objects' own
  // referer behavior on hotlink-checked origins.
  pipeline.headers.set('Referer', rootUrl);
  pipeline.get(rootUrl);
  return { resultCode: pipeline.resultCode, resultString: pipeline.resultString };
}
