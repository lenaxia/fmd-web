/**
 * Short-TTL response cache for /api/search ([fuzzy-javelin-pearls]):
 * repeated identical union queries (as-you-type backspaces, tab
 * re-focuses, pagination walks that re-cross a page, multiple clients
 * on one instance) are served from memory instead of re-fanning the
 * per-site FTS windows.
 *
 * Deliberately MINIMAL, and the limits are the design:
 *
 * - TTL is SHORT (default 30 s): a catalog provision finishing or a
 *   sync landing mid-window serves at most one stale page per query,
 *   for at most one TTL — the honest cost of caching a union over
 *   read-only-but-live stores. No invalidation hooks into the sync
 *   lane exist and none are added (§6.4 read-only catalogs keep
 *   per-site orderings stable; counts drift at most a TTL).
 * - Bounded: at most {@link SEARCH_CACHE_MAX_ENTRIES} entries,
 *   LRU-evicted (Map re-insertion order), lazy TTL expiry on read.
 * - The preferred-sites allowlist is NOT tolerated staleness: a PUT
 *   to /api/preferred-sites bumps the generation (every cached page
 *   becomes unreachable in O(1) — scope truth is canonical, D1 §3).
 * - Keys bind the FULL issued request — filter fingerprint (scope +
 *   sites included, via {@link unionCursorKey}) plus cursor and
 *   limit — so two different asks never share a page.
 * - Entries are PRIVATE: {@link SearchResponseCache.get} hands out a
 *   structural clone, so no caller can mutate a cached page into
 *   another caller's answer.
 */
import type { AllSitesSearchResponseT } from './schemas.js';
import { unionCursorKey, type UnionSearchInput } from './search-service.js';

/** Default TTL: 30 s (short by charter — "short TTL cache"). */
export const SEARCH_CACHE_TTL_MS = 30_000;

/** Default capacity: 64 distinct query pages (≈ a few search sessions). */
export const SEARCH_CACHE_MAX_ENTRIES = 64;

export interface SearchCacheClock {
  now(): number;
}

export const systemClock: SearchCacheClock = { now: (): number => Date.now() };

export interface SearchResponseCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly clock?: SearchCacheClock;
}

interface CacheSlot {
  readonly response: AllSitesSearchResponseT;
  readonly storedAt: number;
}

export class SearchResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: SearchCacheClock;
  /** Generation prefix — bumped on preferred-sites writes. */
  private generation = 0;
  private readonly slots = new Map<string, CacheSlot>();

  constructor(options: SearchResponseCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? SEARCH_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? SEARCH_CACHE_MAX_ENTRIES;
    this.clock = options.clock ?? systemClock;
  }

  /** Cache diagnostics (tests/observability): live entry count. */
  get size(): number {
    return this.slots.size;
  }

  /**
   * Invalidate every cached page (the preferred-sites PUT hook):
   * scope truth changed, so scoped pages must not serve. O(1) — the
   * generation is part of every key; the stale slots age out by LRU.
   */
  bumpGeneration(): void {
    this.generation += 1;
    this.slots.clear();
  }

  private keyFor(input: UnionSearchInput): string {
    // unionCursorKey binds the full filter state INCLUDING scope and
    // sites; cursor + limit complete the request identity.
    return JSON.stringify([this.generation, unionCursorKey(input), input.cursor ?? '', input.limit]);
  }

  get(input: UnionSearchInput): AllSitesSearchResponseT | undefined {
    const key = this.keyFor(input);
    const slot = this.slots.get(key);
    if (slot === undefined) {
      return undefined;
    }
    if (this.clock.now() - slot.storedAt >= this.ttlMs) {
      this.slots.delete(key);
      return undefined;
    }
    // LRU freshness + privacy: re-insert, hand out a clone.
    this.slots.delete(key);
    this.slots.set(key, slot);
    return structuredClone(slot.response);
  }

  put(input: UnionSearchInput, response: AllSitesSearchResponseT): void {
    const key = this.keyFor(input);
    this.slots.delete(key);
    this.slots.set(key, { response: structuredClone(response), storedAt: this.clock.now() });
    while (this.slots.size > this.maxEntries) {
      const oldest = this.slots.keys().next();
      if (oldest.done) {
        break;
      }
      this.slots.delete(oldest.value);
    }
  }
}
