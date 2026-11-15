import {
  CatalogFallbackError,
  type CatalogBrowseQuery,
  type CatalogEntry,
  type CatalogFallbackStore,
  type CatalogPage,
  type CatalogSearchQuery,
  type ModuleId,
  type UpdateLaneGate,
} from '@fmd/contract';
import { pascalLowerCase } from '../engine/normalize/fmdstrings.js';
import type { RegistrationRecord } from '../engine/registry/capabilities.js';
import { CATALOG_PAGE_DEFAULT, CATALOG_PAGE_MAX } from '../sync/db/catalog-store.js';
import type { DirectoryWalkPort } from './directory-walk.js';

/**
 * §6.8 live-scrape fallback read side — the SAME page shapes as the
 * catalog store (§6.4–§6.6) served from a per-module directory-walk
 * snapshot:
 *
 * - TTL cache (default 6 h, configurable): one walk per module per
 *   TTL window; the walk runs under the update-lane gate (§4 — never a
 *   download-lane slot) with per-module single-flight (concurrent cold
 *   requests share ONE walk; a queued waiter re-checks the cache under
 *   the slot it finally gets).
 * - `latest` keeps the WALK order (site directories are newest-first);
 *   `title` sorts NOCASE + link tiebreak — the same ordering as §6.6.
 * - `search` is the in-memory LIKE index over the snapshot (q terms
 *   ANDed across title/alttitles/summary, exact `status`, substring
 *   `genre` — the §10 search params), cursor-paginated with the
 *   catalog endpoints' opaque base64url offset scheme, query-bound.
 * - A failed walk throws {@link CatalogFallbackError}('walk_failed')
 *   and leaves the previous cache entry untouched — a caller never
 *   sees a partial page. Catalog arrival invalidates via
 *   {@link LiveScrapeCatalogStore.invalidate} and the API's lookup
 *   order flips the module back to `catalog` on its next request.
 */

/** §6.8 default cache TTL: 6 hours. */
export const DEFAULT_LIVE_SCRAPE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  readonly entries: readonly CatalogEntry[];
  readonly fetchedAt: number;
}

export interface FmdClock {
  now(): number;
}

export const systemClock: FmdClock = { now: (): number => Date.now() };

export interface LiveScrapeStoreOptions {
  /** The module-API walk (EngineDirectoryWalker; tests inject doubles). */
  readonly walk: DirectoryWalkPort;
  /** Registry rows provider (the §6.8 capability gate). */
  readonly modules: () => readonly RegistrationRecord[];
  /** §4 update-lane slot budget (scrapes NEVER take download slots). */
  readonly laneGate: UpdateLaneGate;
  /** Cache TTL (default {@link DEFAULT_LIVE_SCRAPE_TTL_MS}). */
  readonly ttlMs?: number;
  /** Clock injection (TTL tests). */
  readonly clock?: FmdClock;
}

function pageLimit(limit: number | undefined): number {
  return Math.min(CATALOG_PAGE_MAX, Math.max(1, Math.trunc(limit ?? CATALOG_PAGE_DEFAULT)));
}

/** SQLite COLLATE NOCASE parity: ASCII A-Z fold + link tiebreak. */
function byTitleOrder(a: CatalogEntry, b: CatalogEntry): number {
  const ta = pascalLowerCase(a.title);
  const tb = pascalLowerCase(b.title);
  if (ta !== tb) {
    return ta < tb ? -1 : 1;
  }
  if (a.link !== b.link) {
    return a.link < b.link ? -1 : 1;
  }
  return 0;
}

/** FPC Pos-parity LIKE probe: ASCII-folded substring containment. */
function likeContains(haystack: string, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  return pascalLowerCase(haystack).includes(pascalLowerCase(needle));
}

// ── cursor encoding (the catalog endpoints' scheme: opaque base64url JSON) ──

interface OffsetCursor {
  o: number;
}

interface SearchCursor {
  q: string;
  o: number;
  g?: string;
  s?: string;
}

function encodeOffsetCursor(offset: number): string {
  const payload: OffsetCursor = { o: offset };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeSearchCursor(cursor: string): SearchCursor {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('malformed cursor');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('malformed cursor');
  }
  const record = payload as Partial<SearchCursor>;
  if (typeof record.o !== 'number' || !Number.isInteger(record.o) || record.o < 0) {
    throw new Error('malformed cursor');
  }
  if (typeof record.q !== 'string') {
    throw new Error('malformed cursor');
  }
  const out: SearchCursor = { q: record.q, o: record.o };
  if (typeof record.g === 'string') {
    out.g = record.g;
  }
  if (typeof record.s === 'string') {
    out.s = record.s;
  }
  return out;
}

export class LiveScrapeCatalogStore implements CatalogFallbackStore {
  private readonly walkFn: DirectoryWalkPort;
  private readonly modules: () => readonly RegistrationRecord[];
  private readonly laneGate: UpdateLaneGate;
  private readonly ttlMs: number;
  private readonly clock: FmdClock;
  private readonly cache = new Map<ModuleId, CacheEntry>();
  private readonly walking = new Map<ModuleId, Promise<CacheEntry>>();

  constructor(options: LiveScrapeStoreOptions) {
    this.walkFn = options.walk;
    this.modules = options.modules;
    this.laneGate = options.laneGate;
    this.ttlMs = options.ttlMs ?? DEFAULT_LIVE_SCRAPE_TTL_MS;
    this.clock = options.clock ?? systemClock;
  }

  /** Cache diagnostics (observability/tests). */
  get cachedModules(): readonly ModuleId[] {
    return [...this.cache.keys()];
  }

  supports(catalogId: ModuleId): boolean {
    const row = this.modules().find((m) => m.id === catalogId);
    return row?.capabilities.live_scrape_fallback === true;
  }

  async latest(catalogId: ModuleId, query: CatalogBrowseQuery = {}): Promise<CatalogPage> {
    const { entries } = await this.entriesFor(catalogId);
    return this.paginateBrowse(entries, query);
  }

  async byTitle(catalogId: ModuleId, query: CatalogBrowseQuery = {}): Promise<CatalogPage> {
    const { entries } = await this.entriesFor(catalogId);
    return this.paginateBrowse([...entries].sort(byTitleOrder), query);
  }

  async search(catalogId: ModuleId, query: CatalogSearchQuery): Promise<CatalogPage> {
    const { entries } = await this.entriesFor(catalogId);
    const rawQuery = query.query;
    const status = query.status;
    const genre = query.genre ?? '';
    const limit = pageLimit(query.limit);

    // Cursor binding mirrors the catalog FTS store: a cursor carries the
    // query (and filters) it was issued for — reuse against another
    // query is a 400-class error, never a silent re-page.
    let offset = Math.max(0, (Math.max(1, Math.trunc(query.page ?? 1)) - 1) * limit);
    if (query.cursor !== undefined && query.cursor !== '') {
      const decoded = decodeSearchCursor(query.cursor);
      if (decoded.q !== rawQuery) {
        throw new Error('cursor does not match the issued query');
      }
      if (decoded.g !== undefined && decoded.g !== genre) {
        throw new Error('cursor does not match the issued genre filter');
      }
      if (decoded.s !== undefined && decoded.s !== (status ?? '')) {
        throw new Error('cursor does not match the issued status filter');
      }
      offset = decoded.o;
    }

    const terms = rawQuery
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t !== '');
    const filtered = entries.filter((entry) => {
      const haystack = `${entry.title} ${entry.alttitles} ${entry.summary}`;
      if (!terms.every((term) => likeContains(haystack, term))) {
        return false;
      }
      if (status !== undefined && status !== '' && entry.status !== status) {
        return false;
      }
      return genre === '' || likeContains(entry.genres, genre);
    });
    // Deterministic order (the live index has no FTS rank): NOCASE title.
    const ordered = [...filtered].sort(byTitleOrder);

    const slice = ordered.slice(offset, offset + limit + 1);
    const hasMore = slice.length > limit;
    const page: CatalogPage = {
      entries: hasMore ? slice.slice(0, limit) : slice,
      total: ordered.length,
    };
    if (hasMore) {
      const cursor: SearchCursor = { q: rawQuery, o: offset + limit };
      if (genre !== '') {
        cursor.g = genre;
      }
      if (status !== undefined && status !== '') {
        cursor.s = status;
      }
      return { ...page, nextCursor: encodeSearchCursor(cursor) };
    }
    return page;
  }

  invalidate(catalogId: ModuleId): void {
    this.cache.delete(catalogId);
    this.walking.delete(catalogId);
  }

  /** Cache snapshot (single-flight shared): hit within TTL, else ONE
   * walk under the update-lane gate. */
  private async entriesFor(catalogId: ModuleId): Promise<CacheEntry> {
    const now = this.clock.now();
    const cached = this.cache.get(catalogId);
    if (cached !== undefined && now - cached.fetchedAt < this.ttlMs) {
      return cached;
    }
    const inflight = this.walking.get(catalogId);
    if (inflight !== undefined) {
      return inflight;
    }
    const task = this.refresh(catalogId).finally((): void => {
      this.walking.delete(catalogId);
    });
    this.walking.set(catalogId, task);
    return task;
  }

  /** One walk under an update-lane slot; the double-check under the
   * slot covers waiters whose cache was refreshed while they queued. */
  private async refresh(catalogId: ModuleId): Promise<CacheEntry> {
    const release = await this.laneGate.acquire();
    if (release === null) {
      throw new CatalogFallbackError(
        'lane_closed',
        'the live-scrape update lane is shutting down — browse request not served',
      );
    }
    try {
      const now = this.clock.now();
      const cached = this.cache.get(catalogId);
      if (cached !== undefined && now - cached.fetchedAt < this.ttlMs) {
        return cached;
      }
      const entries = await this.walkFn.walk(catalogId);
      const fresh: CacheEntry = { entries, fetchedAt: this.clock.now() };
      this.cache.set(catalogId, fresh);
      return fresh;
    } finally {
      release();
    }
  }

  /** Offset paging identical to the §6.6 ordered pages (limit clamp +
   * `{o}` offset cursor + total). */
  private paginateBrowse(ordered: readonly CatalogEntry[], query: CatalogBrowseQuery): CatalogPage {
    const limit = pageLimit(query.limit);
    const offset = (Math.max(1, Math.trunc(query.page ?? 1)) - 1) * limit;
    const slice = ordered.slice(offset, offset + limit + 1);
    const hasMore = slice.length > limit;
    const page: CatalogPage = { entries: hasMore ? slice.slice(0, limit) : slice, total: ordered.length };
    if (hasMore) {
      return { ...page, nextCursor: encodeOffsetCursor(offset + limit) };
    }
    return page;
  }
}
