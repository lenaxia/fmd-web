import type { RegistrationRecord } from './capabilities.js';
import { ModuleSyncService, sortRegistrations, type SweepSummary } from './module-sync.js';
import type { ModuleRegistryPersistence } from './persistence.js';

/**
 * Startup service (DESIGN.md §9/§10): wires the ModuleSyncService + LuaHost
 * Init pass into ONE registry boot. SHA-gated — the §9 re-Init contract:
 *
 * - first boot (or empty store): full sweep → module_state rows persisted
 *   together with the tree SHA;
 * - restart over a store whose SHA matches the current tree: the registry
 *   is restored from module_state WITHOUT re-running the Init pass;
 * - tree SHA changed (new lua/ sync, edited module): fresh sweep (re-Init)
 *   replaces the rows atomically.
 */

export type BootSource = 'sweep' | 'cache';

export interface BootResult {
  readonly source: BootSource;
  readonly treeSha: string;
  readonly modules: readonly RegistrationRecord[];
  /** The sweep summary (fresh sweeps only; undefined on cache hits). */
  readonly summary?: SweepSummary;
}

export class StartupRegistryService {
  /** The last boot's registry (query surface for /api/modules et al). */
  private booted: BootResult | null = null;

  constructor(
    private readonly sync: ModuleSyncService,
    private readonly persistence: ModuleRegistryPersistence,
  ) {}

  /**
   * Boot (idempotent): returns the registry, sweeping only when the
   * persisted SHA does not match the current tree.
   */
  async boot(): Promise<BootResult> {
    if (this.booted !== null) {
      return this.booted;
    }
    const persisted = await this.persistence.loadAll();
    const treeSha = this.sync.treeSha();
    if (persisted.sha === treeSha && Object.keys(persisted.rows).length > 0) {
      this.booted = {
        source: 'cache',
        treeSha,
        modules: sortRegistrations(Object.values(persisted.rows)),
      };
      return this.booted;
    }    // Full Init sweep — per-file isolation inside (never throws).
    const result = await this.sync.sweep();
    await this.persistence.saveAll({
      sha: result.summary.treeSha,
      rows: Object.fromEntries(result.registrations.map((r) => [r.id, r])),
    });
    this.booted = {
      source: 'sweep',
      treeSha: result.summary.treeSha,
      modules: result.registrations,
      summary: result.summary,
    };
    return this.booted;
  }

  /** The registry after boot (throws before the first boot). */
  get modules(): readonly RegistrationRecord[] {
    if (this.booted === null) {
      throw new Error('registry not booted');
    }
    return this.booted.modules;
  }

  byId(id: string): RegistrationRecord | undefined {
    return this.modules.find((m) => m.id === id);
  }

  /** D3 known-broken projection: contract flag id → modules carrying it. */
  knownBroken(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const reg of this.modules) {
      for (const flag of reg.capabilities.known_broken_flags) {
        (out[flag] ??= []).push(reg.name);
      }
    }
    for (const names of Object.values(out)) {
      names.sort();
    }
    return out;
  }
}
