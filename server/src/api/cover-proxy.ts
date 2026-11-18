/**
 * Cover art proxy (live-defect story, R5 web-native ruling): module
 * GetInfo returns ABSOLUTE CDN cover urls (e.g.
 * `http://fmcdn.mfcdn.net/store/manga/…/cover.jpg?token=…&ttl=…`),
 * which a browser behind `img-src 'self' data: blob:` (plus
 * mixed-content on the http:// forms) can NEVER load — desktop FMD2
 * fetches covers straight from the network, the web app cannot. This
 * service is the same-origin seam: it validates the url against the
 * ADDRESSED module's permitted hosts (never an open proxy), fetches
 * through the module HTTP posture (engine User-Agent + AcceptImage +
 * Referer = module RootURL — fmcdn's hotlink check 403s without it,
 * the 513ddfb download-pipeline seam), and serves image/* bytes with
 * cache-friendly headers plus an on-disk cache.
 *
 * Egress posture is LoopbackHttpTransport parity (§5.4 boundary as
 * applied by the engine transport): loopback hosts are always allowed
 * (hermetic tests), every other host requires an FMD_HTTP_ALLOW_HOSTS
 * entry (exact hostname, or `*`). The blocking Atomics.wait transport
 * itself is unusable from an async Fastify handler, so the fetch rides
 * undici — the SAME allow-list input, the SAME verdict semantics.
 *
 * http:// cover urls: try https FIRST (verified live — fmcdn.mfcdn.net
 * serves https), and only when the https hop fails at the NETWORK
 * level (TLS/connect — an origin without https) fall back to the
 * original http url once. Mixed content is a browser constraint, not
 * a server one; the engine transport already speaks plain http for
 * http:// module urls.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { ApiError, notFound } from './errors.js';
import type { ModuleService } from './services.js';
import { ACCEPT_IMAGE_VALUE } from '../engine/shims/http-headers.js';
import { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from '../engine/shims/http-pipeline.js';

/**
 * Known image-CDN hosts that are NOT under any module's RootURL domain
 * but legitimately serve that family's covers. Derived from the live
 * module corpus: mfcdn.net is the MangaFox/MangaHere/FanFox-family
 * cover CDN (fmcdn.mfcdn.net, hotlink-checked via Referer). Entries
 * are registrable-domain suffixes — a url host must equal or be a
 * subdomain of one. Extending this list is the documented seam for
 * future off-domain cover CDNs.
 */
const KNOWN_IMAGE_CDN_SUFFIXES: readonly string[] = ['mfcdn.net'];

/**
 * Second-level suffixes where the registrable domain is THREE labels
 * (no bundled PSL; this covers the families the module corpus uses).
 */
const MULTIPART_SECOND_LEVEL: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.br', 'com.mx', 'com.ar',
  'co.kr', 'co.nz', 'co.in', 'co.za',
  'com.sg', 'com.my', 'com.tr', 'com.ph', 'com.vn',
]);

/** Rotating-signature query params stripped from the cache key —
 * tokened urls re-issue with fresh tokens but identical bytes. */
const SIGNATURE_PARAMS: ReadonlySet<string> = new Set(['token', 'ttl']);

export const COVER_MAX_AGE_FLOOR_SECONDS = 3600;
export const COVER_MAX_AGE_CAP_SECONDS = 86_400;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function isLoopbackHost(host: string): boolean {
  const s = host.toLowerCase();
  return (
    s === 'localhost' ||
    s.endsWith('.localhost') ||
    s.startsWith('127.') ||
    s === '::1' ||
    s === '[::1]'
  );
}

/** Registrable domain of a hostname (last two labels; three under a
 * known multi-part second level). Single-label hosts are themselves. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter((l): boolean => l !== '');
  if (labels.length <= 2) {
    return labels.join('.');
  }
  const second = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  const parts = second.split('.');
  if (parts.length === 2 && MULTIPART_SECOND_LEVEL.has(second)) {
    return `${labels[labels.length - 3]}.${second}`;
  }
  return second;
}

/** Parse a module RootURL into a hostname ('' when unparseable). */
function rootHost(rootUrl: string): string {
  const withScheme = /^https?:\/\//i.test(rootUrl) ? rootUrl : `https://${rootUrl}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Hostname suffixes a module's cover urls may address: the RootURL host
 * and its registrable domain (covers on-site or on a site subdomain,
 * e.g. uploads.mangadex.org under RootURL mangadex.org), plus the
 * curated known image-CDN allowance. A url host must EQUAL or be a
 * dot-suffix of one of these.
 */
export function permittedCoverHostSuffixes(rootUrl: string): string[] {
  const host = rootHost(rootUrl);
  const suffixes = new Set<string>(KNOWN_IMAGE_CDN_SUFFIXES);
  if (host !== '') {
    suffixes.add(host);
    suffixes.add(registrableDomain(host));
  }
  return [...suffixes];
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The token-free normalized cache key for a cover url: scheme-insensitive
 * (http/https upgrades hit the same entry), signature params stripped,
 * remaining query sorted — sha256 hex. Re-issued tokens hit cache.
 */
export function coverCacheKey(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port !== '' && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : '';
  const kept = [...parsed.searchParams.entries()]
    .filter(([name]): boolean => !SIGNATURE_PARAMS.has(name.toLowerCase()))
    .map(([name, value]): string => `${name}=${value}`)
    .sort();
  const normalized = `${host}${port}${parsed.pathname}${kept.length > 0 ? `?${kept.join('&')}` : ''}`;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * cache-control max-age from the url token ttl: fmcdn-style `ttl` is a
 * unix epoch (seconds). Clamped to [1h, 24h] — the floor keeps a
 * near-expiry token from poisoning browser freshness (the disk cache
 * is keyed token-free and serves past-token bytes by design), the cap
 * bounds staleness of re-issued covers. No ttl → the 24h cap.
 */
export function coverMaxAgeSeconds(url: string, nowMs: number): number {
  const ttlRaw = new URL(url).searchParams.get('ttl');
  const ttl = ttlRaw !== null && /^\d+$/.test(ttlRaw) ? Number(ttlRaw) : Number.NaN;
  if (!Number.isFinite(ttl)) {
    return COVER_MAX_AGE_CAP_SECONDS;
  }
  const seconds = ttl - Math.floor(nowMs / 1000);
  return Math.min(
    COVER_MAX_AGE_CAP_SECONDS,
    Math.max(COVER_MAX_AGE_FLOOR_SECONDS, Math.trunc(seconds)),
  );
}

export interface CoverProxyOptions {
  /** On-disk cache root (FMD_WEB_DATA_DIR/covers); created lazily. */
  readonly cacheDir: string;
  /**
   * FMD_HTTP_ALLOW_HOSTS entries (engine transport semantics: loopback
   * always allowed; non-loopback needs an exact entry or `*`).
   */
  readonly allowedHosts?: readonly string[];
  /** Total cache cap before oldest entries are pruned (default 256 MiB). */
  readonly maxCacheBytes?: number;
  /** Per-image byte cap (default 16 MiB). */
  readonly maxImageBytes?: number;
  /** Fetch timeout per hop (default 15 s — pipeline DEFAULT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
  /** Clock injection for deterministic ttl tests. */
  readonly now?: () => number;
  /** Fetch injection for hermetic tests (defaults to undici fetch). */
  readonly fetchImpl?: typeof undiciFetch;
}

export interface CoverProxyResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly maxAgeSeconds: number;
  readonly fromCache: boolean;
}

interface CacheMeta {
  readonly url: string;
  readonly contentType: string;
  readonly storedAt: number;
  readonly bytes: number;
}

/** A real (non-2xx) origin answer — carries the status so the fetch
 * ladder can escalate posture on 403 vs fail fast otherwise. */
class UpstreamStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One shared cover-fetching port: validation (module binding — never an
 * open proxy), egress gate, Referer hotlink posture, https-upgrade with
 * deliberate http fallback, image/* enforcement and the disk cache.
 */
export class CoverProxyService {
  private readonly modules: ModuleService;
  private readonly cacheDir: string;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowAnyHost: boolean;
  private readonly maxCacheBytes: number;
  private readonly maxImageBytes: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof undiciFetch;
  /** In-flight dedup so a grid of rows for one cover fetches once. */
  private readonly inFlight = new Map<string, Promise<{ bytes: Uint8Array; contentType: string }>>();

  constructor(modules: ModuleService, options: CoverProxyOptions) {
    this.modules = modules;
    this.cacheDir = options.cacheDir;
    this.allowedHosts = new Set((options.allowedHosts ?? []).map((h): string => h.toLowerCase()));
    this.allowAnyHost = this.allowedHosts.has('*');
    this.maxCacheBytes = Math.max(0, options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES);
    this.maxImageBytes = Math.max(1, options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES);
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.now = options.now ?? ((): number => Date.now());
    this.fetchImpl = options.fetchImpl ?? undiciFetch;
  }

  /** Validate + resolve a module cover url (foreign/malformed → typed
   * 400; unknown module → typed 404). Exported for the route tests. */
  validate(moduleId: string, rawUrl: string): { url: URL } {
    const module = this.modules.get(moduleId);
    if (module === undefined) {
      throw notFound('Module', moduleId);
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ApiError(400, 'validation_error', 'cover url must be an absolute http(s) url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ApiError(400, 'validation_error', `cover url scheme must be http or https, got ${url.protocol}`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new ApiError(400, 'validation_error', 'cover url must not carry credentials');
    }
    const host = url.hostname.toLowerCase();
    const permitted = permittedCoverHostSuffixes(module.rootURL);
    if (!permitted.some((suffix): boolean => hostMatchesSuffix(host, suffix))) {
      throw new ApiError(
        400,
        'bad_request',
        `cover url host ${host} is not permitted for module ${module.id}`,
      );
    }
    if (!isLoopbackHost(host) && !this.allowAnyHost && !this.allowedHosts.has(host)) {
      throw new ApiError(
        502,
        'upstream_error',
        `cover host ${host} is outside the module HTTP egress allow-list (FMD_HTTP_ALLOW_HOSTS)`,
      );
    }
    return { url };
  }

  /** Full proxy read: cache → validated fetch → cache fill. */
  async get(moduleId: string, rawUrl: string): Promise<CoverProxyResult> {
    // Validation FIRST, before any cache lookup — a cached entry never
    // bypasses the module-binding/egress gates.
    this.validate(moduleId, rawUrl);
    const maxAgeSeconds = coverMaxAgeSeconds(rawUrl, this.now());
    const key = coverCacheKey(rawUrl);
    const cached = await this.readCache(key);
    if (cached !== undefined) {
      return { ...cached, maxAgeSeconds, fromCache: true };
    }
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return { ...(await existing), maxAgeSeconds, fromCache: true };
    }
    const pending = this.fetchAndCache(moduleId, rawUrl, key);
    this.inFlight.set(key, pending);
    try {
      const result = await pending;
      return { ...result, maxAgeSeconds, fromCache: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchAndCache(
    moduleId: string,
    rawUrl: string,
    key: string,
  ): Promise<Omit<CoverProxyResult, 'maxAgeSeconds' | 'fromCache'>> {
    const fetched = await this.fetchOriginTyped(moduleId, rawUrl);
    const meta: CacheMeta = {
      url: rawUrl,
      contentType: fetched.contentType,
      storedAt: this.now(),
      bytes: fetched.bytes.byteLength,
    };
    await this.writeCache(key, fetched.bytes, meta);
    return fetched;
  }

  /**
   * Origin fetch with the module HTTP posture: engine UA + AcceptImage,
   * Referer = module RootURL (fmcdn 403s without it). TWO deliberate
   * fallbacks, both evidenced live:
   *
   * - https-upgrade: http:// urls try https FIRST (fmcdn.mfcdn.net
   *   serves https, verified); a NETWORK-level https failure (TLS/
   *   connect — an origin without https) falls back to the original
   *   http hop once (mixed content is a browser constraint, not ours).
   * - posture escalation on 403: some CDNs CHALLENGE the desktop-
   *   browser UA (uploads.mangadex.org 302s the engine Chrome UA to
   *   an /edge/challenge that answers 403, while a NON-browser UA
   *   sails through — verified live). A 403 retries once with the
   *   minimal posture: Referer KEPT (the fmcdn requirement), browser
   *   UA dropped.
   */
  private async fetchOrigin(
    moduleId: string,
    rawUrl: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const module = this.modules.get(moduleId);
    if (module === undefined) {
      throw notFound('Module', moduleId);
    }
    const parsed = new URL(rawUrl);
    const referer = module.rootURL !== '' ? { Referer: module.rootURL } : {};
    const modulePosture: Record<string, string> = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: ACCEPT_IMAGE_VALUE,
      ...referer,
    };
    const minimalPosture: Record<string, string> = {
      Accept: ACCEPT_IMAGE_VALUE,
      ...referer,
    };

    const attempt = async (
      target: URL,
      headers: Record<string, string>,
    ): Promise<{ bytes: Uint8Array; contentType: string }> => {
      const response = await this.fetchImpl(target.toString(), {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        throw new UpstreamStatusError(
          response.status,
          `cover origin answered HTTP ${response.status} for ${target.protocol}//${target.host}`,
        );
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() ?? '';
      if (!contentType.startsWith('image/')) {
        throw new ApiError(
          502,
          'upstream_error',
          `cover origin returned non-image content-type ${contentType === '' ? '(none)' : contentType}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxImageBytes) {
        throw new ApiError(502, 'upstream_error', 'cover image exceeds the size cap');
      }
      return { bytes, contentType };
    };

    const withEscalation = async (
      target: URL,
    ): Promise<{ bytes: Uint8Array; contentType: string }> => {
      try {
        return await attempt(target, modulePosture);
      } catch (err: unknown) {
        if (err instanceof UpstreamStatusError && err.status === 403) {
          return await attempt(target, minimalPosture);
        }
        throw err;
      }
    };

    try {
      if (parsed.protocol === 'http:') {
        const upgraded = new URL(rawUrl);
        upgraded.protocol = 'https:';
        return await withEscalation(upgraded);
      }
      return await withEscalation(parsed);
    } catch (err: unknown) {
      // Deliberate http fallback: ONLY when the original url was http
      // AND the https attempt failed below the HTTP layer
      // (UpstreamStatusError is a real origin answer — a 403/404 on
      // https stays an error; the fetch rejection is the TLS/connect
      // failure of an https-less origin). Mixed content is a browser
      // constraint, not ours.
      if (parsed.protocol === 'http:' && !(err instanceof ApiError) && !(err instanceof UpstreamStatusError)) {
        return await withEscalation(parsed);
      }
      throw err;
    }
  }

  /** The typed-envelope boundary: every ladder failure leaves
   * fetchOrigin as an ApiError (UpstreamStatusError is internal). */
  private async fetchOriginTyped(moduleId: string, rawUrl: string): Promise<{
    bytes: Uint8Array;
    contentType: string;
  }> {
    try {
      return await this.fetchOrigin(moduleId, rawUrl);
    } catch (err: unknown) {
      if (err instanceof UpstreamStatusError) {
        throw new ApiError(502, 'upstream_error', err.message);
      }
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(
        502,
        'upstream_error',
        `cover origin fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readCache(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    const imgPath = path.join(this.cacheDir, `${key}.img`);
    const metaPath = path.join(this.cacheDir, `${key}.meta.json`);
    try {
      const [metaRaw, bytes] = await Promise.all([
        fsp.readFile(metaPath, 'utf8'),
        fsp.readFile(imgPath),
      ]);
      const meta = JSON.parse(metaRaw) as Partial<CacheMeta>;
      if (typeof meta.contentType !== 'string' || !meta.contentType.startsWith('image/')) {
        return undefined;
      }
      if (bytes.byteLength === 0 || bytes.byteLength > this.maxImageBytes) {
        return undefined;
      }
      return { bytes: new Uint8Array(bytes), contentType: meta.contentType };
    } catch {
      return undefined;
    }
  }

  /** Best-effort cache fill (the cache is an optimization, never a
   * dependency) + oldest-first prune over the total byte cap. */
  private async writeCache(key: string, bytes: Uint8Array, meta: CacheMeta): Promise<void> {
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      const imgPath = path.join(this.cacheDir, `${key}.img`);
      const metaPath = path.join(this.cacheDir, `${key}.meta.json`);
      await fsp.writeFile(imgPath, bytes);
      await fsp.writeFile(metaPath, `${JSON.stringify(meta)}\n`);
      await this.prune();
    } catch {
      // unwritable data dir etc. — serve through, never fail the proxy
    }
  }

  /** Delete oldest `.img`/`.meta.json` pairs (by img mtime) until the
   * directory is under maxCacheBytes. */
  private async prune(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.cacheDir, { withFileTypes: true });
    } catch {
      return;
    }
    const pairs: { key: string; mtimeMs: number; bytes: number }[] = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.img')) {
        continue;
      }
      const key = entry.name.slice(0, -'.img'.length);
      const imgPath = path.join(this.cacheDir, entry.name);
      try {
        const stat = await fsp.stat(imgPath);
        pairs.push({ key, mtimeMs: stat.mtimeMs, bytes: stat.size });
        total += stat.size;
      } catch {
        // raced away — ignore
      }
    }
    if (total <= this.maxCacheBytes) {
      return;
    }
    pairs.sort((a, b): number => a.mtimeMs - b.mtimeMs);
    for (const pair of pairs) {
      if (total <= this.maxCacheBytes) {
        break;
      }
      total -= pair.bytes;
      await Promise.allSettled([
        fsp.rm(path.join(this.cacheDir, `${pair.key}.img`), { force: true }),
        fsp.rm(path.join(this.cacheDir, `${pair.key}.meta.json`), { force: true }),
      ]);
    }
  }
}
