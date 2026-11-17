/**
 * Browse filter state URL codec (tsk-savvy-jockey-ambles): parse ⇄
 * serialize round-trips, FMD2 custom-genres parsing, the canonical
 * 38-genre list, and default handling (shareable URLs never 500s).
 */
import { describe, expect, it } from 'vitest';
import {
  apiGenres,
  EMPTY_FILTERS,
  FILTER_STATUSES,
  FMD2_GENRES,
  hasActiveFilters,
  parseCustomGenres,
  parseFilterQuery,
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

describe('parseCustomGenres (FMD2 edCustomGenres semantics)', (): void => {
  it('comma-splits, trims and drops empties', (): void => {
    expect(parseCustomGenres('Adventure, Comedy ,,')).toEqual(['Adventure', 'Comedy']);
    expect(parseCustomGenres('')).toEqual([]);
  });

  it('strips the FMD2 exclusion prefixes (! / -) for the V1 include form', (): void => {
    expect(parseCustomGenres('Adventure, !Ecchi, -Smut')).toEqual(['Adventure', 'Ecchi', 'Smut']);
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
      genres: ['Action', 'Adventure'],
      customGenres: ['Isekai'],
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
