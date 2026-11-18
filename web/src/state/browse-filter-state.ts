/**
 * Browse filter/search state (FMD2 Filter-panel parity, tsk-savvy-jockey-ambles).
 *
 * ONE search state object (q, filters) <-> the URL query string — the
 * entries list is a PURE function of that state; the FilterBar and the
 * SearchBar edit state only (never the fetch).
 *
 * URL params (hash router): `?site=&q=&status=&genres=&mode=` (the
 * story's names) plus `authors=`, `cgenres=` (custom genres, FMD2's
 * comma-separated edCustomGenres) and `new=` (only-new window, days).
 *
 * Genre list: FMD2's canonical fixed checkbox captions from
 * frmMain.lfm pnGenres — 38 entries (`defaultGenres[0..37]`,
 * uBaseUnit.pas:47; the story text says "39" — the actual FMD2 panel
 * ships 38; parity wins, documented in the evidence file). Custom
 * genres are FMD2 parity too (free text merged into the same genres[]
 * API param — NOT computed facets; a documented V1 decision for zero
 * schema churn).
 */
import { parseHash } from '../router';

/** FMD2's canonical genre checkbox captions (frmMain.lfm, 38 entries). */
export const FMD2_GENRES: readonly string[] = [
  'Action',
  'Adult',
  'Adventure',
  'Comedy',
  'Doujinshi',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Gender Bender',
  'Harem',
  'Hentai',
  'Historical',
  'Horror',
  'Josei',
  'Lolicon',
  'Martial Arts',
  'Mature',
  'Mecha',
  'Musical',
  'Mystery',
  'Psychological',
  'Romance',
  'School Life',
  'Sci-fi',
  'Seinen',
  'Shotacon',
  'Shoujo',
  'Shoujo Ai',
  'Shounen',
  'Shounen Ai',
  'Slice of Life',
  'Smut',
  'Sports',
  'Supernatural',
  'Tragedy',
  'Yaoi',
  'Yuri',
  'Webtoons',
];

/** FMD2 cbFilterStatus items (frmMain.lfm:1636) — index 4 '<none>' = any. */
export const FILTER_STATUSES: readonly string[] = ['Ongoing', 'Completed', 'Hiatus', 'Cancelled'];

export type GenresMode = 'any' | 'all';

/** The whole search/filter state carried by the browse URL. */
export interface BrowseFilterState {
  /** FTS query text ('' = no text search). */
  readonly q: string;
  /** Exact status match; '' = any. */
  readonly status: string;
  /** Authors LIKE-contains; '' = any. */
  readonly authors: string;
  /** Artists LIKE-contains (FMD2 edFilterArtists); '' = any. */
  readonly artists: string;
  /** Summary LIKE-contains (FMD2 edFilterSummary); '' = any. */
  readonly summary: string;
  /** Fixed-genre multi-select (canonical list membership implied). */
  readonly genres: readonly string[];
  /** Custom genres (FMD2 edCustomGenres, comma-separated free text). */
  readonly customGenres: readonly string[];
  /**
   * Excluded genres (FMD2 `!`/`-` custom-genre prefix) — carried to the
   * API as `genresExclude[]` (server-side NOT LIKE). Audit (b)2 fix.
   */
  readonly excludedGenres: readonly string[];
  /** Genre clause join: 'all' (FMD2 rbAll default) | 'any' (rbAny). */
  readonly genresMode: GenresMode;
  /** Only-new window days (jdn-based); undefined = off. */
  readonly newDays?: number | undefined;
}

export const EMPTY_FILTERS: BrowseFilterState = {
  q: '',
  status: '',
  authors: '',
  artists: '',
  summary: '',
  genres: [],
  customGenres: [],
  excludedGenres: [],
  genresMode: 'all',
};

/** True when no filter dimension is active (plain browse). */
export function hasActiveFilters(state: BrowseFilterState): boolean {
  return (
    state.q !== '' ||
    state.status !== '' ||
    state.authors !== '' ||
    state.artists !== '' ||
    state.summary !== '' ||
    state.genres.length > 0 ||
    state.customGenres.length > 0 ||
    state.excludedGenres.length > 0 ||
    state.newDays !== undefined
  );
}

/**
 * Active-filter COUNT for the Filters button badge (UX audit B-1):
 * mirrors the AppliedFilterChips dimensions exactly — one per active
 * facet (genres + customGenres share the single 'genres' chip), so the
 * badge number always equals the removable-chip count.
 */
export function activeFilterCount(state: BrowseFilterState): number {
  let count = 0;
  if (state.q !== '') count += 1;
  if (state.status !== '') count += 1;
  if (state.authors !== '') count += 1;
  if (state.artists !== '') count += 1;
  if (state.summary !== '') count += 1;
  if (state.genres.length > 0 || state.customGenres.length > 0) count += 1;
  if (state.excludedGenres.length > 0) count += 1;
  if (state.newDays !== undefined) count += 1;
  return count;
}

/** The API's combined genres[] list: fixed + custom merged. */
export function apiGenres(state: BrowseFilterState): readonly string[] {
  return [...state.genres, ...state.customGenres];
}

/** The API's genresExclude[] list (server NOT LIKE per genre). */
export function apiGenresExclude(state: BrowseFilterState): readonly string[] {
  return [...state.excludedGenres];
}

/**
 * FMD2 custom-genres parsing (:3371-3388): comma-split, trimmed,
 * non-empty; a leading '!' or '-' EXCLUDES (the uncheck list — FMD2's
 * AddSQLSimpleFilter emits `NOT LIKE` for these, DBDataProcess.pas:1425).
 *
 * Audit (b)2 regression: V1 STRIPPED the prefix and included the genre
 * (inverted semantics — typing `!Ecchi` INCLUDED Ecchi). The parser now
 * preserves the prefix as a separate exclude list end-to-end.
 */
export interface ParsedGenreEntries {
  /** Plain entries — genre INCLUDE filters. */
  readonly includes: readonly string[];
  /** `!`/`-` prefixed entries — genre EXCLUDE filters. */
  readonly excludes: readonly string[];
}

export function parseGenreEntries(raw: string): ParsedGenreEntries {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed: string = part.trim();
    if (trimmed === '') {
      continue;
    }
    if (trimmed.startsWith('!') || trimmed.startsWith('-')) {
      const genre: string = trimmed.slice(1).trim();
      if (genre !== '') {
        excludes.push(genre);
      }
    } else {
      includes.push(trimmed);
    }
  }
  return { includes, excludes };
}

/**
 * Parse the raw custom-genres text into the split filter state
 * (includes + excludes). A genre named in BOTH lists resolves to
 * exclude-only (the exclusion wins, mirroring FMD2 unchecking the box).
 */
export function parseCustomGenresSplit(raw: string): ParsedGenreEntries {
  const { includes, excludes } = parseGenreEntries(raw);
  const excluded: ReadonlySet<string> = new Set(excludes);
  return {
    includes: includes.filter((genre): boolean => !excluded.has(genre)),
    excludes,
  };
}

// ── URL (query-param) codec ─────────────────────────────────────────

/**
 * The filter state from the CURRENT hash — the URL is the source of
 * truth, and interaction-time reads must compose changes a pending
 * async hashchange round-trip has not re-rendered yet (two quick
 * checkbox clicks would otherwise build the second from a stale base).
 * Falls back to the given state when no live hash exists.
 */
export function liveFilterState(fallback: BrowseFilterState): BrowseFilterState {
  const raw: string = globalThis.location.hash;
  if (raw === '') {
    return fallback;
  }
  const parsed: { readonly name: string; readonly query: Record<string, string> } = parseHash(raw);
  return parsed.name === 'browse' ? parseFilterQuery(parsed.query) : fallback;
}

function parseList(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  return [...new Set(parseGenreEntries(raw).includes)];
}

function serializeList(values: readonly string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.join(',');
}

/**
 * Parse the browse URL query into filter state. Unknown keys are
 * ignored; malformed values fall back to defaults (a shared URL never
 * 500s the page).
 *
 * `cgenres` carries the FMD2 custom-genre grammar INCLUDING the
 * `!`/`-` exclude prefix — both lists round-trip through it (excludes
 * are serialized back with the canonical `!` prefix; `-` parses too).
 */
export function parseFilterQuery(query: Record<string, string>): BrowseFilterState {
  const newRaw: string | undefined = query['new'];
  let newDays: number | undefined;
  if (newRaw !== undefined && /^\d+$/.test(newRaw)) {
    const parsed: number = Number.parseInt(newRaw, 10);
    if (parsed >= 1 && parsed <= 365) {
      newDays = parsed;
    }
  }
  const modeRaw: string | undefined = query['mode'];
  const custom: ParsedGenreEntries = parseCustomGenresSplit(query['cgenres'] ?? '');
  return {
    q: query['q'] ?? '',
    status: FILTER_STATUSES.includes(query['status'] ?? '') ? (query['status'] as string) : '',
    authors: query['authors'] ?? '',
    artists: query['artists'] ?? '',
    summary: query['summary'] ?? '',
    genres: parseList(query['genres']),
    customGenres: [...new Set(custom.includes)],
    excludedGenres: [...new Set(custom.excludes)],
    genresMode: modeRaw === 'any' ? 'any' : 'all',
    ...(newDays !== undefined ? { newDays } : {}),
  };
}

/**
 * Serialize filter state back to query params (omitting defaults so the
 * URL stays clean and shareable). `site` rides along untouched.
 */
export function serializeFilterQuery(state: BrowseFilterState): Record<string, string> {
  const out: Record<string, string> = {};
  if (state.q !== '') {
    out['q'] = state.q;
  }
  if (state.status !== '') {
    out['status'] = state.status;
  }
  if (state.authors !== '') {
    out['authors'] = state.authors;
  }
  if (state.artists !== '') {
    out['artists'] = state.artists;
  }
  if (state.summary !== '') {
    out['summary'] = state.summary;
  }
  const genres: string | undefined = serializeList(state.genres);
  if (genres !== undefined) {
    out['genres'] = genres;
  }
  // FMD2 grammar round-trip: plain entries include, `!`-prefixed exclude.
  const customRaw: readonly string[] = [
    ...state.customGenres,
    ...state.excludedGenres.map((genre): string => `!${genre}`),
  ];
  const custom: string | undefined = serializeList(customRaw);
  if (custom !== undefined) {
    out['cgenres'] = custom;
  }
  if (state.genresMode !== 'all') {
    out['mode'] = state.genresMode;
  }
  if (state.newDays !== undefined) {
    out['new'] = String(state.newDays);
  }
  return out;
}
