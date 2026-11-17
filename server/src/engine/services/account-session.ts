import { ApiError, type HostLogRecord } from '@fmd/contract';
import type { LuaHost, LuaHostFactory } from '../contract.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../lua/abort.js';
import { createMemoryLogger, TeeMemoryLogger, type MemoryLogger } from '../lua/logger.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../shims/install.js';
import { RecordedResponseResolver } from '../shims/http-shim.js';
import type { EgressPolicy, HttpTransportPort } from '../shims/http-shim.js';
import type { SwallowSharedDeduper } from '../shims/txquery-shim.js';
import type { RegistrationRecord } from '../registry/capabilities.js';
import type { ModuleSharedState } from '../state/module-state.js';

/**
 * Engine-backed account OnLogin session (§8.6/D4 login flow) — MOVED
 * inside the engine by the engine-boundary story: host-driving MECHANISM;
 * the accounts layer satisfies its AccountLoginDriver port with this
 * session structurally (identical login/dispose shape), failures throw
 * the contract's typed ApiError envelope.
 *
 * Loads the
 * module through the real Init pass + shims, seeds MODULE.Account with
 * the DECRYPTED credentials, dispatches the §5.2 `Login` row (the
 * account-status constants `asUnknown/asChecking/asValid/asInvalid` are
 * bound for it), then reads the handler-set `MODULE.Account.Status` and
 * `MODULE.Account.Cookies` back — the same host-side read-back FMD2's
 * DoLogin performs through the live TWebsiteModuleAccount object
 * (LuaWebsiteModules.pas:412–431). The caller (`SqliteAccountService`)
 * persists both.
 *
 * Engine lifecycle mirrors `EngineInfoService`: one host per call,
 * created and disposed inside it; a promise chain serializes calls.
 */

export interface EngineLoginDriverOptions {
  /** Synced lua tree root (`<dataDir>/lua`). */
  readonly luaRoot: string;
  /** Registry rows provider (re-read per call — the registry can refresh). */
  readonly modules: () => readonly RegistrationRecord[];
  /** Live transport (loopback / compose mock allow-list). */
  readonly transport: HttpTransportPort;
  /** Egress policy for module HTTP. */
  readonly egress: EgressPolicy;
  /** §5.6 run-level expression-failure dedup (observability assembly). */
  readonly swallowDeduper?: SwallowSharedDeduper;
  /** §4 structured-log tee. */
  readonly logSink?: (record: HostLogRecord) => void;
  /**
   * §5.3 per-module shared-state resolver (audit F-2): when wired, the
   * module's SharedCookieJar backs BOTH the HTTP shims (request cookie
   * injection) and the MODULE cookie methods, and the jar text persists
   * via module_state at the end of the login.
   */
  readonly moduleState?: (moduleId: string) => Promise<ModuleSharedState>;
  /**
   * Lua host factory (injected by the composition root): constructs the
   * per-call host behind the contract LuaHost interface — substitute
   * hosts (test doubles) wire in here without touching this driver.
   */
  readonly hostFactory: LuaHostFactory;
}

/**
 * §5.2 account-status ordinals (asUnknown=0, asChecking=1, asValid=2,
 * asInvalid=3). The read-back clamp keeps ONLY 1|2|3 — everything else
 * parks at asUnknown (mirroring FMD2's LoadFromFile tolerance; live
 * logins may legitimately park in asChecking). Same mapping the accounts
 * layer's `accountStatusOrdinal` applies — engine-side single source for
 * the module-event read-back.
 */
export type ModuleAccountStatusOrdinal = 0 | 1 | 2 | 3;

export function moduleAccountStatusOrdinal(status: number): ModuleAccountStatusOrdinal {
  return (status === 1 || status === 2 || status === 3 ? status : 0) as ModuleAccountStatusOrdinal;
}

/** §5.2 MODULE.Account seed the login dispatch runs with. */
export interface ModuleLoginCredentials {
  readonly enabled: boolean;
  readonly username: string;
  readonly password: string;
}

/** What a module OnLogin run produced (handler-set Account fields). */
export interface ModuleLoginOutcome {
  readonly status: ModuleAccountStatusOrdinal;
  readonly cookies: string;
}

/**
 * The account-login SERVICE port (facade-exported; stub substrates
 * implement this). Structurally compatible with the accounts layer's
 * AccountLoginDriver — the assembly passes the engine session to the
 * account service directly.
 */
export interface ModuleLoginPort {
  login(moduleId: string, credentials: ModuleLoginCredentials): Promise<ModuleLoginOutcome>;
  dispose(): Promise<void>;
}

export class EngineLoginSession implements ModuleLoginPort {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly hosts: Set<LuaHost> = new Set();

  public constructor(private readonly options: EngineLoginDriverOptions) {}

  public async dispose(): Promise<void> {
    for (const host of this.hosts) {
      await host.dispose();
    }
    this.hosts.clear();
  }

  public login(moduleId: string, credentials: ModuleLoginCredentials): Promise<ModuleLoginOutcome> {
    // Serialize engine creation/disposal — one wasmoon engine at a time.
    const run = this.tail.then((): Promise<ModuleLoginOutcome> => this.runLogin(moduleId, credentials));
    this.tail = run.catch((): void => undefined);
    return run;
  }

  private async runLogin(moduleId: string, credentials: ModuleLoginCredentials): Promise<ModuleLoginOutcome> {
    const registration = this.options.modules().find((m) => m.id === moduleId);
    if (registration === undefined) {
      throw new ApiError(404, 'not_found', `unknown module: ${moduleId}`);
    }
    const sink = this.options.logSink;
    const logger: MemoryLogger = sink === undefined
      ? createMemoryLogger()
      : new TeeMemoryLogger(sink);
    const host = this.options.hostFactory.createHost(logger);
    this.hosts.add(host);
    try {
      const abort = new DeadlineAbortHandle(createDeadlineCells());
      const resolver = new RecordedResponseResolver([]);
      const luaRoot = this.options.luaRoot;
      const hook = initShimsHook({
        resolver,
        abort,
        logger,
        moduleId: registration.file,
        luaRoot,
      });
      const modulePath = `modules/${registration.file}`;
      const descriptors = await loadRealModuleFile(host, luaRoot, modulePath, hook);
      const descriptor = descriptors.find((d) => d.id === moduleId) ?? descriptors[0];
      if (descriptor === undefined) {
        throw new ApiError(502, 'upstream_error', `module ${moduleId} failed to initialize`);
      }
      if (!descriptor.accountSupport) {
        throw new ApiError(409, 'conflict', `module ${moduleId} does not support accounts (AccountSupport=false)`);
      }
      if (descriptor.eventHandlers['Login'] === undefined || descriptor.eventHandlers['Login'] === '') {
        throw new ApiError(409, 'conflict', `module ${moduleId} binds no OnLogin handler`);
      }

      const engine = await host.createEngine();
      try {
        // §5.3 module shared state (audit F-2): ONE jar per module id —
        // the HTTP objects' request-cookie injection and the MODULE cookie
        // methods run over it; the jar text persists via module_state.
        const sharedState = this.options.moduleState !== undefined
          ? await this.options.moduleState(descriptor.id)
          : undefined;
        const sharedCookies = sharedState?.cookies;
        let installed: ReturnType<typeof installShims> | undefined;
        await engine.loadModule(modulePath, (inner, bridge): void => {
          installed = installShims(inner, bridge, {
            resolver,
            abort,
            logger,
            moduleId: descriptor.id,
            luaRoot,
            egress: this.options.egress,
            transport: this.options.transport,
            ...(sharedCookies !== undefined ? { sharedCookies } : {}),
            ...(this.options.swallowDeduper !== undefined
              ? { swallowDeduper: this.options.swallowDeduper }
              : {}),
          });
        });
        const shimKit = installed;
        if (shimKit === undefined) {
          throw new ApiError(502, 'upstream_error', 'shim install did not run');
        }
        const dispatcher = host.createDispatcher(engine, abort, undefined, {
          makeHTTP: shimKit.makeHTTP,
          ...(sharedCookies !== undefined ? { moduleCookies: () => sharedCookies } : {}),
          account: {
            enabled: credentials.enabled,
            username: credentials.username,
            password: credentials.password,
          },
        });
        const result = dispatcher.dispatch(descriptor, 'Login', {});
        if (sharedState !== undefined) {
          await sharedState.persist();
        }
        if (result.kind === 'failed') {
          throw new ApiError(
            502,
            'upstream_error',
            `OnLogin failed: ${result.reason}${result.timedOut ? ' (deadline)' : ''}`,
          );
        }
        // FMD2 DoLogin: Result := lua_toboolean(L, -1) — the boolean is the
        // handler's "did I complete" signal; the STATUS lives on
        // MODULE.Account (read back, LuaWebsiteModules.pas:412-431).
        const runLua = (code: string): unknown => engine.doStringSync(code);
        const statusRaw = Number(runLua('return MODULE.Account.Status') ?? 0);
        const cookiesRaw = runLua('return MODULE.Account.Cookies');
        return {
          status: moduleAccountStatusOrdinal(statusRaw),
          cookies: typeof cookiesRaw === 'string' ? cookiesRaw : '',
        };
      } finally {
        await engine.dispose();
      }
    } finally {
      this.hosts.delete(host);
      await host.dispose();
    }
  }
}
