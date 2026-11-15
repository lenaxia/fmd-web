import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ReadinessStatus } from '@fmd/contract';

/**
 * Readiness probes (DESIGN.md §10): `/healthz` is liveness (the process
 * answers — nothing else), `/readyz` is READINESS over three concrete
 * checks:
 *
 * 1. `db` — every app SQLite database (app.db = queue + library) opens
 *    and answers `SELECT 1`;
 * 2. `catalogs` — every installed catalog file under `data/catalogs/`
 *    is ATTACHABLE: opens read-only and answers a `sqlite_master` probe
 *    (a corrupted/truncated file fails here — the fault-injection test);
 * 3. `luaTree` — the synced module tree exists with ≥1 `.lua`/`.luac`.
 *
 * Any failing check → `{ ready: false, reason: '…' }` → the app serves
 * `/readyz` as 503 with the human reason while `/healthz` keeps serving
 * 200 (liveness is unaffected by data faults — restart cannot heal a
 * corrupt catalog, so the process must NOT be killed over it).
 *
 * Catalog probes are cached per (path, size, mtimeMs): unchanged files
 * skip re-opening (large catalogs, frequent probes); any byte-level
 * change — including corruption — invalidates the cache and re-probes.
 * The SAME check primitives back restore validation (backup.ts).
 */

export interface ProbeCheck {
  /** Probe family: `db` | `catalogs` | `luaTree`. */
  readonly check: string;
  /** Specific target within the family (file path). */
  readonly target?: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface ReadinessProbeOptions {
  readonly dataDir: string;
  /**
   * App DBs that must open + answer (default: `<dataDir>/app.db` when
   * present on disk; a not-yet-created db is NOT a fault in tests).
   */
  readonly dbPaths?: readonly string[];
  readonly catalogDir?: string;
  readonly luaModulesDir?: string;
  /** Skip the db check entirely (API-only deployments). Default false. */
  readonly requireDb?: boolean;
  /**
   * Run the lua-tree check (`data/lua/modules` present with ≥1 module
   * file). Default true. `FMD_BOOTSTRAP_DISABLE=1` deployments skip the
   * D20 first-run sync (the operator owns provisioning), so the tree
   * check would permanently fail an otherwise-valid deployment — the
   * runtime turns it off together with the bootstrap.
   */
  readonly requireLuaTree?: boolean;
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Cheap byte-level sniff: is this file even a SQLite db? */
function looksLikeSqlite(file: string): boolean {
  const header = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  try {
    const read = readSync(fd, header, 0, 16, 0);
    return read >= 15 && header.subarray(0, 15).toString('latin1') === SQLITE_MAGIC.slice(0, 15);
  } finally {
    closeSync(fd);
  }
}

/** Open + answer one app DB (the `db` family probe body). */
function probeAppDb(file: string): ProbeCheck {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      db.prepare('SELECT 1').get();
      return { check: 'db', target: file, ok: true };
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    return { check: 'db', target: file, ok: false, error: messageOf(err) };
  }
}

/** Open + sqlite_master probe one catalog file (the `catalogs` family). */
function probeCatalog(file: string): ProbeCheck {
  try {
    if (!looksLikeSqlite(file)) {
      throw new Error('file is not a database (bad header)');
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return { check: 'catalogs', target: file, ok: true };
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    return { check: 'catalogs', target: file, ok: false, error: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Probe the lua tree (`luaTree` family): present + ≥1 module file. */
function probeLuaTree(dir: string): ProbeCheck {
  if (!existsSync(dir)) {
    return { check: 'luaTree', target: dir, ok: false, error: 'module tree missing (not synced yet)' };
  }
  try {
    const entries = readdirSync(dir);
    const hasModule = entries.some((entry) => entry.endsWith('.lua') || entry.endsWith('.luac'));
    if (!hasModule) {
      return { check: 'luaTree', target: dir, ok: false, error: 'module tree has no .lua/.luac files' };
    }
    return { check: 'luaTree', target: dir, ok: true };
  } catch (err: unknown) {
    return { check: 'luaTree', target: dir, ok: false, error: messageOf(err) };
  }
}

/** One catalog file (changed on disk ⇒ probe again, else cached result). */
class CatalogProbeCache {
  private readonly cached = new Map<string, { size: number; mtimeMs: number; result: ProbeCheck }>();

  probe(file: string): ProbeCheck {
    const stat = statSync(file);
    const prior = this.cached.get(file);
    if (prior !== undefined && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
      return prior.result;
    }
    const result = probeCatalog(file);
    this.cached.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, result });
    return result;
  }
}

/** The readiness probe behind `services.readiness`. Catalog results are
 * cached per file-identity (see {@link CatalogProbeCache}). */
export class ReadinessProbe {
  private readonly dbPaths: readonly string[];
  private readonly catalogDir: string;
  private readonly luaModulesDir: string;
  private readonly requireDb: boolean;
  private readonly requireLuaTree: boolean;
  private readonly catalogCache = new CatalogProbeCache();

  constructor(options: ReadinessProbeOptions) {
    this.dbPaths = options.dbPaths ?? [join(options.dataDir, 'app.db')];
    this.catalogDir = options.catalogDir ?? join(options.dataDir, 'catalogs');
    this.luaModulesDir = options.luaModulesDir ?? join(options.dataDir, 'lua', 'modules');
    this.requireDb = options.requireDb ?? true;
    this.requireLuaTree = options.requireLuaTree ?? true;
  }

  /** Run every check; full detail available via {@link checks}. */
  readiness(): ReadinessStatus {
    const results = this.checks();
    const failures = results.filter((result) => !result.ok);
    if (failures.length === 0) {
      return { ready: true };
    }
    const reason = failures
      .map((f) => `${f.check}${f.target !== undefined ? ` (${f.target})` : ''}: ${f.error ?? 'failed'}`)
      .join('; ');
    return { ready: false, reason };
  }

/** The `() => ReadinessStatus` seam (ApiServices.readiness). */
  readonly probe = (): ReadinessStatus => this.readiness();

  /** Run all checks and return the detail (probe + restore validation). */
  checks(): readonly ProbeCheck[] {
    const results: ProbeCheck[] = [];
    if (this.requireDb) {
      for (const file of this.dbPaths) {
        if (!existsSync(file)) {
          results.push({ check: 'db', target: file, ok: false, error: 'app db missing' });
        } else {
          results.push(probeAppDb(file));
        }
      }
    }
    if (existsSync(this.catalogDir)) {
      for (const entry of readdirSync(this.catalogDir)) {
        if (!entry.endsWith('.db') || entry.endsWith('-journal') || entry.endsWith('-wal')) {
          continue;
        }
        results.push(this.catalogCache.probe(join(this.catalogDir, entry)));
      }
    }
    if (this.requireLuaTree) {
      results.push(probeLuaTree(this.luaModulesDir));
    }
    return results;
  }
}

/**
 * Compose readiness sources in precedence order: the FIRST not-ready
 * status wins (so the D20 bootstrap stage reason shows while booting,
 * and data faults surface once boot completed — restart-healing faults
 * gate first, unrecoverable ones after).
 */
export function composeReadiness(
  ...probes: readonly (() => ReadinessStatus)[]
): () => ReadinessStatus {
  return (): ReadinessStatus => {
    for (const probe of probes) {
      const status = probe();
      if (!status.ready) {
        return status;
      }
    }
    return { ready: true };
  };
}
