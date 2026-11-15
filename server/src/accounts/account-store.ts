import type Database from 'better-sqlite3';

/**
 * The §9 `account` table store — module-scoped account rows with the
 * sensitive triple (username/password/cookies) SEALED at rest
 * (`accounts/secret-box.ts`, FMD_WEB_SECRET + AES-256-GCM). FMD2 keeps
 * exactly one account per module (`TWebsiteModuleAccount`,
 * WebsiteModules.pas:80-99); the store mirrors that with a UNIQUE
 * module_id — CRUD is insert-or-replace per module.
 *
 * Schema deviation note vs the §9 sketch (`account(id PK, module_id,
 * username, password_enc, cookies, status)`): the sketch predates the
 * hardening story; acceptance criterion 4 ("db file inspection shows no
 * plaintext secrets") governs — a session cookie IS a secret and the
 * username travels the same FMD2 EncryptString channel — so all three
 * fields are sealed columns (`username_enc`, `password_enc`,
 * `cookies_enc`). `status` is the module AccountState ordinal
 * (0 asUnknown / 1 asChecking / 2 asValid / 3 asInvalid,
 * WebsiteModules.pas:78).
 */

export type AccountStatusOrdinal = 0 | 1 | 2 | 3;

/** One sealed §9 account row (as stored; readers seal/open explicitly). */
export interface SealedAccountRow {
  readonly moduleId: string;
  readonly usernameEnc: string;
  readonly passwordEnc: string;
  readonly cookiesEnc: string;
  readonly status: AccountStatusOrdinal;
  readonly enabled: boolean;
  /** Epoch ms of the last write (bookkeeping, not API surface). */
  readonly updatedAt: number;
}

export function ensureAccountsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id    TEXT NOT NULL UNIQUE,
      username_enc TEXT NOT NULL DEFAULT '',
      password_enc TEXT NOT NULL DEFAULT '',
      cookies_enc  TEXT NOT NULL DEFAULT '',
      status       INTEGER NOT NULL DEFAULT 0,
      enabled      INTEGER NOT NULL DEFAULT 1,
      updated_at   INTEGER NOT NULL
    );
  `);
}

interface AccountDbRow {
  readonly module_id: string;
  readonly username_enc: string;
  readonly password_enc: string;
  readonly cookies_enc: string;
  readonly status: number;
  readonly enabled: number;
  readonly updated_at: number;
}

function toSealed(row: AccountDbRow): SealedAccountRow {
  return {
    moduleId: row.module_id,
    usernameEnc: row.username_enc,
    passwordEnc: row.password_enc,
    cookiesEnc: row.cookies_enc,
    status: (row.status === 1 || row.status === 2 || row.status === 3 ? row.status : 0) as AccountStatusOrdinal,
    enabled: row.enabled !== 0,
    updatedAt: row.updated_at,
  };
}

/** SQLite §9 account store (better-sqlite3, same connection discipline as
 * `SqliteLibraryStore` — ONE handle per thread, synchronous calls). */
export class SqliteAccountStore {
  public constructor(private readonly db: Database.Database) {
    ensureAccountsSchema(this.db);
  }

  /** All rows, insertion order. */
  public list(): SealedAccountRow[] {
    const rows = this.db
      .prepare(
        `SELECT module_id, username_enc, password_enc, cookies_enc, status, enabled, updated_at
           FROM account ORDER BY id`,
      )
      .all() as AccountDbRow[];
    return rows.map(toSealed);
  }

  public get(moduleId: string): SealedAccountRow | undefined {
    const row = this.db
      .prepare(
        `SELECT module_id, username_enc, password_enc, cookies_enc, status, enabled, updated_at
           FROM account WHERE module_id = ?`,
      )
      .get(moduleId) as AccountDbRow | undefined;
    return row === undefined ? undefined : toSealed(row);
  }

  /** Insert-or-replace (the module-scoped UNIQUE). */
  public upsert(row: Omit<SealedAccountRow, 'updatedAt'>): SealedAccountRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO account
            (module_id, username_enc, password_enc, cookies_enc, status, enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(module_id) DO UPDATE SET
            username_enc = excluded.username_enc,
            password_enc = excluded.password_enc,
            cookies_enc  = excluded.cookies_enc,
            status       = excluded.status,
            enabled      = excluded.enabled,
            updated_at   = excluded.updated_at`,
      )
      .run(
        row.moduleId,
        row.usernameEnc,
        row.passwordEnc,
        row.cookiesEnc,
        row.status,
        row.enabled ? 1 : 0,
        now,
      );
    const stored = this.get(row.moduleId);
    if (stored === undefined) {
      throw new Error(`account upsert did not persist: ${row.moduleId}`);
    }
    return stored;
  }

  /** Patch the status/cookies after a login WITHOUT touching the
   * credentials (the login flow's write path). */
  public updateLoginOutcome(moduleId: string, status: AccountStatusOrdinal, cookiesEnc: string): SealedAccountRow {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE account SET status = ?, cookies_enc = ?, updated_at = ? WHERE module_id = ?`,
      )
      .run(status, cookiesEnc, now, moduleId);
    if (result.changes === 0) {
      throw new Error(`no account row to update for module: ${moduleId}`);
    }
    const stored = this.get(moduleId);
    if (stored === undefined) {
      throw new Error(`account login update did not persist: ${moduleId}`);
    }
    return stored;
  }

  /** Remove one module's account; false when absent. */
  public remove(moduleId: string): boolean {
    return this.db.prepare('DELETE FROM account WHERE module_id = ?').run(moduleId).changes > 0;
  }

  public get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n;
  }
}
