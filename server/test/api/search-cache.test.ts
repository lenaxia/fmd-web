/**
 * SearchResponseCache unit semantics ([fuzzy-javelin-pearls]):
 *
 * - TTL: a fresh entry serves, an aged entry does not (fake clock)
 * - key binding: scope / sites / cursor / limit are all distinct keys
 * - generation: bumpGeneration() orphans every cached page (the
 *   preferred-sites PUT hook)
 * - bounded: maxEntries LRU-evicts the least-recently-USED entry
 * - privacy: get() hands out a CLONE — mutating a returned page never
 *   corrupts the next hit
 */
import { describe, expect, it } from 'vitest';
import { SearchResponseCache } from '../../src/api/search-cache.js';
import type { UnionSearchInput } from '../../src/api/search-service.js';
import type { AllSitesSearchResponseT } from '../../src/api/schemas.js';

function page(tag: string): AllSitesSearchResponseT {
  return {
    entries: [],
    facets: [],
    warnings: [],
    excluded: [],
    scope: 'all',
    ...(tag !== '' ? { nextCursor: tag } : {}),
  };
}

function input(overrides: Partial<UnionSearchInput> = {}): UnionSearchInput {
  return { q: 'common', scope: 'all', limit: 20, ...overrides };
}

function fakeClock(start = 1_000_000): { now(): number; advance(ms: number): void } {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe('SearchResponseCache', () => {
  it('serves a fresh entry and expires it after the TTL', () => {
    const clock = fakeClock();
    const cache = new SearchResponseCache({ ttlMs: 30_000, clock });
    cache.put(input(), page('c1'));
    expect(cache.get(input())?.nextCursor).toBe('c1');
    clock.advance(29_999);
    expect(cache.get(input())?.nextCursor).toBe('c1');
    clock.advance(1);
    expect(cache.get(input())).toBeUndefined();
  });

  it('binds the FULL request identity: scope, sites, cursor and limit are distinct keys', () => {
    const cache = new SearchResponseCache({ clock: fakeClock() });
    cache.put(input(), page('all'));
    cache.put(input({ scope: 'preferred', sites: ['a'.repeat(32)] }), page('scoped'));
    cache.put(input({ limit: 40 }), page('wider'));
    cache.put(input({ cursor: 'cur' }), page('next'));
    expect(cache.get(input())?.nextCursor).toBe('all');
    expect(cache.get(input({ scope: 'preferred', sites: ['a'.repeat(32)] }))?.nextCursor).toBe('scoped');
    expect(cache.get(input({ limit: 40 }))?.nextCursor).toBe('wider');
    expect(cache.get(input({ cursor: 'cur' }))?.nextCursor).toBe('next');
  });

  it('bumpGeneration() orphans every cached page (preferred-sites PUT hook)', () => {
    const cache = new SearchResponseCache({ clock: fakeClock() });
    cache.put(input(), page('one'));
    cache.put(input({ q: 'beta' }), page('two'));
    cache.bumpGeneration();
    expect(cache.get(input())).toBeUndefined();
    expect(cache.get(input({ q: 'beta' }))).toBeUndefined();
  });

  it('LRU-evicts the least-recently-used entry at capacity', () => {
    const cache = new SearchResponseCache({ maxEntries: 2, clock: fakeClock() });
    cache.put(input({ q: 'a' }), page('a'));
    cache.put(input({ q: 'b' }), page('b'));
    // Touch 'a' — 'b' is now the LRU.
    expect(cache.get(input({ q: 'a' }))?.nextCursor).toBe('a');
    cache.put(input({ q: 'c' }), page('c'));
    expect(cache.get(input({ q: 'b' }))).toBeUndefined();
    expect(cache.get(input({ q: 'a' }))?.nextCursor).toBe('a');
    expect(cache.get(input({ q: 'c' }))?.nextCursor).toBe('c');
  });

  it('hands out CLONES — mutating a returned page never corrupts the cache', () => {
    const cache = new SearchResponseCache({ clock: fakeClock() });
    cache.put(input(), page('seed'));
    const first = cache.get(input());
    expect(first).toBeDefined();
    (first as { nextCursor?: string }).nextCursor = 'TAMPERED';
    expect(cache.get(input())?.nextCursor).toBe('seed');
  });
});
