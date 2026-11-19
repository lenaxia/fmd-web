/**
 * Preferred-sites allowlist ([fuzzy-javelin-pearls], D1 §2 ENTER): ONE
 * global, user-ORDERED list of sites the operator actually uses — the
 * canonical order (D1 §3) that fixes scope ordering, presentation
 * order in the site picker, and duplicate-title resolution order.
 *
 * Persistence: the `app_settings` kv row `search.preferredSites`
 * (JSON string-array, order-preserving — the same posture as the
 * favorites scheduler seed and the file-state rescan report). Single
 * user per instance (R2/D1 §4.1): no per-user dimension exists or is
 * ever added.
 *
 * Semantics (deliberately minimal):
 * - The list is a REPLACEMENT on every write — PUT carries the full
 *   ordered set (adding/removing a site in the UI is one decision
 *   sent as the next full list; D1 §2 "one-decision add").
 * - Unknown module ids are REFUSED by the route (typed 400 naming
 *   them — the no_site_match posture); known ids are deduped with
 *   FIRST occurrence winning (the canonical position).
 * - Reads never mutate (GET never mutates, D1 §3).
 * - The list is advisory scope, never a gate: a dead preferred site
 *   dims everywhere it renders (availability hint posture) and is
 *   never hidden or dropped by this service.
 */
// (no runtime imports — persistence + order only; registry
// validation lives at the API route)

/** app_settings kv key holding the ordered allowlist (JSON array). */
export const PREFERRED_SITES_SETTINGS_KEY = 'search.preferredSites';

/** Hard ceiling on the allowlist (the full registry is ~454 sites). */
export const PREFERRED_SITES_MAX = 512;

/** The app-level seam the API layer consumes (tests inject fakes). */
export interface PreferredSitesService {
  /** The ordered allowlist (canonical order; empty when unset). */
  list(): readonly string[];
  /**
   * Full-list replacement. Unknown module ids throw — the route maps
   * that to the typed 400; dedup keeps the first position; the
   * persisted order is exactly the submitted order.
   */
  set(ids: readonly string[]): readonly string[];
  /** `true` when the id sits in the allowlist (the /api/modules join). */
  includes(id: string): boolean;
}

/** Decode + defensively coerce a stored row (never trust old bytes). */
function decodeStored(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids = parsed.filter((id): id is string => typeof id === 'string');
    return [...new Set(ids)].slice(0, PREFERRED_SITES_MAX);
  } catch {
    return [];
  }
}

/**
 * The production service: app_settings persistence with cap + dedupe.
 * Registry MEMBERSHIP validation lives at the ROUTE (the same
 * posture as the search `sites=` param — one gate, typed 400s naming
 * the offenders); this service is the ordered-list store.
 */
export class SqlitePreferredSitesService implements PreferredSitesService {
  public constructor(
    private readonly store: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void },
  ) {}

  public list(): readonly string[] {
    return decodeStored(this.store.getSetting(PREFERRED_SITES_SETTINGS_KEY));
  }

  public set(ids: readonly string[]): readonly string[] {
    if (ids.length > PREFERRED_SITES_MAX) {
      throw new Error(`preferred sites list is capped at ${String(PREFERRED_SITES_MAX)} entries`);
    }
    const canonical = [...new Set(ids)];
    this.store.setSetting(PREFERRED_SITES_SETTINGS_KEY, JSON.stringify(canonical));
    return canonical;
  }

  public includes(id: string): boolean {
    return this.list().includes(id);
  }
}

/**
 * In-memory stand-in (the documented test/dev default — the same
 * posture as the other optional ApiServices seams: absent service →
 * the preferred-sites routes are not mounted).
 */
export class InMemoryPreferredSitesService implements PreferredSitesService {
  private ids: readonly string[] = [];

  public list(): readonly string[] {
    return [...this.ids];
  }

  public set(ids: readonly string[]): readonly string[] {
    this.ids = [...new Set(ids)];
    return [...this.ids];
  }

  public includes(id: string): boolean {
    return this.ids.includes(id);
  }
}
