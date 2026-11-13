import type { RegistrationRecord } from './capabilities.js';

/**
 * module_state REGISTRY persistence (DESIGN.md §9 — the registry columns of
 * `module_state(id PK, enabled, options JSON, name, root_url, category,
 * file, last_seen, …)`): one row per registered module — id, name,
 * root_url, category, options schema (JSON), file, capabilities — plus the
 * lua-tree SHA the registry was built from. On boot, a SHA match restores
 * the registry from these rows WITHOUT re-running the Init pass; a changed
 * SHA (new sync / edited tree) triggers a fresh sweep (re-Init).
 *
 * The runtime columns of the same table (cookies/ua/enabled/options
 * values) are the §5.3 state service's boundary (`state/persistence.ts`);
 * the SQLite adapter is the db story's concern — this module defines the
 * boundary + a dev/test in-memory store.
 */

export interface PersistedRegistry {
  /** SHA-256 over the swept tree (sorted per-file source hashes). */
  readonly sha: string | null;
  /** Registration rows keyed by module id (module_state.id PK). */
  readonly rows: Readonly<Record<string, RegistrationRecord>>;
}

export interface ModuleRegistryPersistence {
  /** The persisted registry (sha + rows), or `{sha: null, rows: {}}`. */
  loadAll(): Promise<PersistedRegistry> | PersistedRegistry;
  /** Replace the whole registry (one sweep batch, atomic). */
  saveAll(registry: PersistedRegistry): Promise<void> | void;
}

/** In-memory module_state registry store (dev/test stand-in for app.db). */
export class InMemoryModuleRegistryPersistence implements ModuleRegistryPersistence {
  private registry: PersistedRegistry = { sha: null, rows: {} };

  constructor(initial?: PersistedRegistry) {
    if (initial !== undefined) {
      this.registry = initial;
    }
  }

  loadAll(): PersistedRegistry {
    return this.registry;
  }

  saveAll(registry: PersistedRegistry): void {
    this.registry = registry;
  }

  row(id: string): RegistrationRecord | undefined {
    return this.registry.rows[id];
  }

  get sha(): string | null {
    return this.registry.sha;
  }

  get size(): number {
    return Object.keys(this.registry.rows).length;
  }
}
