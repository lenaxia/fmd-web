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
  /** Fixed-genre multi-select (canonical list membership implied). */
  readonly genres: readonly string[];
  /** Custom genres (FMD2 edCustomGenres, comma-separated free text). */
  readonly customGenres: readonly string[];
  /** Genre clause join: 'all' (FMD2 rbAll default) | 'any' (rbAny). */
  readonly genresMode: GenresMode;
  /** Only-new window days (jdn-based); undefined = off. */
  readonly newDays?: number | undefined;
}

export const EMPTY_FILTERS: BrowseFilterState = {
  q: '',
  status: '',
  authors: '',
  genres: [],
  customGenres: [],
  genresMode: 'all',
};

/** True when no filter dimension is active (plain browse). */
export function hasActiveFilters(state: BrowseFilterState): boolean {
  return (
    state.q !== '' ||
    state.status !== '' ||
    state.authors !== '' ||
    state.genres.length > 0 ||
    state.customGenres.length > 0 ||
    state.newDays !== undefined
  );
}

/** The API's combined genres[] list: fixed + custom merged. */
export function apiGenres(state: BrowseFilterState): readonly string[] {
  return [...state.genres, ...state.customGenres];
}

/** FMD2 custom-genres parsing (:3371-3388): comma-split, trimmed,
 * non-empty; a leading '!' or '-' EXCLUDES (uncheck list) — V1 keeps
 * the plain include form and strips the negation prefix. */
export function parseCustomGenres(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((part): string => part.trim())
    .filter((part): boolean => part !== '')
    .map((part): string => (part.startsWith('!') || part.startsWith('-') ? part.slice(1).trim() : part))
    .filter((part): boolean => part !== '');
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
  return [...new Set(parseCustomGenres(raw))];
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
  return {
    q: query['q'] ?? '',
    status: FILTER_STATUSES.includes(query['status'] ?? '') ? (query['status'] as string) : '',
    authors: query['authors'] ?? '',
    genres: parseList(query['genres']),
    customGenres: parseList(query['cgenres']),
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
  const genres: string | undefined = serializeList(state.genres);
  if (genres !== undefined) {
    out['genres'] = genres;
  }
  const custom: string | undefined = serializeList(state.customGenres);
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
