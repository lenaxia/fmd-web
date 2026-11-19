/**
 * Auth (R4, owner decision 2026-11): the app performs exactly ONE
 * authentication — the single app-wide API token (docs/UX-PARITY.md
 * R4, the Sonarr/Radarr model). The former optional-password mode
 * (the password env var + session cookies + the login endpoint) is
 * REMOVED: no route is credential-walled, and `Authorization: Bearer
 * <token>` is a valid credential on EVERY /api route and the /ws
 * upgrade (header preferred; `?token=` query param for browser WS
 * clients). ONE token value, ever — no lists, no per-user/per-scope
 * variants (R2 single-operator). *arr auth-None semantics: the
 * deployment is open to the browser SPA (the pre-login/post-password
 * distinction no longer exists); the token is the script key.
 * Deployments that want user-facing auth front the app with
 * Authelia/Authentik/PocketID via their reverse proxy (docs/API.md).
 *
 * Gate ordering (unchanged invariant, now vacuous by construction —
 * pinned by server/test/api/static-pwa.test.ts): GETs are NEVER
 * credential-gated (no static asset or SPA shell can 401 from this
 * app), and there is no state-changing wall either — with the
 * password gate gone, nothing keys a 401; the token only ever
 * AUTHENTICATES (metrics label, wire acceptance), never gates.
 *
 * Token facts (R4, unchanged): 32-byte hex; auto-generated on first
 * start of EVERY unpinned deployment (no env pin, nothing stored — the
 * runtime assembly owns generation, `resolveApiTokenBootstrap`);
 * FMD_WEB_API_TOKEN pins it (precedence env > settings store, runbook
 * §API token); comparison is constant-time (SHA-256 fingerprints +
 * timingSafeEqual).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface AuthConfig {
  /**
   * R4 single app-wide API token: the EFFECTIVE value (env pin >
   * settings store — the runtime assembly composes the provider so
   * regeneration and env precedence apply to the next request with no
   * restart). A fixed string is accepted for tests/pins.
   */
  readonly apiToken?: string | (() => string | undefined) | undefined;
  /**
   * True when the effective value comes from the FMD_WEB_API_TOKEN env
   * pin: the settings UI shows 'Managed via environment' and the
   * regenerate route refuses (rotate by changing the env instead).
   */
  readonly apiTokenEnvPinned?: boolean | undefined;
}

/** How a request authenticated: the R4 metrics label vocabulary. */
export type AuthKind = 'none' | 'token';

/** Fixed-length SHA-256 fingerprint: constant-time compare for ANY input length. */
function tokenFingerprint(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** `Authorization: Bearer <token>` → the token (case-insensitive scheme). */
export function readBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return undefined;
  }
  const match = /^bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1];
}

/**
 * First-run token bootstrap (R4): the stored settings value and the env
 * pin resolve to the effective token + whether this boot generated one.
 * Generation is UNCONDITIONAL (no pin, nothing stored → generate): the
 * token is an *arr-style API key, not a password companion — every
 * deployment gets a script key on first run.
 */
export interface ApiTokenBootstrap {
  /** True when this boot generated the first token (persist it now). */
  readonly generated: boolean;
  /** True when the env pin wins (UI: 'Managed via environment'). */
  readonly envPinned: boolean;
  /** The stored value to persist NOW (generation writes it via the sink). */
  readonly store: string | null;
}

export function resolveApiTokenBootstrap(input: {
  readonly envPin: string | undefined;
  readonly stored: string | null;
  readonly generate?: () => string;
}): ApiTokenBootstrap {
  const generate = input.generate ?? ((): string => randomBytes(32).toString('hex'));
  const envPinned = input.envPin !== undefined && input.envPin !== '';
  if (envPinned) {
    // The pin OVERRIDES the store: no generation, no store write; the
    // secret lives in the deployment environment (rotate it there).
    return { generated: false, envPinned: true, store: input.stored };
  }
  if (input.stored !== null) {
    return { generated: false, envPinned: false, store: input.stored };
  }
  return { generated: true, envPinned: false, store: generate() };
}

/**
 * The single API token check (R4). Owns the bearer semantics — routes
 * never touch credentials directly. There is no gate to register: the
 * password flow (login route, session store, rate limiter, /ws
 * credential wall) was removed with the optional-password mode.
 */
export class AuthService {
  private readonly apiToken: (() => string | undefined) | undefined;
  private readonly tokenEnvPinned: boolean;

  constructor(config: AuthConfig) {
    // Local const: narrowing must survive the closure (property-access
    // narrowing resets inside callbacks — const does not).
    const providedToken = config.apiToken;
    this.apiToken =
      typeof providedToken === 'function' ? providedToken : ((): string | undefined => providedToken);
    this.tokenEnvPinned = config.apiTokenEnvPinned === true;
  }

  /** The effective single token value (env pin > settings, live). */
  effectiveApiToken(): string | undefined {
    const value = this.apiToken?.();
    return value === '' ? undefined : value;
  }

  /** True when the single token credential is available at all. */
  get tokenActive(): boolean {
    return this.effectiveApiToken() !== undefined;
  }

  /** True when the value comes from the FMD_WEB_API_TOKEN env pin. */
  get tokenEnvManaged(): boolean {
    return this.tokenEnvPinned;
  }

  /** Constant-time single-token verification (never length-leaky). */
  verifyApiToken(presented: string | undefined): boolean {
    const expected = this.effectiveApiToken();
    if (presented === undefined || expected === undefined || presented === '') {
      return false;
    }
    return timingSafeEqual(tokenFingerprint(presented), tokenFingerprint(expected));
  }

  /** Resolve how a request authenticated (R4 metrics label). */
  resolveRequestAuth(req: FastifyRequest): AuthKind {
    if (this.verifyApiToken(readBearerToken(req.headers.authorization))) {
      return 'token';
    }
    return 'none';
  }
}
