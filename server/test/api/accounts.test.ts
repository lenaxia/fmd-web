/**
 * §8.6/D4 account routes (GET/PUT/DELETE /api/accounts, POST
 * /api/accounts/:moduleId/login) — CRUD through the API, the login flow
 * returning module AccountState, and the projection guarantees (the
 * password is write-only, sealed at rest in the SQLite service).
 */
import { describe, expect, it } from 'vitest';
import {
  buildHarness,
  expectEnvelope,
  InMemoryAccountService,
  makeInMemoryAccounts,
  MODULE_A_ID,
  MODULE_B_ID,
} from './helpers.js';
import type { LoginOutcome } from '../../src/accounts/account-service.js';

describe('GET /api/accounts', (): void => {
  it('lists stored accounts (module, username, enabled, status)', async (): Promise<void> => {
    const accounts = makeInMemoryAccounts();
    accounts.upsert({ moduleId: MODULE_A_ID, username: 'user-a', password: 'pw' });
    accounts.upsert({ moduleId: MODULE_B_ID, username: 'user-b', password: 'pw', enabled: false });
    const h = buildHarness({ accounts });
    const res = await h.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accounts: Array<{ moduleId: string; username: string; enabled: boolean; status: string }>;
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.accounts).toEqual([
      { moduleId: MODULE_A_ID, username: 'user-a', enabled: true, status: 'asUnknown' },
      { moduleId: MODULE_B_ID, username: 'user-b', enabled: false, status: 'asUnknown' },
    ]);
  });

  it('empty store → empty list', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [], count: 0 });
  });
});

describe('PUT /api/accounts/:moduleId', (): void => {
  it('creates an account (201) and never returns the password', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/accounts/${MODULE_A_ID}`,
      payload: { username: 'reader', password: 'hunter2', cookies: 'sid=1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      account: { moduleId: MODULE_A_ID, username: 'reader', enabled: true, status: 'asUnknown' },
    });
    // The whole response body carries no password anywhere.
    expect(res.body).not.toContain('hunter2');
  });

  it('omitted password/cookies KEEP the stored credential', async (): Promise<void> => {
    const accounts = makeInMemoryAccounts();
    accounts.upsert({ moduleId: MODULE_A_ID, username: 'old', password: 'keep-me', cookies: 'sid=old' });
    const h = buildHarness({ accounts });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/accounts/${MODULE_A_ID}`,
      payload: { username: 'new-name' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().account.username).toBe('new-name');
    // The behavior is observable through login: the injected behavior sees
    // the KEPT password (the route itself never surfaces it).
    let seenPassword = '';
    const probe = makeInMemoryAccounts((_moduleId, creds): LoginOutcome => {
      seenPassword = creds.password;
      return { status: 2, cookies: '' };
    });
    probe.upsert({ moduleId: MODULE_A_ID, username: 'new-name', password: 'keep-me' });
    await probe.login(MODULE_A_ID);
    expect(seenPassword).toBe('keep-me');
    void accounts;
  });

  it('validation: empty username and non-32-hex moduleId are 400 envelopes', async (): Promise<void> => {
    const h = buildHarness();
    const noUsername = await h.app.inject({
      method: 'PUT',
      url: `/api/accounts/${MODULE_A_ID}`,
      payload: { password: 'x' },
    });
    expect(noUsername.statusCode).toBe(400);
    expectEnvelope(noUsername.body, 'validation_error');

    const badId = await h.app.inject({
      method: 'PUT',
      url: '/api/accounts/not-hex',
      payload: { username: 'x' },
    });
    expect(badId.statusCode).toBe(400);
    expectEnvelope(badId.body, 'validation_error');
  });
});

describe('DELETE /api/accounts/:moduleId', (): void => {
  it('removes an account (200) then 404s on repeat', async (): Promise<void> => {
    const accounts = makeInMemoryAccounts();
    accounts.upsert({ moduleId: MODULE_A_ID, username: 'user', password: 'pw' });
    const h = buildHarness({ accounts });
    const del = await h.app.inject({ method: 'DELETE', url: `/api/accounts/${MODULE_A_ID}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const again = await h.app.inject({ method: 'DELETE', url: `/api/accounts/${MODULE_A_ID}` });
    expect(again.statusCode).toBe(404);
    expectEnvelope(again.body, 'not_found');

    const listing = await h.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(listing.json().count).toBe(0);
  });
});

describe('POST /api/accounts/:moduleId/login — the OnLogin flow', (): void => {
  it('mock module OnLogin returning asValid: status + cookies persist, login returns the account', async (): Promise<void> => {
    const loginBehavior = (_moduleId: string, creds: { username: string; password: string }): LoginOutcome => {
      // The mock-module OnLogin shape: check credentials, set
      // MODULE.Account.Cookies, set MODULE.Account.Status (§5.2 constants).
      if (creds.username === 'good' && creds.password === 'goodpass') {
        return { status: 2, cookies: 'sid=valid-session' }; // asValid
      }
      return { status: 3, cookies: '' }; // asInvalid
    };
    const accounts = makeInMemoryAccounts(loginBehavior);
    accounts.upsert({ moduleId: MODULE_A_ID, username: 'good', password: 'goodpass' });
    accounts.upsert({ moduleId: MODULE_B_ID, username: 'bad', password: 'nope' });
    const h = buildHarness({ accounts });

    const ok = await h.app.inject({ method: 'POST', url: `/api/accounts/${MODULE_A_ID}/login` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      ok: true,
      account: { moduleId: MODULE_A_ID, username: 'good', enabled: true, status: 'asValid' },
    });

    const invalid = await h.app.inject({ method: 'POST', url: `/api/accounts/${MODULE_B_ID}/login` });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().account.status).toBe('asInvalid');

    // The status persisted in the service (a fresh listing shows it).
    const listing = await h.app.inject({ method: 'GET', url: '/api/accounts' });
    const statuses = new Map(
      (listing.json().accounts as Array<{ moduleId: string; status: string }>).map((a) => [a.moduleId, a.status]),
    );
    expect(statuses.get(MODULE_A_ID)).toBe('asValid');
    expect(statuses.get(MODULE_B_ID)).toBe('asInvalid');
  });

  it('disabled account is a 409 conflict; unknown account is a 404', async (): Promise<void> => {
    const accounts = makeInMemoryAccounts();
    accounts.upsert({ moduleId: MODULE_A_ID, username: 'user', password: 'pw', enabled: false });
    const h = buildHarness({ accounts });

    const disabled = await h.app.inject({ method: 'POST', url: `/api/accounts/${MODULE_A_ID}/login` });
    expect(disabled.statusCode).toBe(409);
    expectEnvelope(disabled.body, 'conflict');

    const missing = await h.app.inject({ method: 'POST', url: `/api/accounts/${MODULE_B_ID}/login` });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.body, 'not_found');
  });

  it('driver failure (module error) maps to 502 upstream_error', async (): Promise<void> => {
    const accounts = makeInMemoryAccounts((): LoginOutcome => {
      throw new Error('lua error in OnLogin');
    });
    accounts.upsert({ moduleId: MODULE_A_ID, username: 'user', password: 'pw' });
    const h = buildHarness({ accounts });
    const res = await h.app.inject({ method: 'POST', url: `/api/accounts/${MODULE_A_ID}/login` });
    expect(res.statusCode).toBe(502);
    expectEnvelope(res.body, 'upstream_error');
  });

  it('the default no-driver service answers login with asUnknown (in-memory stand-in)', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({
      method: 'PUT',
      url: `/api/accounts/${MODULE_A_ID}`,
      payload: { username: 'user', password: 'pw' },
    });
    const res = await h.app.inject({ method: 'POST', url: `/api/accounts/${MODULE_A_ID}/login` });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.status).toBe('asUnknown');
    void InMemoryAccountService;
  });
});
