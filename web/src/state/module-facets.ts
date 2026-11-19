/**
 * Module facets (Settings→Websites rebuild, tsk-skilled-tabby-blooms):
 * the FMD2 module headers (category + AccountSupport) turned into a
 * faceted filter model — LANGUAGE (category names with the scanlation
 * suffix collapsed: English + English-Scanlation → English; the raw
 * registry serves BOTH, 74 + 61 sites, and the old UI showed them as
 * two interleaved half-groups which read as "1 english site"), H-STATUS
 * (the H-Sites/Adult categories) and NEEDS SETUP (AccountSupport —
 * "only websites that don't need setup" is a first-class facet).
 *
 * Pure functions only: the SettingsPage owns the URL-synced state; this
 * module derives facet values, filters, computes LIVE counts (proper
 * faceted search semantics — each group's counts reflect the OTHER
 * groups' constraints, so a chip never offers a dead end) and
 * encodes/decodes the query params (`q`, `lang`, `h`, `setup`).
 */
import type { ModuleSummaryT } from '../api/hooks';

/** H-STATUS facet values (derived from the H-Sites/Adult categories). */
export type HFacetValue = 'h' | 'safe';

/** NEEDS SETUP facet values (derived from AccountSupport). */
export type SetupFacetValue = 'creds' | 'no-setup';

/**
 * LAST CHECK facet values (site availability): 'all' is the unfiltered
 * default; the three concrete values are single-select (an availability
 * status is mutually exclusive by nature). 'unknown' = never checked.
 */
export type AvailabilityFacetValue = 'reachable' | 'unreachable' | 'unknown';

export interface ModuleFilterState {
  /** Free-text search over name/id/category (contains, case-insensitive). */
  readonly q: string;
  /** Selected LANGUAGE facet values (collapsed names). */
  readonly lang: readonly string[];
  /** Selected H-STATUS values. */
  readonly h: readonly HFacetValue[];
  /** Selected NEEDS SETUP values. */
  readonly setup: readonly SetupFacetValue[];
  /** Selected LAST CHECK value ('all' = no availability constraint). */
  readonly avail: AvailabilityFacetValue | 'all';
}

export const EMPTY_MODULE_FILTER: ModuleFilterState = { q: '', lang: [], h: [], setup: [], avail: 'all' };

/**
 * The LANGUAGE facet value derived from a module category: empty →
 * 'Unknown' (27 raw sites ship categoryless); a trailing '-Scanlation'
 * is collapsed ('English-Scanlation' → 'English', 'Spanish-Scanlation'
 * → 'Spanish'); everything else (Raw, H-Sites, Webcomics, …) is the
 * FMD2 tree grouping verbatim.
 */
export function languageOf(category: string): string {
  const trimmed: string = category.trim();
  if (trimmed === '') {
    return 'Unknown';
  }
  if (trimmed.toLowerCase().endsWith('-scanlation')) {
    return trimmed.slice(0, -'-scanlation'.length);
  }
  return trimmed;
}

/** H-STATUS: the FMD2 adult categories (H-Sites, Adult). */
export function isAdultCategory(category: string): boolean {
  const lowered: string = category.trim().toLowerCase();
  return lowered === 'h-sites' || lowered === 'adult' || lowered === 'hentai';
}

export function hFacetOf(module: ModuleSummaryT): HFacetValue {
  return isAdultCategory(module.category) ? 'h' : 'safe';
}

export function setupFacetOf(module: ModuleSummaryT): SetupFacetValue {
  return module.accountSupport ? 'creds' : 'no-setup';
}

/** LAST CHECK: the module's availability status (unknown = never checked). */
export function availabilityFacetOf(module: ModuleSummaryT): AvailabilityFacetValue {
  return module.availability.status;
}

function matchesText(module: ModuleSummaryT, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  return (
    module.name.toLowerCase().includes(needle) ||
    module.id.toLowerCase().includes(needle) ||
    module.category.toLowerCase().includes(needle)
  );
}

/**
 * AND across facet groups, OR within a group, text search composed by
 * AND — the standard faceted-filter semantics (same shape as the site
 * picker's ?cats= + search).
 */
export function moduleMatches(
  module: ModuleSummaryT,
  filter: ModuleFilterState,
  /** Skip one facet group when computing that group's live counts. */
  skip?: 'lang' | 'h' | 'setup' | 'avail',
): boolean {
  const needle: string = filter.q.trim().toLowerCase();
  if (!matchesText(module, needle)) {
    return false;
  }
  if (skip !== 'lang' && filter.lang.length > 0 && !filter.lang.includes(languageOf(module.category))) {
    return false;
  }
  if (skip !== 'h' && filter.h.length > 0 && !filter.h.includes(hFacetOf(module))) {
    return false;
  }
  if (skip !== 'setup' && filter.setup.length > 0 && !filter.setup.includes(setupFacetOf(module))) {
    return false;
  }
  if (skip !== 'avail' && filter.avail !== 'all' && availabilityFacetOf(module) !== filter.avail) {
    return false;
  }
  return true;
}

export function filterModules(
  modules: readonly ModuleSummaryT[],
  filter: ModuleFilterState,
): readonly ModuleSummaryT[] {
  return modules.filter((m): boolean => moduleMatches(m, filter));
}

export interface FacetValueCount {
  readonly value: string;
  readonly count: number;
}

export interface FacetGroups {
  /** LANGUAGE values A→Z with live counts. */
  readonly lang: readonly FacetValueCount[];
  readonly h: readonly FacetValueCount[];
  readonly setup: readonly FacetValueCount[];
  /** LAST CHECK values with live counts ('all' = every module). */
  readonly avail: readonly FacetValueCount[];
}

/**
 * LIVE facet counts: every group is counted over the modules matching
 * the text search + the OTHER groups' selections (`skip`), so selecting
 * LANGUAGE:English still shows how many of those need credentials.
 */
export function facetCounts(modules: readonly ModuleSummaryT[], filter: ModuleFilterState): FacetGroups {
  const lang = new Map<string, number>();
  const h = new Map<string, number>();
  const setup = new Map<string, number>();
  const avail = new Map<string, number>();
  for (const module of modules) {
    if (moduleMatches(module, filter, 'lang')) {
      const key: string = languageOf(module.category);
      lang.set(key, (lang.get(key) ?? 0) + 1);
    }
    if (moduleMatches(module, filter, 'h')) {
      const key: HFacetValue = hFacetOf(module);
      h.set(key, (h.get(key) ?? 0) + 1);
    }
    if (moduleMatches(module, filter, 'setup')) {
      const key: SetupFacetValue = setupFacetOf(module);
      setup.set(key, (setup.get(key) ?? 0) + 1);
    }
    if (moduleMatches(module, filter, 'avail')) {
      const key: AvailabilityFacetValue = availabilityFacetOf(module);
      avail.set(key, (avail.get(key) ?? 0) + 1);
    }
  }
  const byValue = (a: FacetValueCount, b: FacetValueCount): number =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  const entries = (map: Map<string, number>): readonly FacetValueCount[] =>
    [...map.entries()].map(([value, count]): FacetValueCount => ({ value, count })).sort(byValue);
  return { lang: entries(lang), h: entries(h), setup: entries(setup), avail: entries(avail) };
}

export const H_FACET_LABELS: Readonly<Record<HFacetValue, string>> = {
  h: 'H / adult',
  safe: 'Standard',
};

export const SETUP_FACET_LABELS: Readonly<Record<SetupFacetValue, string>> = {
  'no-setup': 'No setup needed',
  creds: 'Needs credentials',
};

export const AVAILABILITY_FACET_LABELS: Readonly<Record<AvailabilityFacetValue, string>> = {
  reachable: 'Reachable',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
};

// ── URL codec (?q=&lang=&h=&setup=&filter= on #/settings) ────────────

const H_VALUES: readonly HFacetValue[] = ['h', 'safe'];
const SETUP_VALUES: readonly SetupFacetValue[] = ['creds', 'no-setup'];
const AVAIL_VALUES: readonly AvailabilityFacetValue[] = ['reachable', 'unreachable', 'unknown'];

function parseCsv(raw: string | undefined, allowed?: readonly string[]): readonly string[] {
  if (raw === undefined || raw === '') {
    return [];
  }
  const parts = raw
    .split(',')
    .map((part): string => part.trim())
    .filter((part): boolean => part !== '');
  const filtered = allowed === undefined ? parts : parts.filter((p): boolean => allowed.includes(p));
  return [...new Set(filtered)];
}

/**
 * Decode the query params. Unknown values are dropped (a shared URL
 * never filters to a mismatched registry) — same posture as the site
 * picker's parseCatsParam. `validLang` bounds the language set; the
 * LAST CHECK facet rides `?filter=` (single-select, 'all' default).
 */
export function parseModuleFilter(
  query: Record<string, string>,
  validLang: readonly string[],
): ModuleFilterState {
  const rawFilter = query['filter'];
  return {
    q: query['q'] ?? '',
    lang: parseCsv(query['lang'], validLang),
    h: parseCsv(query['h'], H_VALUES) as readonly HFacetValue[],
    setup: parseCsv(query['setup'], SETUP_VALUES) as readonly SetupFacetValue[],
    avail:
      rawFilter !== undefined && (AVAIL_VALUES as readonly string[]).includes(rawFilter)
        ? (rawFilter as AvailabilityFacetValue)
        : 'all',
  };
}

/** Serialize back to query params (omitted when empty — clean URLs). */
export function serializeModuleFilter(filter: ModuleFilterState): Record<string, string> {
  const out: Record<string, string> = {};
  if (filter.q !== '') {
    out['q'] = filter.q;
  }
  if (filter.lang.length > 0) {
    out['lang'] = [...filter.lang].sort().join(',');
  }
  if (filter.h.length > 0) {
    out['h'] = [...filter.h].sort().join(',');
  }
  if (filter.setup.length > 0) {
    out['setup'] = [...filter.setup].sort().join(',');
  }
  if (filter.avail !== 'all') {
    out['filter'] = filter.avail;
  }
  return out;
}

export function isFilterActive(filter: ModuleFilterState, total: number, shown: number): boolean {
  return (
    filter.q !== '' ||
    filter.lang.length > 0 ||
    filter.h.length > 0 ||
    filter.setup.length > 0 ||
    filter.avail !== 'all' ||
    shown !== total
  );
}
