/**
 * Auth (DESIGN.md §10 + R4): optional single password (`FMD_WEB_PASSWORD`)
 * PLUS the single app-wide API token (docs/UX-PARITY.md R4 — the
 * Sonarr/Radarr model): `Authorization: Bearer <token>` is a valid
 * credential on EVERY /api route and the /ws upgrade (header preferred;
 * `?token=` query param for browser WS clients). ONE token value, ever —
 * no lists, no per-user/per-scope variants (R2 single-operator).
 *
 * Auth-mode matrix (every cell offline-tested; *arr semantics — the
 * gate keys on the PASSWORD only, a token never raises a wall):
 * - token + password → either credential grants the gated set
 *   (state-changing routes + the token-settings reads + /ws); plain
 *   GETs stay open so the pre-login SPA still renders (§10).
 * - token only        → OPEN deployment: no password means no gate —
 *   the SPA works login-free (reverse-proxy deployments front it),
 *   and the token is ACCEPTED wherever presented (scripts).
 * - password only     → today's cookie flow, unchanged.
 * - both unset        → auth off, everything open (a token is still
 *   generated — it is a script key, not an auth surface).
 *
 * Token facts: 32-byte hex; auto-generated on first start of EVERY
 * unpinned deployment (no env pin, nothing stored — the runtime
 * assembly owns generation, `resolveApiTokenBootstrap`); FMD_WEB_API_TOKEN pins it
 * (precedence env > settings store, runbook §API token); comparison is
 * constant-time (SHA-256 fingerprints + timingSafeEqual); wrong/missing
 * token when required → 401 typed envelope; token-authenticated
 * requests bypass the login rate limit.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import { SESSION_COOKIE, LoginRequestSchema } from './schemas.js';
import { parseOr400 } from './schemas.js';

/** Fixed-window rate limit buckets: 10 login attempts/min per address. */
export interface LoginRateLimit {
  readonly windowMs: number;
  readonly max: number;
}

export interface AuthConfig {
  /** `FMD_WEB_PASSWORD`. undefined disables the cookie flow entirely. */
  readonly password: string | undefined;
  /** Session lifetime (default 24 h). */
  readonly sessionTtlMs?: number;
  /** Login window/max overrides (tests); defaults 60_000 ms / 10. */
  readonly loginRateLimit?: LoginRateLimit;
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

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimit = { windowMs: 60_000, max: 10 };
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How a request authenticated: the R4 metrics label vocabulary. */
export type AuthKind = 'none' | 'cookie' | 'token';

/** The active auth surface, for logs + the Settings → API panel. */
export type AuthMode = 'none' | 'password' | 'api-token' | 'password+api-token';

interface SessionRecord {
  readonly expiresAt: number;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

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

/** Parse a raw Cookie header for the session cookie value. */
export function readSessionCookieValue(cookieHeader: string | string[] | undefined): string | undefined {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Parse the request's Cookie header for the session cookie value. */
export function readSessionCookie(req: FastifyRequest): string | undefined {
  return readSessionCookieValue(req.headers.cookie);
}

/** The `?token=` query param (browser WS clients cannot set headers). */
function tokenFromQuery(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  const qi = url.indexOf('?');
  if (qi < 0) {
    return undefined;
  }
  for (const pair of url.slice(qi + 1).split('&')) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    if (name !== 'token') {
      continue;
    }
    const raw = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(raw.replace(/\+/g, '%20'));
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * First-run token bootstrap (R4): the stored settings value and the env
 * pin resolve to the effective token + whether this boot generated one.
 * Generation is UNCONDITIONAL (no pin, nothing stored → generate): the
 * token is an *arr-style API key, not a password companion — reverse-
 * proxy deployments (authelia/authentik gate the UI; FMD_WEB_PASSWORD
 * unset) still get a script key on first run. With password auth OFF
 * the API stays open for the browser SPA; the token is additionally
 * ACCEPTED wherever it is presented.
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
 * Session store + login rate limiter + the single API token check +
 * the Fastify wiring (login route, credential gate). Owns all cookie
 * and bearer semantics — routes never touch credentials directly.
 */
export class AuthService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly rateLimit: LoginRateLimit;
  private readonly apiToken: (() => string | undefined) | undefined;
  private readonly tokenEnvPinned: boolean;

  constructor(private readonly config: AuthConfig) {
    this.ttlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.rateLimit = config.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT;
    // Local const: narrowing must survive the closure (property-access
    // narrowing resets inside callbacks — const does not).
    const providedToken = config.apiToken;
    this.apiToken =
      typeof providedToken === 'function' ? providedToken : ((): string | undefined => providedToken);
    this.tokenEnvPinned = config.apiTokenEnvPinned === true;
  }

  get enabled(): boolean {
    return this.config.password !== undefined;
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

  /** The active auth surface, for the startup log + Settings panel. */
  authMode(): AuthMode {
    if (this.enabled && this.tokenActive) {
      return 'password+api-token';
    }
    if (this.tokenActive) {
      return 'api-token';
    }
    if (this.enabled) {
      return 'password';
    }
    return 'none';
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
    if (this.enabled && this.validate(readSessionCookie(req))) {
      return 'cookie';
    }
    return 'none';
  }

  /**
   * /ws upgrade gate: open unless the PASSWORD flow is on (a token's
   * existence never gates — *arr semantics; browser live-tiles must not
   * demand a bearer on password-less deployments). When the password is
   * on: token via Authorization header (preferred) or `?token=`
   * (browser clients); a session cookie also grants.
   */
  checkUpgradeRequest(req: IncomingMessage): boolean {
    if (!this.enabled) {
      return true;
    }
    if (this.verifyApiToken(readBearerToken(req.headers.authorization))) {
      return true;
    }
    if (this.verifyApiToken(tokenFromQuery(req.url))) {
      return true;
    }
    return this.enabled && this.validate(readSessionCookieValue(req.headers.cookie));
  }

  /** Verify credentials and mint a session (throws 401 on mismatch). */
  login(password: string): string {
    const expected = this.config.password;
    if (expected === undefined) {
      throw new ApiError(400, 'bad_request', 'auth is disabled (no FMD_WEB_PASSWORD set)');
    }
    if (!safeEqual(password, expected)) {
      throw new ApiError(401, 'unauthorized', 'invalid credentials');
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** True when the cookie carries a live session. */
  validate(token: string | undefined): boolean {
    if (token === undefined) {
      return false;
    }
    const record = this.sessions.get(token);
    if (record === undefined) {
      return false;
    }
    if (Date.now() >= record.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** Fixed-window check; throws 429 (with retry seconds) when exhausted. */
  checkRateLimit(remoteAddress: string): void {
    const now = Date.now();
    const bucket = this.attempts.get(remoteAddress);
    if (bucket === undefined || now >= bucket.resetAt) {
      this.attempts.set(remoteAddress, { count: 1, resetAt: now + this.rateLimit.windowMs });
      return;
    }
    if (bucket.count >= this.rateLimit.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new ApiError(429, 'rate_limited', 'login rate limit exceeded (10/min)', {
        retryAfterSeconds,
      });
    }
    bucket.count += 1;
  }

  /** Set-Cookie header value for a minted token. */
  cookieHeader(token: string): string {
    const maxAgeSeconds = Math.floor(this.ttlMs / 1000);
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}`;
  }

  /** Expired-session sweep (keeps long-running stores bounded). */
  prune(): void {
    const now = Date.now();
    for (const [token, record] of this.sessions) {
      if (now >= record.expiresAt) {
        this.sessions.delete(token);
      }
    }
  }
}

/** True for methods that mutate state (the auth-gated set). */
export function isStateChanging(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/** Routes exempt from the gate (login mints the session; probes are public). */
const GATE_EXEMPT = new Set(['/api/auth/login', '/healthz', '/readyz']);

/**
 * GET routes that carry the token SECRET and are therefore
 * credential-gated in EVERY authed mode (plain GETs stay open for the
 * pre-login SPA everywhere else).
 */
const TOKEN_SECRET_ROUTES = new Set(['/api/settings/api-token']);

/**
 * Register POST /api/auth/login and the credential gate. The gate is a
 * Fastify `onRequest` hook so gated requests 401 before any body work
 * happens. Gated set per the R4 matrix (*arr semantics):
 * - the gate turns on ONLY with a password (FMD_WEB_PASSWORD) — the
 *   deliberate auth surface. A token's mere existence never raises a
 *   wall: reverse-proxy deployments (authelia/authentik in front) run
 *   password-less with the SPA fully open;
 * - with the password on: state-changing routes + the token-secret
 *   reads require a session cookie OR the bearer token;
 * - the token is ACCEPTED wherever presented (also bypasses the login
 *   rate limit) and gates the /ws upgrade when the password is on.
 */
export function registerAuth(app: FastifyInstance, auth: AuthService): void {
  app.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void): void => {
    if (!auth.enabled) {
      done();
      return;
    }
    const url = req.url.split('?')[0] ?? req.url;
    if (GATE_EXEMPT.has(url)) {
      done();
      return;
    }
    const gated = isStateChanging(req.method) || TOKEN_SECRET_ROUTES.has(url);
    if (!gated) {
      done();
      return;
    }
    if (auth.resolveRequestAuth(req) === 'none') {
      done(
        new ApiError(
          401,
          'unauthorized',
          'session required (POST /api/auth/login) or Bearer api token',
        ),
      );
      return;
    }
    done();
  });

  app.post(
    '/api/auth/login',
    async (req: FastifyRequest, reply: FastifyReply): Promise<{ ok: true }> => {
      // R4: valid token requests bypass the login rate limit (scripts
      // never get 429'd for a browser's exhausted login window).
      if (!auth.verifyApiToken(readBearerToken(req.headers.authorization))) {
        auth.checkRateLimit(req.ip);
      }
      const body = parseOr400(LoginRequestSchema, req.body, 'login body');
      const token = auth.login(body.password);
      void reply.header('set-cookie', auth.cookieHeader(token));
      return { ok: true };
    },
  );
}
