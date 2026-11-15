import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ModuleId } from '@fmd/contract';
import type {
  ModuleStatePersistence,
  PersistedModuleState,
} from '../../engine/state/persistence.js';

/**
 * The one-shot import commands' SQLite targets (§9 app.db). The import is
 * a migration tool: it CREATES the §9 tables it owns when absent
 * (`CREATE TABLE IF NOT EXISTS` — the db story's migrations are
 * compatible supersets) and upserts rows, never destructive.
 *
 * `module_state` carries BOTH the §9 registry columns (name/root_url/
 * category/file/last_seen/capabilities — owned by the registry sweep)
 * AND the §5.3 runtime columns (enabled/options/cookies/ua/storage —
 * owned here). The import upsert touches ONLY the runtime columns, so an
 * import into an existing registry db preserves the registry rows.
 */

/** Open (create) the app.db import target; parent dirs are created. */
export function openAppDb(path: string): Database.Database {
  const parent = dirname(path);
  if (parent !== '' && parent !== '.') {
    mkdirSync(parent, { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  return db;
}

/** The §9 tables the import commands own. */
export function ensureImportSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_state (
      id           TEXT PRIMARY KEY,
      enabled      INTEGER NOT NULL DEFAULT 1,
      options      TEXT,
      name         TEXT,
      root_url     TEXT,
      category     TEXT,
      file         TEXT,
      last_seen    INTEGER,
      cookies      TEXT,
      ua           TEXT,
      storage      TEXT,
      capabilities TEXT
    );
  `);
}

interface ModuleStateDbRow {
  readonly id: string;
  readonly enabled: number;
  readonly options: string | null;
  readonly cookies: string | null;
  readonly ua: string | null;
  readonly storage: string | null;
}

function parseJsonObject(text: string | null): Record<string, unknown> {
  if (text === null || text === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The §5.3 `ModuleStatePersistence` boundary over app.db `module_state`
 * (the import target; the runtime adapter is the db story's concern). */
export class SqliteImportModuleState implements ModuleStatePersistence {
  private readonly db: Database.Database;

  public constructor(db: Database.Database) {
    ensureImportSchema(db);
    this.db = db;
  }

  public loadAll(): Record<string, PersistedModuleState> {
    const rows = this.db
      .prepare(`SELECT id, enabled, options, cookies, ua, storage FROM module_state`)
      .all() as ModuleStateDbRow[];
    const out: Record<string, PersistedModuleState> = {};
    for (const row of rows) {
      out[row.id] = {
        cookies: row.cookies ?? '',
        ua: row.ua ?? '',
        enabled: row.enabled !== 0,
        options: parseJsonObject(row.options) as PersistedModuleState['options'],
        storage: parseJsonObject(row.storage) as PersistedModuleState['storage'],
      };
    }
    return out;
  }

  public save(moduleId: ModuleId, state: PersistedModuleState): void {
    // Upsert of the §5.3 runtime columns ONLY — registry columns
    // (name/root_url/category/file/last_seen/capabilities) survive.
    this.db
      .prepare(
        `INSERT INTO module_state (id, enabled, options, cookies, ua, storage)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           options = excluded.options,
           cookies = excluded.cookies,
           ua      = excluded.ua,
           storage = excluded.storage`,
      )
      .run(
        moduleId,
        state.enabled ? 1 : 0,
        JSON.stringify(state.options ?? {}),
        state.cookies,
        state.ua,
        JSON.stringify(state.storage ?? {}),
      );
  }

  public row(moduleId: string): (PersistedModuleState & { readonly id: string }) | undefined {
    const row = this.db
      .prepare(`SELECT id, enabled, options, cookies, ua, storage FROM module_state WHERE id = ?`)
      .get(moduleId) as ModuleStateDbRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      cookies: row.cookies ?? '',
      ua: row.ua ?? '',
      enabled: row.enabled !== 0,
      options: parseJsonObject(row.options) as PersistedModuleState['options'],
      storage: parseJsonObject(row.storage) as PersistedModuleState['storage'],
    };
  }

  public get size(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM module_state`).get() as { n: number }).n;
  }
}
