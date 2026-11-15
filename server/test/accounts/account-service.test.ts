/**
 * The §8.6/D4 account service over SQLite: CRUD with the sealing
 * boundary, credential-keeping upsert semantics, and the login flow —
 * a mock OnLogin driver returning account-status constants, the status
 * persisted into the account row and the cookies persisted into BOTH the
 * account row and the §5.3 module_state row.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAccountStore } from '../../src/accounts/account-store.js';
import {
  accountStatusOrdinal,
  accountStatusName,
  SqliteAccountService,
  type LoginOutcome,
} from '../../src/accounts/account-service.js';
import { openSecret } from '../../src/accounts/secret-box.js';
import { InMemoryModuleStatePersistence } from '../../src/engine/state/persistence.js';

const SECRET = 'test-deployment-secret';
const MODULE_A = 'a'.repeat(32);
const MODULE_B = 'b'.repeat(32);

interface Fixture {
  readonly db: Database.Database;
  readonly store: SqliteAccountStore;
  readonly state: InMemoryModuleStatePersistence;
  readonly dir: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'fmd-account-service-'));
  const db = new Database(join(dir, 'app.db'));
  return { db, store: new SqliteAccountStore(db), state: new InMemoryModuleStatePersistence(), dir };
}

const fixtures: Fixture[] = [];
function tracked(): Fixture {
  const fixture = makeFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach((): void => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
  }
});

/** Mock OnLogin driver: the module-shaped behavior — credential check,
 * then the handler sets Status (§5.2 constants) + Cookies. */
function mockLoginDriver(
  check: (creds: { username: string; password: string }) => LoginOutcome,
): {
  calls: Array<{ moduleId: string; username: string; password: string }>;
  login(moduleId: string, creds: { username: string; password: string }): Promise<LoginOutcome>;
} {
  const calls: Array<{ moduleId: string; username: string; password: string }> = [];
  return {
    calls,
    login: async (moduleId: string, creds: { username: string; password: string }): Promise<LoginOutcome> => {
      calls.push({ moduleId, username: creds.username, password: creds.password });
      return check(creds);
    },
  };
}

describe('SqliteAccountService: CRUD with the sealing boundary', (): void => {
  it('upsert stores sealed envelopes only; the view carries the plaintext username', (): void => {
    const fx = tracked();
    const service = new SqliteAccountService({ store: fx.store, secret: (): string => SECRET });
    const view = service.upsert({ moduleId: MODULE_A as never, username: 'reader', password: 'hunter2', cookies: 'sid=1' });
    expect(view).toEqual({ moduleId: MODULE_A, username: 'reader', enabled: true, status: 'asUnknown' });

    const row = fx.store.get(MODULE_A);
    expect(row).toBeDefined();
    expect(row?.usernameEnc).toMatch(/^enc1\./);
    expect(row?.passwordEnc).toMatch(/^enc1\./);
    expect(row?.cookiesEnc).toMatch(/^enc1\./);
    expect(openSecret(row?.usernameEnc as string, SECRET)).toBe('reader');
    expect(openSecret(row?.passwordEnc as string, SECRET)).toBe('hunter2');
    expect(openSecret(row?.cookiesEnc as string, SECRET)).toBe('sid=1');

    expect(service.get(MODULE_A)).toEqual(view);
    expect(service.list()).toHaveLength(1);
  });

  it('omitted password/cookies keep the stored credential; status survives', (): void => {
    const fx = tracked();
    const service = new SqliteAccountService({ store: fx.store, secret: (): string => SECRET });
    service.upsert({ moduleId: MODULE_A as never, username: 'u1', password: 'pw1', cookies: 'c=1' });
    service.upsert({ moduleId: MODULE_A as never, username: 'u2' });

    const row = fx.store.get(MODULE_A);
    expect(openSecret(row?.usernameEnc as string, SECRET)).toBe('u2');
    expect(openSecret(row?.passwordEnc as string, SECRET)).toBe('pw1');
    expect(openSecret(row?.cookiesEnc as string, SECRET)).toBe('c=1');
  });

  it('remove deletes; missing remove is a typed 404', (): void => {
    const fx = tracked();
    const service = new SqliteAccountService({ store: fx.store, secret: (): string => SECRET });
    service.upsert({ moduleId: MODULE_A as never, username: 'u' });
    service.remove(MODULE_A);
    expect(fx.store.get(MODULE_A)).toBeUndefined();
    expect(() => service.remove(MODULE_A)).toThrow(/no account for module/);
  });

  it('missing/empty deployment secret: writes and reads fail cleanly (no plaintext path)', (): void => {
    const fx = tracked();
    const service = new SqliteAccountService({ store: fx.store, secret: (): string => '' });
    expect(() => service.upsert({ moduleId: MODULE_A as never, username: 'u', password: 'p' })).toThrow(/FMD_WEB_SECRET/);
    expect(fx.store.size).toBe(0);
  });

  it('wrong deployment secret: reads surface a typed internal error, never garbled data', (): void => {
    const fx = tracked();
    const good = new SqliteAccountService({ store: fx.store, secret: (): string => SECRET });
    good.upsert({ moduleId: MODULE_A as never, username: 'u', password: 'p' });
    const bad = new SqliteAccountService({ store: fx.store, secret: (): string => 'other-secret' });
    expect(() => bad.get(MODULE_A)).toThrow(/FMD_WEB_SECRET/);
    expect(() => bad.list()).toThrow(/FMD_WEB_SECRET/);
  });
});

describe('SqliteAccountService.login — the OnLogin flow (§8.6/D4)', (): void => {
  it('asValid login: status persists into the row; cookies persist into the row AND §5.3 module_state', async (): Promise<void> => {
    const fx = tracked();
    // Seed a module_state row so the merge (ua/options/storage survive) is proven.
    fx.state.save(MODULE_A as never, {
      cookies: '',
      ua: 'FMD/2',
      enabled: true,
      options: { Language: 2 },
      storage: { session: 'keep' },
    });
    const driver = mockLoginDriver(({ username, password }): LoginOutcome => {
      if (username === 'good' && password === 'goodpass') {
        return { status: 2, cookies: 'sid=valid-session' }; // asValid
      }
      return { status: 3, cookies: '' }; // asInvalid
    });
    const service = new SqliteAccountService({
      store: fx.store,
      secret: (): string => SECRET,
      loginDriver: driver,
      statePersistence: fx.state,
    });
    service.upsert({ moduleId: MODULE_A as never, username: 'good', password: 'goodpass' });

    const view = await service.login(MODULE_A);
    expect(view.status).toBe('asValid');
    expect(driver.calls).toEqual([{ moduleId: MODULE_A, username: 'good', password: 'goodpass' }]);

    // Account row: status + sealed login cookies.
    const row = fx.store.get(MODULE_A);
    expect(row?.status).toBe(2);
    expect(openSecret(row?.cookiesEnc as string, SECRET)).toBe('sid=valid-session');

    // §5.3 module_state: cookies persisted, ua/options/storage merged.
    const stateRow = fx.state.row(MODULE_A as never);
    expect(stateRow?.cookies).toBe('sid=valid-session');
    expect(stateRow?.ua).toBe('FMD/2');
    expect(stateRow?.options).toEqual({ Language: 2 });
    expect(stateRow?.storage).toEqual({ session: 'keep' });
  });

  it('asInvalid login persists status 3 and empty cookies', async (): Promise<void> => {
    const fx = tracked();
    const driver = mockLoginDriver((): LoginOutcome => ({ status: 3, cookies: '' }));
    const service = new SqliteAccountService({
      store: fx.store,
      secret: (): string => SECRET,
      loginDriver: driver,
      statePersistence: fx.state,
    });
    service.upsert({ moduleId: MODULE_B as never, username: 'bad', password: 'creds' });
    const view = await service.login(MODULE_B);
    expect(view.status).toBe('asInvalid');
    expect(fx.store.get(MODULE_B)?.status).toBe(3);
    expect(fx.state.row(MODULE_B as never)?.cookies).toBe('');
  });

  it('driver failure is a typed upstream error; nothing is persisted', async (): Promise<void> => {
    const fx = tracked();
    const service = new SqliteAccountService({
      store: fx.store,
      secret: (): string => SECRET,
      loginDriver: {
        login: async (): Promise<LoginOutcome> => {
          throw new Error('lua error in OnLogin');
        },
      },
      statePersistence: fx.state,
    });
    service.upsert({ moduleId: MODULE_A as never, username: 'u', password: 'p' });
    await expect(service.login(MODULE_A)).rejects.toThrow(/module OnLogin failed/);
    expect(fx.store.get(MODULE_A)?.status).toBe(0); // untouched
    expect(Object.keys(fx.state.loadAll())).toHaveLength(0);
  });

  it('login without a wired driver is a clean upstream error', async (): Promise<void> => {
    const fx = tracked();
    const service = new SqliteAccountService({ store: fx.store, secret: (): string => SECRET });
    service.upsert({ moduleId: MODULE_A as never, username: 'u', password: 'p' });
    await expect(service.login(MODULE_A)).rejects.toThrow(/no engine login driver/);
  });

  it('login on a disabled account is a conflict; on an unknown module a 404', async (): Promise<void> => {
    const fx = tracked();
    const driver = mockLoginDriver((): LoginOutcome => ({ status: 2, cookies: '' }));
    const service = new SqliteAccountService({
      store: fx.store,
      secret: (): string => SECRET,
      loginDriver: driver,
    });
    service.upsert({ moduleId: MODULE_A as never, username: 'u', password: 'p', enabled: false });
    await expect(service.login(MODULE_A)).rejects.toThrow(/disabled/);
    await expect(service.login(MODULE_B)).rejects.toThrow(/no account for module/);
    expect(driver.calls).toHaveLength(0);
  });
});

describe('status helpers', (): void => {
  it('ordinal clamp + names (the §5.2 account-status constants)', (): void => {
    expect(accountStatusOrdinal(0)).toBe(0);
    expect(accountStatusOrdinal(2)).toBe(2);
    expect(accountStatusOrdinal(-1)).toBe(0);
    expect(accountStatusOrdinal(9)).toBe(0);
    expect(accountStatusName(0)).toBe('asUnknown');
    expect(accountStatusName(1)).toBe('asChecking');
    expect(accountStatusName(2)).toBe('asValid');
    expect(accountStatusName(3)).toBe('asInvalid');
  });
});
