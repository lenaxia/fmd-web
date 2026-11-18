// @vitest-environment jsdom
/**
 * module-facets unit pins (Settings→Websites rebuild): the FMD2
 * category → LANGUAGE derivation (scanlation collapse, empty →
 * Unknown), H-STATUS (H-Sites + Adult), NEEDS SETUP (AccountSupport),
 * faceted filter semantics (AND across groups / OR within), LIVE
 * counts (each group counts over the OTHER groups' constraints) and
 * the ?q=&lang=&h=&setup= URL codec round-trip.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MODULE_FILTER,
  facetCounts,
  filterModules,
  isAdultCategory,
  languageOf,
  parseModuleFilter,
  serializeModuleFilter,
} from '../src/state/module-facets';
import { moduleFixture } from './fixtures';

describe('languageOf (category → LANGUAGE facet value)', (): void => {
  it('collapses the scanlation suffix — English + English-Scanlation are ONE facet value', (): void => {
    expect(languageOf('English')).toBe('English');
    expect(languageOf('English-Scanlation')).toBe('English');
    expect(languageOf('Spanish-Scanlation')).toBe('Spanish');
    expect(languageOf('Spanish')).toBe('Spanish');
  });

  it('empty categories group as Unknown (27 raw registry sites ship categoryless)', (): void => {
    expect(languageOf('')).toBe('Unknown');
    expect(languageOf('   ')).toBe('Unknown');
  });

  it('non-language FMD2 groupings pass through verbatim', (): void => {
    expect(languageOf('Raw')).toBe('Raw');
    expect(languageOf('H-Sites')).toBe('H-Sites');
    expect(languageOf('Webcomics')).toBe('Webcomics');
  });
});

describe('isAdultCategory (H-STATUS derivation)', (): void => {
  it('matches the FMD2 adult categories, case/space tolerant', (): void => {
    expect(isAdultCategory('H-Sites')).toBe(true);
    expect(isAdultCategory('h-sites')).toBe(true);
    expect(isAdultCategory('Adult')).toBe(true);
    expect(isAdultCategory('Hentai')).toBe(true);
    expect(isAdultCategory('English')).toBe(false);
    expect(isAdultCategory('')).toBe(false);
  });
});

describe('filterModules (faceted semantics)', (): void => {
  const registry = [
    moduleFixture({ id: 'a'.repeat(32), name: 'A', category: 'English', accountSupport: false }),
    moduleFixture({ id: 'b'.repeat(32), name: 'B', category: 'English-Scanlation', accountSupport: true }),
    moduleFixture({ id: 'c'.repeat(32), name: 'C', category: 'H-Sites', accountSupport: false }),
    moduleFixture({ id: 'd'.repeat(32), name: 'D', category: 'Raw', accountSupport: false }),
    moduleFixture({ id: 'e'.repeat(32), name: 'E', category: '', accountSupport: true }),
  ];

  it('LANGUAGE selection is OR within the group and collapses scanlation', (): void => {
    const out = filterModules(registry, { ...EMPTY_MODULE_FILTER, lang: ['English'] });
    expect(out.map((m): string => m.name)).toEqual(['A', 'B']);
  });

  it('AND across groups: English + no-setup keeps only the credential-free English site', (): void => {
    const out = filterModules(registry, { ...EMPTY_MODULE_FILTER, lang: ['English'], setup: ['no-setup'] });
    expect(out.map((m): string => m.name)).toEqual(['A']);
  });

  it('H facet: "safe" excludes H-Sites; "h" isolates them', (): void => {
    const safe = filterModules(registry, { ...EMPTY_MODULE_FILTER, h: ['safe'] });
    expect(safe.map((m): string => m.name)).toEqual(['A', 'B', 'D', 'E']);
    const h = filterModules(registry, { ...EMPTY_MODULE_FILTER, h: ['h'] });
    expect(h.map((m): string => m.name)).toEqual(['C']);
  });

  it('NEEDS SETUP: no-setup = the "websites that don\'t need setup (password)" filter', (): void => {
    const out = filterModules(registry, { ...EMPTY_MODULE_FILTER, setup: ['no-setup'] });
    expect(out.map((m): string => m.name)).toEqual(['A', 'C', 'D']);
  });

  it('text search matches name, id and category', (): void => {
    const byId = filterModules(registry, { ...EMPTY_MODULE_FILTER, q: 'b'.repeat(32) });
    expect(byId.map((m): string => m.name)).toEqual(['B']);
    const byCategory = filterModules(registry, { ...EMPTY_MODULE_FILTER, q: 'raw' });
    expect(byCategory.map((m): string => m.name)).toEqual(['D']);
  });
});

describe('facetCounts (live counts over the OTHER groups)', (): void => {
  const registry = [
    moduleFixture({ id: 'a'.repeat(32), name: 'A', category: 'English', accountSupport: false }),
    moduleFixture({ id: 'b'.repeat(32), name: 'B', category: 'English-Scanlation', accountSupport: true }),
    moduleFixture({ id: 'c'.repeat(32), name: 'C', category: 'English', accountSupport: true }),
    moduleFixture({ id: 'd'.repeat(32), name: 'D', category: 'H-Sites', accountSupport: false }),
  ];

  it('language counts collapse English + English-Scanlation (74+61-style)', (): void => {
    const counts = facetCounts(registry, EMPTY_MODULE_FILTER);
    expect(counts.lang.find((f): boolean => f.value === 'English')?.count).toBe(3);
    expect(counts.lang.find((f): boolean => f.value === 'H-Sites')?.count).toBe(1);
  });

  it('setup counts stay LIVE under a language selection (skip= own group)', (): void => {
    const counts = facetCounts(registry, { ...EMPTY_MODULE_FILTER, lang: ['English'] });
    expect(counts.setup.find((f): boolean => f.value === 'no-setup')?.count).toBe(1);
    expect(counts.setup.find((f): boolean => f.value === 'creds')?.count).toBe(2);
    // the language group itself still counts over the WHOLE registry
    expect(counts.lang.find((f): boolean => f.value === 'H-Sites')?.count).toBe(1);
  });
});

describe('URL codec (?q=&lang=&h=&setup=)', (): void => {
  it('round-trips a full selection', (): void => {
    const state = {
      q: 'manga',
      lang: ['English', 'Raw'],
      h: ['safe'] as const,
      setup: ['no-setup'] as const,
    };
    const query = serializeModuleFilter(state);
    expect(query).toEqual({ q: 'manga', lang: 'English,Raw', h: 'safe', setup: 'no-setup' });
    const parsed = parseModuleFilter(query, ['English', 'Raw', 'H-Sites']);
    expect(parsed).toEqual(state);
  });

  it('empty state serializes to NO params (clean URLs)', (): void => {
    expect(serializeModuleFilter(EMPTY_MODULE_FILTER)).toEqual({});
  });

  it('unknown values drop against the registry (shared URLs never over-filter)', (): void => {
    const parsed = parseModuleFilter(
      { lang: 'Klingon,English', h: 'h,banana', setup: 'no-setup,wat' },
      ['English'],
    );
    expect(parsed.lang).toEqual(['English']);
    expect(parsed.h).toEqual(['h']);
    expect(parsed.setup).toEqual(['no-setup']);
  });
});
