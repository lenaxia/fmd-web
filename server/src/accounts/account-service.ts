import type { ModuleId } from '@fmd/contract';
import { ApiError } from '../api/errors.js';
import type { ModuleStatePersistence } from '../engine/facade.js';
import { openSecret, sealSecret, SecretBoxError } from './secret-box.js';
import {
  SqliteAccountStore,
  type AccountStatusOrdinal,
  type SealedAccountRow,
} from './account-store.js';

/**
 * The §10 account seam (DESIGN.md §8.6/D4): module-scoped account CRUD +
 * the OnLogin flow. Reads project a {@link AccountView} that NEVER
 * carries the password (write-only credential) — the stored triple is
 * sealed at rest (`secret-box.ts`, FMD_WEB_SECRET + AES-256-GCM) and is
 * decrypted only inside the service boundary. `login(moduleId)` drives
 * the module's real OnLogin through the event runtime
 * (`runtime/account-login.ts`) with the account-status constants bound
 * (§5.2), then persists the handler-set status into the account row and
 * the handler-set cookies into BOTH the account row and the §5.3
 * module_state row.
 */

export const ACCOUNT_STATUS_NAMES = ['asUnknown', 'asChecking', 'asValid', 'asInvalid'] as const;

export type AccountStatusName = (typeof ACCOUNT_STATUS_NAMES)[AccountStatusOrdinal];

export function accountStatusName(status: AccountStatusOrdinal): AccountStatusName {
  return ACCOUNT_STATUS_NAMES[status];
}

/** Ordinal of the §5.2 account-status constants (clamp + asChecking→asUnknown
 * is NOT applied here — only the import path resets asChecking, mirroring
 * FMD2's LoadFromFile; live logins may legitimately park in asChecking). */
export function accountStatusOrdinal(status: number): AccountStatusOrdinal {
  return (status === 1 || status === 2 || status === 3 ? status : 0) as AccountStatusOrdinal;
}

/** API projection — never the password, never sealed envelopes. */
export interface AccountView {
  readonly moduleId: ModuleId;
  readonly username: string;
  readonly enabled: boolean;
  readonly status: AccountStatusName;
}

/** Upsert body: omitted `password`/`cookies` KEEP the stored values (a
 * username-only edit must not wipe the credential). */
export interface AccountUpsertInput {
  readonly moduleId: ModuleId;
  readonly username: string;
  readonly password?: string;
  readonly cookies?: string;
  readonly enabled?: boolean;
}

/** Credentials handed to the login driver (decrypted in-memory only). */
export interface LoginCredentials {
  readonly enabled: boolean;
  readonly username: string;
  readonly password: string;
}

/** What a module OnLogin run produced (handler-set Account fields). */
export interface LoginOutcome {
  readonly status: AccountStatusOrdinal;
  readonly cookies: string;
}

/** The event-runtime seam behind `AccountService.login`. */
export interface AccountLoginDriver {
  login(moduleId: string, credentials: LoginCredentials): Promise<LoginOutcome>;
}

export interface AccountService {
  list(): AccountView[];
  get(moduleId: string): AccountView | undefined;
  upsert(input: AccountUpsertInput): AccountView;
  remove(moduleId: string): void;
  /** Run the module OnLogin flow; persists status + cookies. */
  login(moduleId: string): Promise<AccountView>;
}

export interface SqliteAccountServiceOptions {
  readonly store: SqliteAccountStore;
  /** Deployment secret provider (env-bound in the runtime assembly). */
  readonly secret: () => string;
  /** Engine-backed OnLogin driver; omitted → login is a 503-style error. */
  readonly loginDriver?: AccountLoginDriver;
  /** §5.3 module_state persistence — login cookies land here too. */
  readonly statePersistence?: ModuleStatePersistence;
}

export class SqliteAccountService implements AccountService {
  public constructor(private readonly options: SqliteAccountServiceOptions) {}

  private requireSecret(): string {
    const secret = this.options.secret();
    if (secret === '') {
      throw new ApiError(500, 'internal_error', 'FMD_WEB_SECRET is not configured — accounts are unavailable');
    }
    return secret;
  }

  private openRow(row: SealedAccountRow): { username: string; password: string; cookies: string } {
    const secret = this.requireSecret();
    try {
      return {
        username: openSecret(row.usernameEnc, secret),
        password: openSecret(row.passwordEnc, secret),
        cookies: openSecret(row.cookiesEnc, secret),
      };
    } catch (err: unknown) {
      if (err instanceof SecretBoxError) {
        throw new ApiError(
          500,
          'internal_error',
          `account decryption failed for ${row.moduleId} — check FMD_WEB_SECRET (${err.message})`,
        );
      }
      throw err;
    }
  }

  private toView(row: SealedAccountRow): AccountView {
    const { username } = this.openRow(row);
    return {
      moduleId: row.moduleId as ModuleId,
      username,
      enabled: row.enabled,
      status: accountStatusName(row.status),
    };
  }

  public list(): AccountView[] {
    return this.options.store.list().map((row): AccountView => this.toView(row));
  }

  public get(moduleId: string): AccountView | undefined {
    const row = this.options.store.get(moduleId);
    return row === undefined ? undefined : this.toView(row);
  }

  public upsert(input: AccountUpsertInput): AccountView {
    const secret = this.requireSecret();
    const existing = this.options.store.get(input.moduleId);
    // Omitted password/cookies KEEP the stored (still-sealed) values —
    // the credential is never round-tripped through the API.
    const password = input.password ?? (existing === undefined ? '' : openSecret(existing.passwordEnc, secret));
    const cookies = input.cookies ?? (existing === undefined ? '' : openSecret(existing.cookiesEnc, secret));
    const stored = this.options.store.upsert({
      moduleId: input.moduleId,
      usernameEnc: sealSecret(input.username, secret),
      passwordEnc: sealSecret(password, secret),
      cookiesEnc: sealSecret(cookies, secret),
      status: existing?.status ?? 0,
      enabled: input.enabled ?? existing?.enabled ?? true,
    });
    return this.toView(stored);
  }

  public remove(moduleId: string): void {
    if (!this.options.store.remove(moduleId)) {
      throw new ApiError(404, 'not_found', `no account for module: ${moduleId}`);
    }
  }

  public async login(moduleId: string): Promise<AccountView> {
    const row = this.options.store.get(moduleId);
    if (row === undefined) {
      throw new ApiError(404, 'not_found', `no account for module: ${moduleId}`);
    }
    if (!row.enabled) {
      throw new ApiError(409, 'conflict', `account for ${moduleId} is disabled — enable it before login`);
    }
    const driver = this.options.loginDriver;
    if (driver === undefined) {
      throw new ApiError(502, 'upstream_error', 'no engine login driver is wired — accounts login is unavailable');
    }
    const { username, password } = this.openRow(row);
    let outcome: LoginOutcome;
    try {
      outcome = await driver.login(moduleId, { enabled: row.enabled, username, password });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(
        502,
        'upstream_error',
        `module OnLogin failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const secret = this.requireSecret();
    const stored = this.options.store.updateLoginOutcome(
      moduleId,
      outcome.status,
      sealSecret(outcome.cookies, secret),
    );
    // §5.3: the login cookies persist into module_state (merged with the
    // existing row so ua/options/storage survive).
    const persistence = this.options.statePersistence;
    if (persistence !== undefined) {
      const rows = await persistence.loadAll();
      const current = rows[moduleId];
      await persistence.save(moduleId as ModuleId, {
        cookies: outcome.cookies,
        ua: current?.ua ?? '',
        enabled: current?.enabled ?? true,
        options: { ...(current?.options ?? {}) },
        storage: { ...(current?.storage ?? {}) },
      });
    }
    return this.toView(stored);
  }
}

/** Injectable login behavior for the in-memory double (route tests). */
export type InMemoryLoginBehavior = (
  moduleId: string,
  credentials: LoginCredentials,
) => Promise<LoginOutcome> | LoginOutcome;

interface InMemoryAccountRow {
  username: string;
  password: string;
  cookies: string;
  status: AccountStatusOrdinal;
  enabled: boolean;
}

/** In-memory account store (dev/test stand-in for app.db `account`) —
 * plaintext rows (never touches disk); the SQLite service carries the
 * sealing boundary. Login delegates to the injected behavior. */
export class InMemoryAccountService implements AccountService {
  private readonly rows = new Map<string, InMemoryAccountRow>();

  public constructor(private readonly loginBehavior: InMemoryLoginBehavior = (): LoginOutcome => ({ status: 0, cookies: '' })) {}

  list(): AccountView[] {
    return [...this.rows.keys()].sort().map((id) => this.viewOf(id, this.rows.get(id) as InMemoryAccountRow));
  }

  get(moduleId: string): AccountView | undefined {
    const row = this.rows.get(moduleId);
    return row === undefined ? undefined : this.viewOf(moduleId, row);
  }

  upsert(input: AccountUpsertInput): AccountView {
    const existing = this.rows.get(input.moduleId);
    const row: InMemoryAccountRow = {
      username: input.username,
      password: input.password ?? existing?.password ?? '',
      cookies: input.cookies ?? existing?.cookies ?? '',
      status: existing?.status ?? 0,
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
    this.rows.set(input.moduleId, row);
    return this.viewOf(input.moduleId, row);
  }

  remove(moduleId: string): void {
    if (!this.rows.delete(moduleId)) {
      throw new ApiError(404, 'not_found', `no account for module: ${moduleId}`);
    }
  }

  async login(moduleId: string): Promise<AccountView> {
    const row = this.rows.get(moduleId);
    if (row === undefined) {
      throw new ApiError(404, 'not_found', `no account for module: ${moduleId}`);
    }
    if (!row.enabled) {
      throw new ApiError(409, 'conflict', `account for ${moduleId} is disabled — enable it before login`);
    }
    const outcome = await this.loginBehavior(moduleId, {
      enabled: row.enabled,
      username: row.username,
      password: row.password,
    });
    row.status = outcome.status;
    row.cookies = outcome.cookies;
    return this.viewOf(moduleId, row);
  }

  private viewOf(moduleId: string, row: InMemoryAccountRow): AccountView {
    return {
      moduleId: moduleId as ModuleId,
      username: row.username,
      enabled: row.enabled,
      status: accountStatusName(row.status),
    };
  }
}
