/**
 * Browse filter state URL codec (tsk-savvy-jockey-ambles): parse ⇄
 * serialize round-trips, FMD2 custom-genres parsing, the canonical
 * 38-genre list, and default handling (shareable URLs never 500s).
 *
 * [parity-sweep] audit (b)2: the `!`/`-` exclusion prefix now parses
 * into a SEPARATE exclude list end-to-end (the V1 parser STRIPPED the
 * prefix and included the genre — inverted semantics).
 */
import { describe, expect, it } from 'vitest';
import {
  apiGenres,
  apiGenresExclude,
  EMPTY_FILTERS,
  FILTER_STATUSES,
  FMD2_GENRES,
  hasActiveFilters,
  parseCustomGenresSplit,
  parseFilterQuery,
  parseGenreEntries,
  serializeFilterQuery,
} from '../src/state/browse-filter-state';

describe('FMD2 canonical genre list', (): void => {
  it('is the 38-checkbox panel from frmMain.lfm (defaultGenres[0..37])', (): void => {
    expect(FMD2_GENRES).toHaveLength(38);
    expect(FMD2_GENRES[0]).toBe('Action');
    // uBaseUnit.pas:54 spells it 'Sci-fi' (the frmMain.lfm caption
    // renders 'Sci-Fi' — LIKE matching is ASCII case-insensitive either
    // way; the ARRAY spelling is the canonical one we carry).
    expect(FMD2_GENRES).toContain('Sci-fi');
    expect(FMD2_GENRES[37]).toBe('Webtoons');
  });

  it('status select carries FMD2 cbFilterStatus items', (): void => {
    expect(FILTER_STATUSES).toEqual(['Ongoing', 'Completed', 'Hiatus', 'Cancelled']);
  });
});

describe('parseGenreEntries (FMD2 edCustomGenres ! / - exclusion grammar)', (): void => {
  it('comma-splits, trims and drops empties', (): void => {
    expect(parseGenreEntries('Adventure, Comedy ,,')).toEqual({
      includes: ['Adventure', 'Comedy'],
      excludes: [],
    });
    expect(parseGenreEntries('')).toEqual({ includes: [], excludes: [] });
  });

  it('REGRESSION (audit (b)2): the ! prefix EXCLUDES, never includes', (): void => {
    // The V1 parser stripped the prefix and returned ['Ecchi'] as an
    // INCLUDE (inverted semantics). The exclude must land in the
    // excludes list with the include list empty — this assertion
    // FAILS against the old parser (it had no excludes output at all).
    expect(parseGenreEntries('!Ecchi')).toEqual({ includes: [], excludes: ['Ecchi'] });
  });

  it('accepts both FMD2 prefixes (! and -) with surrounding whitespace', (): void => {
    expect(parseGenreEntries('Adventure, ! Ecchi, -Smut, - Smut2')).toEqual({
      includes: ['Adventure'],
      excludes: ['Ecchi', 'Smut', 'Smut2'],
    });
  });

  it('a bare prefix with no genre is dropped', (): void => {
    expect(parseGenreEntries('!, Action, -')).toEqual({ includes: ['Action'], excludes: [] });
  });

  it('parseCustomGenresSplit: a genre in BOTH lists resolves exclude-only', (): void => {
    expect(parseCustomGenresSplit('Ecchi, !Ecchi, Action')).toEqual({
      includes: ['Action'],
      excludes: ['Ecchi'],
    });
  });
});

describe('URL codec round-trip', (): void => {
  it('empty state serializes to no params and parses back', (): void => {
    expect(serializeFilterQuery(EMPTY_FILTERS)).toEqual({});
    expect(parseFilterQuery({})).toEqual(EMPTY_FILTERS);
  });

  it('full state round-trips through the query params', (): void => {
    const state = {
      q: 'one piece',
      status: 'Ongoing',
      authors: 'oda',
      artists: '',
      summary: '',
      genres: ['Action', 'Adventure'],
      customGenres: ['Isekai'],
      excludedGenres: [],
      genresMode: 'any' as const,
      newDays: 7,
    };
    const query: Record<string, string> = serializeFilterQuery(state);
    expect(query).toEqual({
      q: 'one piece',
      status: 'Ongoing',
      authors: 'oda',
      genres: 'Action,Adventure',
      cgenres: 'Isekai',
      mode: 'any',
      new: '7',
    });
    expect(parseFilterQuery(query)).toEqual(state);
  });

  it('excluded genres round-trip through the cgenres ! grammar', (): void => {
    const state = {
      ...EMPTY_FILTERS,
      customGenres: ['Isekai'],
      excludedGenres: ['Ecchi', 'Smut'],
    };
    const query: Record<string, string> = serializeFilterQuery(state);
    expect(query['cgenres']).toBe('Isekai,!Ecchi,!Smut');
    // Round-trip preserves BOTH lists…
    expect(parseFilterQuery(query)).toEqual(state);
    // …and the - prefix parses to the same exclude list as !.
    expect(parseFilterQuery({ cgenres: 'Isekai,-Ecchi,!Smut' }).excludedGenres).toEqual([
      'Ecchi',
      'Smut',
    ]);
  });

  it('an exclude-only custom list is an ACTIVE filter (search mode)', (): void => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, excludedGenres: ['Ecchi'] })).toBe(true);
    expect(apiGenresExclude({ ...EMPTY_FILTERS, excludedGenres: ['Ecchi', 'Smut'] })).toEqual([
      'Ecchi',
      'Smut',
    ]);
  });

  it('genresMode defaults to all (FMD2 rbAll) and mode=all is omitted', (): void => {
    expect(serializeFilterQuery({ ...EMPTY_FILTERS, genres: ['Action'] })).not.toHaveProperty('mode');
    expect(parseFilterQuery({ genres: 'Action' }).genresMode).toBe('all');
  });

  it('malformed values fall back to defaults (a shared URL never 500s)', (): void => {
    const state = parseFilterQuery({ status: 'banana', new: '9999', mode: 'nope', q: 'x' });
    expect(state.status).toBe('');
    expect(state.newDays).toBeUndefined();
    expect(state.genresMode).toBe('all');
    expect(hasActiveFilters(state)).toBe(true);
  });

  it('apiGenres merges fixed + custom for the API call', (): void => {
    expect(
      apiGenres({ ...EMPTY_FILTERS, genres: ['Action'], customGenres: ['Isekai', 'Action'] }),
    ).toEqual(['Action', 'Isekai', 'Action']);
  });
});

describe('artists + summary filter fields (FMD2 edFilterArtists/edFilterSummary, settings-parity)', (): void => {
  it('round-trip through the artists=/summary= params; empty values stay unserialized', (): void => {
    const state = {
      ...EMPTY_FILTERS,
      artists: 'takei',
      summary: 'pirate king',
    };
    const query: Record<string, string> = serializeFilterQuery(state);
    expect(query).toEqual({ artists: 'takei', summary: 'pirate king' });
    expect(parseFilterQuery(query)).toEqual(state);
    // Empty = any: neither param serializes.
    expect(serializeFilterQuery(EMPTY_FILTERS)).toEqual({});
  });

  it('compose with the other filter dimensions in one URL', (): void => {
    const query = serializeFilterQuery({
      ...EMPTY_FILTERS,
      q: 'one',
      authors: 'oda',
      artists: 'takei',
      summary: 'king',
      genres: ['Action'],
    });
    expect(query).toEqual({
      q: 'one',
      authors: 'oda',
      artists: 'takei',
      summary: 'king',
      genres: 'Action',
    });
    const parsed = parseFilterQuery(query);
    expect(parsed.authors).toBe('oda');
    expect(parsed.artists).toBe('takei');
    expect(parsed.summary).toBe('king');
    expect(parsed.genres).toEqual(['Action']);
  });

  it('a non-empty artist or summary alone is an ACTIVE filter (search mode)', (): void => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, artists: 'x' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, summary: 'x' })).toBe(true);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });
});
