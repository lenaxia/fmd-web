import type { ModuleId } from '@fmd/contract';

/**
 * module_state persistence (DESIGN.md §9) — the `module_state` row's
 * `cookies`/`ua` columns (`module_state(id PK, enabled, options JSON, name,
 * root_url, category, file, last_seen, cookies TEXT, ua TEXT, …)`). The
 * shared state service (§5.3) loads a module's row when its state instance
 * is first created and writes it back on bypass persistence / flush, so
 * bypassed cookies + UA survive a service restart. The SQLite adapter is
 * the db story's concern; this module defines the boundary + a dev/test
 * in-memory store.
 */

export interface PersistedModuleState {
  /** ';'-joined cookie text (FMD2 `Settings.HTTP.Cookies` form). */
  readonly cookies: string;
  /** `Settings.HTTP.UserAgent`. */
  readonly ua: string;
  readonly enabled: boolean;
  /** Option values keyed by option name. */
  readonly options: Readonly<Record<string, boolean | string | number>>;
  /** `MODULE.Storage` KV contents. */
  readonly storage: Readonly<Record<string, string>>;
}

export interface ModuleStatePersistence {
  /** All persisted rows (called lazily, once per service instance). */
  loadAll(): Promise<Record<string, PersistedModuleState>> | Record<string, PersistedModuleState>;
  /** Upsert one module's row. */
  save(moduleId: ModuleId, state: PersistedModuleState): Promise<void> | void;
}

/** In-memory module_state store (dev/test stand-in for app.db). */
export class InMemoryModuleStatePersistence implements ModuleStatePersistence {
  private readonly rows = new Map<string, PersistedModuleState>();

  constructor(initial?: Record<string, PersistedModuleState>) {
    if (initial !== undefined) {
      for (const [id, row] of Object.entries(initial)) {
        this.rows.set(id, row);
      }
    }
  }

  loadAll(): Record<string, PersistedModuleState> {
    return Object.fromEntries(this.rows);
  }

  save(moduleId: ModuleId, state: PersistedModuleState): void {
    this.rows.set(moduleId, state);
  }

  row(moduleId: ModuleId): PersistedModuleState | undefined {
    return this.rows.get(moduleId);
  }

  get size(): number {
    return this.rows.size;
  }
}
