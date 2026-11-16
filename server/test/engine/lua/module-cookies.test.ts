import { describe, expect, it } from 'vitest';
import {
  addModuleServerCookies,
  moduleCookieText,
  removeModuleCookies,
} from '../../../src/engine/lua/module-facade.js';
import { CookieJar } from '../../../src/engine/shims/http-cookies.js';
import { ModuleStateService } from '../../../src/engine/state/module-state.js';
import { InMemoryModuleStatePersistence } from '../../../src/engine/state/persistence.js';

/**
 * Audit F-2: the MODULE cookie methods (AddServerCookies /
 * GetServerCookies / RemoveCookies / ClearCookies,
 * LuaWebsiteModules.pas:888-919 + httpcookiemanager.pas) over the
 * per-module store — parsing forms, removal semantics, and the
 * module_state persistence round-trip (settings text + jar merge, then
 * a NEW state service seeded from the persisted row).
 */

describe('addModuleServerCookies (MODULE.AddServerCookies parsing)', () => {
  it('a single name=value pair (SoftKomik.lua:132 form)', () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'tokkey=Bearer TKN123');
    expect(jar.get('tokkey')).toBe('Bearer TKN123');
  });

  it("a '; '-joined pair list (MODULE.Account.Cookies / HTTP.Cookies form, Madokami.lua:75) — contract moduleSurface note3", () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'sid=abc; tok=xyz');
    expect(jar.get('sid')).toBe('abc');
    expect(jar.get('tok')).toBe('xyz');
  });

  it('a real Set-Cookie line yields exactly its first pair — attributes dropped', () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'sess=abc; Path=/; Domain=.example.org; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure; HttpOnly; SameSite=Lax');
    expect(jar.size).toBe(1);
    expect(jar.get('sess')).toBe('abc');
  });

  it('newline-split lines are independent Set-Cookie entries (FMD2 splits #10)', () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'a=1\r\nb=2\npath=3');
    expect(jar.get('a')).toBe('1');
    expect(jar.get('b')).toBe('2');
    // `path` as the FIRST pair of its own line is a cookie (FMD2 takes
    // the first pair verbatim); only LATER segments filter as attributes.
    expect(jar.get('path')).toBe('3');
  });

  it('junk segments are skipped (no pair without "="; empty input is a no-op)', () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'Secure; ;; just-text');
    expect(jar.size).toBe(0);
    addModuleServerCookies(jar, '');
    addModuleServerCookies(jar, '   ');
    expect(jar.size).toBe(0);
  });
});

describe('removeModuleCookies (MODULE.RemoveCookies semantics)', () => {
  it('a name removes just that cookie (case-insensitive, FMD2 SameText)', () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'sid=abc; tok=xyz');
    removeModuleCookies(jar, 'SID');
    expect(jar.size).toBe(1);
    expect(jar.get('tok')).toBe('xyz');
  });

  it("no arguments / '' removes ALL (SoftKomik.lua:135 logout form — the per-module store is the domain scope)", () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'sid=abc; tok=xyz');
    removeModuleCookies(jar, undefined);
    expect(jar.size).toBe(0);

    addModuleServerCookies(jar, 'sid=abc');
    removeModuleCookies(jar, '');
    expect(jar.size).toBe(0);
  });

  it('a list of names removes each', () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'a=1; b=2; c=3');
    removeModuleCookies(jar, ['a', 'c']);
    expect(jar.size).toBe(1);
    expect(jar.get('b')).toBe('2');
  });
});

describe('moduleCookieText (MODULE.GetServerCookies(\'\') — the Account.Cookies form)', () => {
  it("'; '-joined name=value pairs in store order", () => {
    const jar = new CookieJar();
    addModuleServerCookies(jar, 'sid=abc; tok=xyz');
    expect(moduleCookieText(jar)).toBe('sid=abc; tok=xyz');
  });

  it('reads the §5.3 SharedCookieJar shape too (snapshotSync entries)', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('0123456789abcdef0123456789abcdef');
    addModuleServerCookies(state.cookies, 'sid=abc');
    expect(moduleCookieText(state.cookies)).toBe('sid=abc');
  });
});

describe('module_state persistence round-trip (audit F-2: persistence + restart)', () => {
  it('persistState merges the jar into the persisted cookies text; a NEW service over the same adapter re-seeds the jar', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    const serviceA = new ModuleStateService({ persistence });
    const stateA = await serviceA.forModule('0123456789abcdef0123456789abcdef');

    await stateA.settings.setCookies('user=pref');
    addModuleServerCookies(stateA.cookies, 'sid=abc; tok=xyz');
    await stateA.persist();

    // Settings pairs survive; jar entries ride along (last-writer on conflict).
    // The persisted column keeps the FMD2 settingsText ';'-join form.
    expect(persistence.row('0123456789abcdef0123456789abcdef')?.cookies).toBe('user=pref;sid=abc;tok=xyz');

    // "Restart": a fresh service over the same persistence row seeds the
    // jar (request injection works without re-adding).
    const serviceB = new ModuleStateService({ persistence });
    const stateB = await serviceB.forModule('0123456789abcdef0123456789abcdef');
    expect(stateB.cookies.snapshotSync().requestHeader).toBe('user=pref; sid=abc; tok=xyz');
  });

  it('a jar write overrides a same-name settings cookie in the persisted text', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    const service = new ModuleStateService({ persistence });
    const state = await service.forModule('0123456789abcdef0123456789abcdef');
    await state.settings.setCookies('sid=stale; keep=1');
    addModuleServerCookies(state.cookies, 'sid=fresh');
    await state.persist();
    expect(persistence.row('0123456789abcdef0123456789abcdef')?.cookies).toBe('sid=fresh;keep=1');
  });
});
