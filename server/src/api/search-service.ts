/**
 * All-sites union search (FMD2 cbSearchFromAllSites parity).
 *
 * FMD2 ground truth (frmMain.pas:3411-3416): checking
 * `cbSearchFromAllSites` sets `dataProcess.FilterAllSites := True` and
 * assigns EVERY enabled site into `SitesList` — the filter then runs
 * as a UNION across all INSTALLED local catalog DBs (never live
 * scraping), and every result row carries its source website
 * (frmMain.pas:5170 vtMangaListGetHint prepends `RS_InfoWebsite` +
 * the module name when FilterAllSites).
 *
 * This service reproduces that union over the §6.4–§6.6 CatalogStore
 * read side:
 *
 * - Participation: every ENABLED module with an installed catalog
 *   (`CatalogStore.getMeta` receipt). Enabled sites without a catalog
 *   are EXCLUDED and surfaced as `excluded[]` (reason `no-catalog`) so
 *   the UI chip can explain why — parity: FMD2 unions installed DBs.
 * - Fan-out: `Promise.allSettled` over per-site FTS searches; a
 *   rejected site becomes a typed `SiteSearchFailure` (partial state:
 *   the rest of the union still returns, never silent, never a full
 *   failure).
 * - Per-site windows: each site is read through the store's PUBLIC
 *   page semantics (`page` + `limit`) at `K = 2 × limit` rows — no
 *   dependence on the store's private cursor encoding. Catalogs are
 *   read-only after install (§6.4 invariant), so per-site orderings
 *   are stable and windowed reads never shift under a cursor.
 * - Merge comparator (documented total order — see
 *   {@link compareSearchEntries}): normalized title, then site id,
 *   then link. The comparator orders every PAGE'S merged pool, and the
 *   output order and the emitted cursor bytes are IDENTICAL under any
 *   permutation of the site set (pinned by a property test). Cross-
 *   page GLOBAL order is a documented best-effort property of a
 *   windowed union: each site serves rows in its OWN store order
 *   (FTS rank / jdn), which cannot be assumed to agree with the union
 *   comparator, so a row deep in one site's window may comparator-sort
 *   before a row an earlier page already emitted from another site.
 *   What IS guaranteed: every matching row appears EXACTLY once across
 *   the walk (completeness, no duplicates — pinned by the window-
 *   boundary pagination test), each page is comparator-ordered, and
 *   the whole stream is a deterministic function of the per-site
 *   offsets. (FMD2's own all-sites list is site-APPENDED — the web
 *   union is strictly more ordered than the parity target.)
 * - Union cursor: base64url JSON `{ v, k, s }` where `k` binds the
 *   FULL issued filter state and `s` is the per-site CONSUMED-row
 *   count (sorted `[siteId, offset]` pairs — canonical bytes under
 *   permutation). `limit` is deliberately NOT bound: consumed counts
 *   are page-size-independent, so a client may change `limit` between
 *   pages without invalidating its position.
 */
import type { CatalogEntry, CatalogMeta, CatalogStore } from '@fmd/contract';
import type { ModuleService } from './services.js';
import { ApiError } from './errors.js';
import { isValidCatalogId } from '../sync/db/catalog-store.js';
import type {
  AllSitesSearchResponseT,
  ExcludedSiteT,
  SearchEntryT,
  SearchFacetT,
  SiteSearchFailureT,
} from './schemas.js';

/** The typed partial-failure row (see {@link SiteSearchFailureSchema}). */
export type SiteSearchFailure = SiteSearchFailureT;

/** Union search input (route-normalized; schemas.ts owns the wire zod). */
export interface UnionSearchInput {
  readonly q?: string;
  readonly status?: string;
  readonly genres?: readonly string[];
  /** `!`-prefixed custom genres — NOT LIKE excludes (audit (b)2 fix). */
  readonly genresExclude?: readonly string[];
  readonly genresMode?: 'all' | 'any';
  readonly authors?: string;
  readonly artists?: string;
  readonly summary?: string;
  readonly newDays?: number;
  /**
   * [fuzzy-javelin-pearls] The scope selector (D1 §2 ENTER): `all`
   * (default — every enabled site with an installed catalog), or a
   * SCOPED query (`preferred` allowlist / `specific` multi-select)
   * where `sites` carries the ROUTE-RESOLVED ordered id list (the
   * allowlist order for preferred, the caller's order for specific —
   * the canonical order, D1 §3). The route validates membership; the
   * service treats `sites` as authoritative whenever scope ≠ all.
   */
  readonly scope?: 'all' | 'preferred' | 'specific';
  readonly sites?: readonly string[];
  readonly cursor?: string;
  readonly limit: number;
}

/** Union search page (the AllSitesSearchResponse wire shape). */
export type UnionSearchPage = AllSitesSearchResponseT;

/**
 * Merge comparator — the documented, deterministic TOTAL order over
 * union rows:
 *
 * 1. `normalizedTitle` — `title.trim().toLowerCase()` with runs of
 *    whitespace collapsed to one space (case/spacing-insensitive title
 *    parity with FMD2's NOCASE title sort). Ascending.
 * 2. `site` — the source site id, ascending. THE permutation-stable
 *    tiebreak: the same title on several sites interleaves in site-id
 *    order no matter which order the fan-out resolved in.
 * 3. `link` — ascending; unique within a catalog (row PK), so the
 *    order is total and duplicate-free.
 */
export function normalizedTitleForMerge(title: string): string {
  return title.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

export function compareSearchEntries(
  a: Pick<SearchEntryT, 'title' | 'site' | 'link'>,
  b: Pick<SearchEntryT, 'title' | 'site' | 'link'>,
): number {
  const at: string = normalizedTitleForMerge(a.title);
  const bt: string = normalizedTitleForMerge(b.title);
  if (at !== bt) {
    return at < bt ? -1 : 1;
  }
  if (a.site !== b.site) {
    return a.site < b.site ? -1 : 1;
  }
  if (a.link === b.link) {
    return 0;
  }
  return a.link < b.link ? -1 : 1;
}

// ── union cursor (opaque, query-bound) ───────────────────────────────

interface UnionCursor {
  v: 1;
  /** Canonical filter fingerprint the cursor was issued for. */
  k: string;
  /** Per-site CONSUMED-row counts, sorted by siteId (canonical bytes). */
  s: readonly (readonly [string, number])[];
}

/** Genres join separator (a char that never occurs in a genre name). */
const CURSOR_GENRE_SEP = '\x1f';

/** The canonical filter fingerprint: binds the FULL issued filter set
 * (scope included — a cursor issued under one scope is a typed 400
 * under another, the same class as a filter change). */
export function unionCursorKey(input: Omit<UnionSearchInput, 'cursor' | 'limit'>): string {
  return JSON.stringify([
    input.q ?? '',
    input.status ?? '',
    input.authors ?? '',
    input.artists ?? '',
    input.summary ?? '',
    (input.genres ?? []).join(CURSOR_GENRE_SEP),
    (input.genresExclude ?? []).join(CURSOR_GENRE_SEP),
    input.genresMode ?? 'all',
    input.newDays ?? null,
    input.scope ?? 'all',
    input.sites ?? [],
  ]);
}

function encodeUnionCursor(cursor: UnionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeUnionCursor(cursor: string, expectedKey: string): Map<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new ApiError(400, 'bad_request', 'invalid all-sites search cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ApiError(400, 'bad_request', 'invalid all-sites search cursor');
  }
  const payload = parsed as Partial<UnionCursor>;
  if (payload.v !== 1 || typeof payload.k !== 'string' || !Array.isArray(payload.s)) {
    throw new ApiError(400, 'bad_request', 'invalid all-sites search cursor');
  }
  if (payload.k !== expectedKey) {
    throw new ApiError(400, 'bad_request', 'cursor does not match the issued query');
  }
  const offsets = new Map<string, number>();
  for (const pair of payload.s) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'number' ||
      !Number.isInteger(pair[1]) ||
      pair[1] < 0
    ) {
      throw new ApiError(400, 'bad_request', 'invalid all-sites search cursor');
    }
    offsets.set(pair[0], pair[1]);
  }
  return offsets;
}

// ── the fan-out service ──────────────────────────────────────────────

/** Per-site fan-out state for one request. */
interface SiteLane {
  readonly siteId: string;
  readonly siteName: string;
  /** CONSUMED-row count (the cursor's per-site component). */
  offset: number;
  /** Fetched-but-unconsumed window rows (already sliced past offset). */
  pending: SearchEntryT[];
  /** True when the store's aligned page came back short (its end). */
  shortPage: boolean;
  /** True when this lane can produce no further rows. */
  exhausted: boolean;
  /** Set when the site's search rejected (typed partial failure). */
  failure?: SiteSearchFailure;
  /** Round-1 total for the facet chip (absent when the store omitted it). */
  total?: number;
}

/**
 * The all-sites search service: fan-out FTS over every installed
 * catalog, merged client-side by the documented comparator. Depends
 * ONLY on the ModuleService + CatalogStore boundaries (the harness
 * in-memory doubles and the SQLite production store are
 * interchangeable).
 */
export class UnionSearchService {
  constructor(
    private readonly modules: ModuleService,
    private readonly catalogs: CatalogStore,
  ) {}

  async search(input: UnionSearchInput): Promise<UnionSearchPage> {
    const limit: number = input.limit;
    // Per-site window width (HLD: K = 2 × limit, the store max).
    const windowK: number = Math.min(2 * limit, 200);
    const filterKey: string = unionCursorKey(input);
    const offsets: Map<string, number> =
      input.cursor !== undefined && input.cursor !== ''
        ? decodeUnionCursor(input.cursor, filterKey)
        : new Map<string, number>();

    // Participation (FMD2 :3411 parity — every ENABLED site; the union
    // runs over the INSTALLED subset, catalog-less sites are excluded
    // with a surfaced reason). Deterministic: lanes sorted by site id,
    // so fan-out order can never leak into the output.
    //
    // Non-32-hex module ids (upstream typos — ColorcitoScan.lua ships
    // '5450026642ecrrd48apotd81e57f8e40') can never have an installed
    // catalog and the store's path-safety assert would throw OUTSIDE
    // the per-lane try/catch, 500ing the whole union — the same guard
    // class as services.ts's catalogInstalled wrapper.
    //
    // [fuzzy-javelin-pearls] SCOPE: a scoped query (preferred /
    // specific) intersects the enabled registry with the route-
    // resolved ordered `sites` list — participation AND the
    // facets/excluded presentation follow the SCOPE order (the
    // canonical order, D1 §3) while the entry merge keeps the
    // documented comparator (deterministic + cursor-stable). Known-
    // but-disabled scoped sites drop out entirely (invisible — union
    // parity with scope=all, where disabled sites never appear).
    const scope = input.scope ?? 'all';
    const scoped: boolean = scope !== 'all' && input.sites !== undefined;
    const scopeOrder: ReadonlyMap<string, number> = scoped
      ? new Map((input.sites as readonly string[]).map((id, i): readonly [string, number] => [id, i]))
      : new Map();
    const byScopeThenId = (a: { id: string }, b: { id: string }): number => {
      if (scoped) {
        const pa = scopeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const pb = scopeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) {
          return pa < pb ? -1 : 1;
        }
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    const enabled = this.modules
      .list()
      .filter((m): boolean => m.enabled && isValidCatalogId(m.id))
      .filter((m): boolean => !scoped || scopeOrder.has(m.id));
    const metaFor = (m: (typeof enabled)[number]): CatalogMeta | undefined =>
      this.catalogs.getMeta(m.id);
    const participating = enabled
      .filter((m): boolean => metaFor(m) !== undefined)
      .sort(byScopeThenId);
    const excluded: ExcludedSiteT[] = enabled
      .filter((m): boolean => metaFor(m) === undefined)
      .sort(byScopeThenId)
      .map((m): ExcludedSiteT => ({ siteId: m.id, siteName: m.name, reason: 'no-catalog' }));

    const lanes: SiteLane[] = participating.map((m): SiteLane => ({
      siteId: m.id,
      siteName: m.name,
      offset: offsets.get(m.id) ?? 0,
      pending: [],
      shortPage: false,
      exhausted: false,
    }));

    const filters = {
      ...(input.q !== undefined && input.q !== '' ? { query: input.q } : {}),
      ...(input.status !== undefined && input.status !== '' ? { status: input.status } : {}),
      ...(input.authors !== undefined && input.authors !== '' ? { authors: input.authors } : {}),
      ...(input.artists !== undefined && input.artists !== '' ? { artists: input.artists } : {}),
      ...(input.summary !== undefined && input.summary !== '' ? { summary: input.summary } : {}),
      ...(input.genres !== undefined && input.genres.length > 0 ? { genres: [...input.genres] } : {}),
      ...(input.genresExclude !== undefined && input.genresExclude.length > 0
        ? { genresExclude: [...input.genresExclude] }
        : {}),
      genresMode: input.genresMode ?? 'all',
      ...(input.newDays !== undefined ? { newDays: input.newDays } : {}),
    };

    const fetchLane = async (lane: SiteLane): Promise<void> => {
      // Window read through the store's PUBLIC page semantics: page 1
      // + floor(offset/K) at width K, sliced past the consumed prefix.
      // Read-only catalogs (§6.4) keep this stable across pages.
      const page = 1 + Math.floor(lane.offset / windowK);
      try {
        const result = await this.catalogs.search(lane.siteId, {
          ...filters,
          limit: windowK,
          page,
        });
        const sliced: CatalogEntry[] = result.entries.slice(lane.offset % windowK);
        lane.shortPage = result.entries.length < windowK;
        lane.pending = sliced.map((entry): SearchEntryT => ({ ...entry, site: lane.siteId, siteName: lane.siteName }));
        if (sliced.length === 0) {
          lane.exhausted = true;
        }
        if (lane.total === undefined && result.total !== undefined) {
          lane.total = result.total;
        }
      } catch (err: unknown) {
        // Typed partial state: one broken catalog never fails the union.
        lane.failure = {
          siteId: lane.siteId,
          siteName: lane.siteName,
          error: err instanceof Error ? err.message : String(err),
        };
        lane.pending = [];
        lane.exhausted = true;
      }
    };

    const entries: SearchEntryT[] = [];
    // Round loop: fill `limit` merged rows, refetching lanes whose
    // window ran dry. Termination: each iteration either takes ≥1 row,
    // exhausts ≥1 lane, or fetches fresh rows into an empty lane —
    // with K = 2×limit the common case settles in one iteration.
    while (entries.length < limit) {
      const needFetch: SiteLane[] = lanes.filter(
        (lane): boolean => lane.failure === undefined && lane.pending.length === 0 && !lane.exhausted,
      );
      if (needFetch.length > 0) {
        await Promise.allSettled(needFetch.map(fetchLane));
      }
      const pool: SearchEntryT[] = lanes.flatMap((lane): SearchEntryT[] => [...lane.pending]);
      if (pool.length === 0) {
        break;
      }
      pool.sort(compareSearchEntries);
      const take: SearchEntryT[] = pool.slice(0, limit - entries.length);
      entries.push(...take);
      // Consume: drop each taken row from its lane, advance the lane's
      // consumed count (the cursor's per-site offset).
      for (const row of take) {
        const lane = lanes.find((l): boolean => l.siteId === row.site);
        if (lane === undefined) {
          continue;
        }
        const idx: number = lane.pending.indexOf(row);
        if (idx >= 0) {
          lane.pending.splice(idx, 1);
        }
        lane.offset += 1;
        if (lane.pending.length === 0 && lane.shortPage) {
          lane.exhausted = true;
        }
      }
    }

    const more: boolean = lanes.some(
      (lane): boolean => lane.failure === undefined && (lane.pending.length > 0 || !lane.exhausted),
    );
    const nextCursor: string | undefined =
      more && entries.length === limit
        ? encodeUnionCursor({
            v: 1,
            k: filterKey,
            s: lanes
              .filter((lane): boolean => lane.offset > 0)
              .sort((a, b): number => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0))
              .map((lane): readonly [string, number] => [lane.siteId, lane.offset]),
          })
        : undefined;

    // Facets cover the sites that ANSWERED (a failed site is surfaced
    // by the typed warning chip instead — a count it could not report
    // would be a lie).
    const facets: SearchFacetT[] = lanes
      .filter((lane): boolean => lane.failure === undefined)
      .map((lane): SearchFacetT => ({
        siteId: lane.siteId,
        siteName: lane.siteName,
        ...(lane.total !== undefined ? { count: lane.total } : {}),
      }));
    const warnings: SiteSearchFailure[] = lanes
      .filter((lane): boolean => lane.failure !== undefined)
      .map((lane): SiteSearchFailure => lane.failure as SiteSearchFailure);

    return {
      entries,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      facets,
      warnings,
      excluded,
      scope,
    };
  }
}
