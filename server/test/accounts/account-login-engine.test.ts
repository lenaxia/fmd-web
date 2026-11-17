/**
 * Engine-backed account login (§8.6/D4): a synthetic FMD2-format mock
 * module (Init + OnLogin + OnAccountState, the §5.2 account-status
 * constants) runs through the REAL engine stack — Init pass, shims,
 * contract dispatcher — and the EngineLoginDriver reads the handler-set
 * MODULE.Account.Status / MODULE.Account.Cookies back (the FMD2 DoLogin
 * host flow, LuaWebsiteModules.pas:412-431). Fully offline: the mock
 * handler performs no HTTP.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import { RecordedResponseResolver } from '../../src/engine/shims/http-shim.js';
import { RecordedHttpTransport } from '../../src/engine/shims/http-transport.js';
import type { RegistrationRecord } from '../../src/engine/registry/capabilities.js';
import { EngineLoginSession as EngineLoginDriver } from '../../src/engine/services/account-session.js';
import { createLuaHost, createLuaHostFactory } from '../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../src/engine/lua/logger.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../src/engine/lua/abort.js';
import {
  initShimsHook,
  installShims,
  loadRealModuleFile,
} from '../../src/engine/shims/install.js';
import { createContractDispatcher } from '../../src/engine/events/dispatcher.js';

/** 32-hex synthetic module id. */
const MOCK_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';

/**
 * Synthetic FMD2-format mock module (the Hentaidexy/ColoredManga Init
 * shape): AccountSupport + OnLogin + OnAccountState. The Login handler
 * follows the CapibaraTraductor/DataLife template flow — Enabled gate,
 * asChecking while checking, asValid/asInvalid outcome, cookies set on
 * success — using ONLY the §5.2 account-status constants.
 */
const MOCK_MODULE = `
function Init()
  local m = NewWebsiteModule()
  m.ID                       = 'deadbeefdeadbeefdeadbeefdeadbeef'
  m.Name                     = 'MockLogin'
  m.RootURL                  = 'https://mocklogin.example'
  m.Category                 = 'Manga'
  m.AccountSupport           = true
  m.OnLogin                  = 'Login'
  m.OnAccountState           = 'AccountState'
end

function Login()
  if not MODULE.Account.Enabled then
    MODULE.Account.Status = asUnknown
    return false
  end
  MODULE.Account.Status = asChecking
  if MODULE.Account.Username == 'good' and MODULE.Account.Password == 'goodpass' then
    MODULE.Account.Cookies = 'sid=mock-session'
    MODULE.Account.Status = asValid
    return true
  end
  MODULE.Account.Status = asInvalid
  return true
end

function AccountState()
  if MODULE.Account.Status == asValid then
    return true
  end
  return false
end
`;

function registration(file: string): RegistrationRecord {
  return {
    id: MOCK_ID,
    name: 'MockLogin',
    rootURL: 'https://mocklogin.example',
    category: 'Manga',
    accountSupport: true,
    options: [],
    file,
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: ['Login', 'AccountState'],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
  };
}

describe('EngineLoginDriver: mock module OnLogin through the event runtime', (): void => {
  let luaRoot: string;

  beforeAll((): void => {
    luaRoot = mkdtempSync(join(tmpdir(), 'fmd-login-luaroot-'));
    mkdirSync(join(luaRoot, 'modules'), { recursive: true });
    writeFileSync(join(luaRoot, 'modules', 'MockLogin.lua'), MOCK_MODULE);
  });

  afterAll((): void => {
    rmSync(luaRoot, { recursive: true, force: true });
  });

  function makeDriver(): EngineLoginDriver {
    const resolver = new RecordedResponseResolver([]);
    return new EngineLoginDriver({
      luaRoot,
      hostFactory: createLuaHostFactory(),
      modules: (): readonly RegistrationRecord[] => [registration('MockLogin.lua')],
      transport: new RecordedHttpTransport((m, u, b, mt, h) => resolver.resolve(m, u, b, mt, h)),
      egress: new EgressPolicy({ allow: ['mocklogin.example'] }),
    });
  }

  it('valid credentials → asValid + handler cookies read back', async (): Promise<void> => {
    const driver = makeDriver();
    try {
      const outcome = await driver.login(MOCK_ID, { enabled: true, username: 'good', password: 'goodpass' });
      expect(outcome.status).toBe(2); // asValid
      expect(outcome.cookies).toBe('sid=mock-session');
    } finally {
      await driver.dispose();
    }
  });

  it('invalid credentials → asInvalid (status constant flows through the runtime)', async (): Promise<void> => {
    const driver = makeDriver();
    try {
      const outcome = await driver.login(MOCK_ID, { enabled: true, username: 'nope', password: 'wrong' });
      expect(outcome.status).toBe(3); // asInvalid
      expect(outcome.cookies).toBe('');
    } finally {
      await driver.dispose();
    }
  });

  it('disabled account → the module returns false with asUnknown (Enabled gate parity)', async (): Promise<void> => {
    const driver = makeDriver();
    try {
      const outcome = await driver.login(MOCK_ID, { enabled: false, username: 'good', password: 'goodpass' });
      expect(outcome.status).toBe(0); // asUnknown
      expect(outcome.cookies).toBe('');
    } finally {
      await driver.dispose();
    }
  });

  it('unknown module is a typed 404; AccountState dispatch returns the handler boolean', async (): Promise<void> => {
    const driver = makeDriver();
    try {
      await expect(
        driver.login('e'.repeat(32), { enabled: true, username: 'good', password: 'goodpass' }),
      ).rejects.toThrow(/unknown module/);
    } finally {
      await driver.dispose();
    }
  });

  it('dispatcher-level: account-status constants are bound and AccountState reflects the set status', async (): Promise<void> => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    try {
      const abort = new DeadlineAbortHandle(createDeadlineCells());
      const resolver = new RecordedResponseResolver([]);
      const hook = initShimsHook({ resolver, abort, logger, moduleId: 'MockLogin.lua', luaRoot });
      const descriptors = await loadRealModuleFile(host, luaRoot, 'modules/MockLogin.lua', hook);
      const descriptor = descriptors.find((d) => d.id === MOCK_ID);
      expect(descriptor?.accountSupport).toBe(true);
      expect(descriptor?.eventHandlers['Login']).toBe('Login');
      const engine = await host.createEngine();
      try {
        let installed: ReturnType<typeof installShims> | undefined;
        await engine.loadModule('modules/MockLogin.lua', (inner, bridge): void => {
          installed = installShims(inner, bridge, {
            resolver,
            abort,
            logger,
            moduleId: MOCK_ID,
            luaRoot,
          });
        });
        expect(installed).toBeDefined();
        const dispatcher = createContractDispatcher(engine, abort, logger, undefined, undefined, undefined, {
          account: { enabled: true, username: 'good', password: 'goodpass' },
        });
        const login = dispatcher.dispatch(descriptor as never, 'Login', {});
        expect(login.kind).toBe('boolean');
        expect(login.kind === 'boolean' && login.value).toBe(true);
        // The handler-set state is readable host-side after the dispatch.
        expect(engine.innerEngine.doStringSync('return MODULE.Account.Status')).toBe(2); // asValid
        expect(engine.innerEngine.doStringSync('return MODULE.Account.Cookies')).toBe('sid=mock-session');
        // AccountState (same account-status constants row) sees asValid.
        const state = dispatcher.dispatch(descriptor as never, 'AccountState', {});
        expect(state.kind === 'boolean' && state.value).toBe(true);
      } finally {
        await engine.dispose();
      }
    } finally {
      await host.dispose();
    }
  });
});
