import { describe, expect, it } from 'vitest';
import { openSession } from './harness.js';
import type { HarnessSession } from './harness.js';
import type { RecordedResponse } from '../../../src/engine/shims/http-shim.js';
import { ModuleStateService } from '../../../src/engine/state/module-state.js';
import { InMemoryModuleStatePersistence } from '../../../src/engine/state/persistence.js';

/**
 * Audit F-2 e2e: the REAL FMD2 module files' account-cookie flows through
 * the real wasmoon host + §5.4 shims, with the §5.3 per-module shared
 * cookie jar wired BOTH into the HTTP shims (request injection — the
 * outgoing `Cookie` header carries the server-side cookies) and the
 * MODULE cookie methods — plus the module_state persistence round-trip
 * across a state-service restart.
 *
 * Consumers (FMD2 lua tree):
 * - SoftKomik.lua:132  MODULE.AddServerCookies('tokkey=' .. MODULE.Storage['Auth'])
 * - SoftKomik.lua:135  MODULE.RemoveCookies()          (account disabled → logout)
 * - Madokami.lua:40/78 MODULE.ClearCookies()
 * - Madokami.lua:75    MODULE.AddServerCookies(MODULE.Account.Cookies)
 */

const SOFTKOMIK_ID = 'df01551e1739407a98669e37318842b0';
const MADOKAMI_ID = 'eb27e424af1e4ca987aba1f332df952c';

/** The Cookie header of the LAST recorded outgoing request ('' when absent). */
function lastCookieHeader(session: HarnessSession): string {
  const last = session.resolver.requests.at(-1);
  return last?.headers['Cookie'] ?? '';
}

describe('SoftKomik.lua account-cookie flow (audit F-2)', () => {
  it('Login stores the bearer token; AccountState injects it server-side; RemoveCookies (disabled) clears it', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule(SOFTKOMIK_ID);
    const responses: RecordedResponse[] = [
      { url: 'https://softkomik.co/api/login', method: 'POST', status: 200, body: '{"token":"TKN123"}' },
      { url: 'https://softkomik.co/api/bookmark', status: 200, body: '{"ok":true}' },
    ];

    // 1. Login: POST /api/login → json token → Storage['Auth'] = 'Bearer TKN123'.
    const session = await openSession({
      moduleFile: 'modules/SoftKomik.lua',
      responses,
      sharedCookies: state.cookies,
      shims: { account: { enabled: true, username: 'user@example.org', password: 'hunter2' } },
    });
    try {
      const login = session.dispatch('Login');
      expect(login.kind).toBe('boolean');
      expect(session.runLua('return MODULE.Account.Status')).toBe(2); // asValid
      expect(session.runLua("return MODULE.Storage['Auth']")).toBe('Bearer TKN123');

      // 2. AccountState: MODULE.AddServerCookies('tokkey=Bearer TKN123') over
      //    the shared jar — then a request carries the cookie SERVER-SIDE.
      session.dispatch('AccountState');
      session.bindHTTP();
      expect(session.runLua("return HTTP.GET('https://softkomik.co/api/bookmark')")).toBe(true);
      expect(lastCookieHeader(session)).toBe('tokkey=Bearer TKN123');
      await session.dispose();

      // 3. Account DISABLED (a fresh session/engine): MODULE.RemoveCookies()
      //    clears the shared jar — the next request goes out unauthenticated.
      const logout = await openSession({
        moduleFile: 'modules/SoftKomik.lua',
        responses,
        sharedCookies: state.cookies,
        shims: { account: { enabled: false, username: '', password: '' } },
      });
      try {
        // Seed a stale server cookie to prove the clear actually happens.
        state.cookies.set('tokkey', 'stale');
        logout.dispatch('AccountState');
        logout.bindHTTP();
        expect(logout.runLua("return HTTP.GET('https://softkomik.co/api/bookmark')")).toBe(true);
        expect(lastCookieHeader(logout)).toBe('');
        expect(state.cookies.size).toBe(0);
      } finally {
        await logout.dispose();
      }
    } finally {
      await session.dispose();
    }
  });
});

describe('Madokami.lua account-cookie flow (audit F-2)', () => {
  it('AccountState injects the seeded Account.Cookies server-side (note3: \'; \'-joined list)', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule(MADOKAMI_ID);
    const session = await openSession({
      moduleFile: 'modules/Madokami.lua',
      responses: [{ url: 'https://manga.madokami.al', status: 200, body: '<html><body>manga index</body></html>' }],
      sharedCookies: state.cookies,
      shims: { account: { enabled: true, username: 'madoka', password: 'homura', cookies: 'sid=abc; tok=xyz' } },
    });
    try {
      session.dispatch('AccountState');
      session.bindHTTP();
      expect(session.runLua("return HTTP.GET('https://manga.madokami.al')")).toBe(true);
      expect(lastCookieHeader(session)).toBe('sid=abc; tok=xyz');
    } finally {
      await session.dispose();
    }
  });

  it('Login (Basic auth) harvests the Set-Cookie session; AccountState re-injects it; disabled → ClearCookies', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule(MADOKAMI_ID);
    const responses: RecordedResponse[] = [
      // The login GET answers 200 with a session cookie and NO WWW-Authenticate.
      { url: 'https://manga.madokami.al', status: 200, body: '<html><body>ok</body></html>', headers: { 'Set-Cookie': 'fresh=1; Path=/' } },
    ];
    const session = await openSession({
      moduleFile: 'modules/Madokami.lua',
      responses,
      sharedCookies: state.cookies,
      shims: { account: { enabled: true, username: 'madoka', password: 'homura' } },
    });
    try {
      session.dispatch('Login');
      expect(session.runLua('return MODULE.Account.Status')).toBe(2); // asValid
      // FMD2 quirk preserved (audit F-2): `MODULE.Account.Cookies =
      // HTTP.Cookies` assigns the Cookies OBJECT to a string property —
      // lua_tolstring reads it as '' in FMD2, and so do we. The session
      // itself flows SERVER-SIDE instead: the login response's Set-Cookie
      // feeds the module cookie jar (CookieManager parity).
      expect(session.runLua('return MODULE.Account.Cookies')).toBe('');
      expect(state.cookies.get('fresh')).toBe('1');

      // The harvested session cookie rides the next request — with or
      // without an AccountState pass (the jar IS the server-side store).
      session.dispatch('AccountState');
      session.bindHTTP();
      expect(session.runLua("return HTTP.GET('https://manga.madokami.al')")).toBe(true);
      expect(lastCookieHeader(session)).toBe('fresh=1');
      await session.dispose();

      // Disabled: MODULE.ClearCookies() wipes the shared store.
      const disabled = await openSession({
        moduleFile: 'modules/Madokami.lua',
        responses,
        sharedCookies: state.cookies,
        shims: { account: { enabled: false, username: '', password: '' } },
      });
      try {
        expect(state.cookies.size).toBe(1); // pre-condition: still seeded
        disabled.dispatch('AccountState');
        expect(state.cookies.size).toBe(0);
        disabled.bindHTTP();
        expect(disabled.runLua("return HTTP.GET('https://manga.madokami.al')")).toBe(true);
        expect(lastCookieHeader(disabled)).toBe('');
      } finally {
        await disabled.dispose();
      }
    } finally {
      await session.dispose();
    }
  });
});

describe('module_state persistence across a state-service restart (audit F-2)', () => {
  it('cookies added by the module in service A flow into requests under service B over the same persistence', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    const serviceA = new ModuleStateService({ persistence });
    const stateA = await serviceA.forModule(MADOKAMI_ID);

    const responses: RecordedResponse[] = [
      { url: 'https://manga.madokami.al', status: 200, body: '<html><body>manga index</body></html>' },
    ];
    const sessionA = await openSession({
      moduleFile: 'modules/Madokami.lua',
      responses,
      sharedCookies: stateA.cookies,
      shims: { account: { enabled: true, username: 'madoka', password: 'homura', cookies: 'sid=abc; tok=xyz' } },
    });
    try {
      sessionA.dispatch('AccountState');
      await stateA.persist(); // module_state write (settings + jar merge)
    } finally {
      await sessionA.dispose();
    }

    // "Restart": a NEW state service over the same persisted row seeds the
    // jar — a fresh engine's requests carry the cookies with NO re-add.
    const serviceB = new ModuleStateService({ persistence });
    const stateB = await serviceB.forModule(MADOKAMI_ID);
    const sessionB = await openSession({
      moduleFile: 'modules/Madokami.lua',
      responses,
      sharedCookies: stateB.cookies,
    });
    try {
      sessionB.bindHTTP();
      expect(sessionB.runLua("return HTTP.GET('https://manga.madokami.al')")).toBe(true);
      expect(lastCookieHeader(sessionB)).toBe('sid=abc; tok=xyz');
    } finally {
      await sessionB.dispose();
    }
  });
});
