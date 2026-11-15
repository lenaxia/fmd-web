/**
 * Auth (DESIGN.md §10): optional single password (`FMD_WEB_PASSWORD`)
 *
 * - unset  → everything open; POST /api/auth/login is a 400
 *            `auth_disabled` (there is nothing to log into).
 * - set    → POST /api/auth/login {password} sets an HttpOnly,
 *            SameSite=Strict session cookie; login is rate-limited to
 *            10 attempts/min per remote address (429 + Retry-After);
 *            every STATE-CHANGING route (POST/PUT, except the login
 *            route itself and the health probes) requires a valid,
 *            unexpired session cookie → else 401. Read-only (GET)
 *            routes stay open: the SPA must render Browse/Manga/
 *            Downloads before login.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  /** `FMD_WEB_PASSWORD`. undefined disables auth entirely. */
  readonly password: string | undefined;
  /** Session lifetime (default 24 h). */
  readonly sessionTtlMs?: number;
  /** Login window/max overrides (tests); defaults 60_000 ms / 10. */
  readonly loginRateLimit?: LoginRateLimit;
}

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimit = { windowMs: 60_000, max: 10 };
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Parse the request's Cookie header for the session cookie value. */
export function readSessionCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
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

/**
 * Session store + login rate limiter + the Fastify wiring (login route,
 * state-changing gate). Owns all cookie semantics — routes never
 * touch the cookie directly.
 */
export class AuthService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly rateLimit: LoginRateLimit;

  constructor(private readonly config: AuthConfig) {
    this.ttlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.rateLimit = config.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT;
  }

  get enabled(): boolean {
    return this.config.password !== undefined;
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
 * Register POST /api/auth/login and the state-changing gate. The gate
 * is a Fastify `onRequest` hook so gated requests 401 before any
 * body work happens.
 */
export function registerAuth(app: FastifyInstance, auth: AuthService): void {
  app.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void): void => {
    if (!auth.enabled) {
      done();
      return;
    }
    const url = req.url.split('?')[0] ?? req.url;
    if (!isStateChanging(req.method) || GATE_EXEMPT.has(url)) {
      done();
      return;
    }
    if (!auth.validate(readSessionCookie(req))) {
      done(new ApiError(401, 'unauthorized', 'session required (POST /api/auth/login)'));
      return;
    }
    done();
  });

  app.post(
    '/api/auth/login',
    async (req: FastifyRequest, reply: FastifyReply): Promise<{ ok: true }> => {
      auth.checkRateLimit(req.ip);
      const body = parseOr400(LoginRequestSchema, req.body, 'login body');
      const token = auth.login(body.password);
      void reply.header('set-cookie', auth.cookieHeader(token));
      return { ok: true };
    },
  );
}
