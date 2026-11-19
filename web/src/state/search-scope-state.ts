/**
 * Search scope state ([fuzzy-javelin-pearls], D1 §2 ENTER): the
 * scope selector's URL-as-truth codec — the search home's entries are
 * a PURE function of (q, scope, picks).
 *
 * URL params (hash router, riding the existing `#/browse` home):
 *   ?scope=all|preferred|specific   (absent = all, the default)
 *   ?picks=<id1,id2,…>              (specific only — the multi-select,
 *                                    comma-separated, order preserved;
 *                                    named `picks` because `sites` is
 *                                    already the site-picker mode
 *                                    `#/browse?sites=1`)
 *
 * Unknown scope values drop to 'all' (a shared URL never breaks); an
 * empty/absent picks list under scope=specific stays 'specific' with
 * an EMPTY pick set (the teaching empty state, not a silent fall-back
 * to all — scope truth is explicit).
 *
 * Write discipline (the SearchHomePage contract): typing q REPLACES
 * history (shareable, no keystroke spam); a scope change PUSHES
 * (back/forward restore the selector).
 */

export type SearchScope = 'all' | 'preferred' | 'specific';

export interface SearchScopeState {
  readonly scope: SearchScope;
  /** Ordered explicit picks (specific scope only; the `?picks=` param). */
  readonly picks: readonly string[];
}

export const DEFAULT_SEARCH_SCOPE_STATE: SearchScopeState = { scope: 'all', picks: [] };

/** Parse `?scope=` + `?picks=` (both optional; invalid → defaults). */
export function parseSearchScope(query: Record<string, string>): SearchScopeState {
  const rawScope = query['scope'];
  const scope: SearchScope =
    rawScope === 'preferred' || rawScope === 'specific' ? rawScope : 'all';
  if (scope !== 'specific') {
    return { scope, picks: [] };
  }
  const rawPicks = query['picks'];
  const picks =
    rawPicks === undefined || rawPicks === ''
      ? []
      : [
          ...new Set(
            rawPicks
              .split(',')
              .map((part): string => part.trim())
              .filter((part): boolean => part !== ''),
          ),
        ];
  return { scope, picks };
}

/** Serialize back to URL params (omitted entirely at the default). */
export function serializeSearchScope(state: SearchScopeState): Record<string, string> {
  if (state.scope === 'all') {
    return {};
  }
  if (state.scope === 'preferred') {
    return { scope: 'preferred' };
  }
  return state.picks.length > 0
    ? { scope: 'specific', picks: state.picks.join(',') }
    : { scope: 'specific' };
}

/**
 * The scope-ordered candidate list for the live-scrape leg: sites in
 * scope WITHOUT an installed catalog (from the modules registry's
 * catalogInstalled join), in canonical scope order — preferred order
 * for the preferred scope, pick order for specific. Under scope=all
 * this is ALWAYS empty (the all-sites union is zero-network by
 * charter — catalog-less sites surface as excluded chips instead).
 */
export function liveSearchCandidates(
  scope: SearchScopeState,
  preferredOrder: readonly string[],
  registry: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly catalogInstalled: boolean;
    readonly liveCapable: boolean;
  }[],
): readonly { readonly id: string; readonly name: string }[] {
  if (scope.scope === 'all') {
    return [];
  }
  const order: readonly string[] =
    scope.scope === 'preferred' ? preferredOrder : scope.picks;
  const byId = new Map(registry.map((m): readonly [string, typeof m] => [m.id, m]));
  const seen = new Set<string>();
  const out: { readonly id: string; readonly name: string }[] = [];
  for (const id of order) {
    const module = byId.get(id);
    if (module === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    // Disabled scoped sites are invisible (union participation
    // parity); catalog-bearing sites answer from the local index; a
    // catalog-less site WITHOUT the directory-walk capability cannot
    // serve a live search at all (§6.8 supports() gate) — it surfaces
    // through the excluded chips, never as a doomed live request.
    if (module.enabled && !module.catalogInstalled && module.liveCapable) {
      out.push({ id: module.id, name: module.name });
    }
  }
  return out;
}
