import type { HostLogRecord } from '@fmd/contract';
import { ApiError } from '../api/errors.js';
import {
  accountStatusOrdinal,
  type AccountLoginDriver,
  type LoginCredentials,
  type LoginOutcome,
} from '../accounts/account-service.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../engine/lua/abort.js';
import { createLuaHost, type WasmoonLuaHost } from '../engine/lua/host.js';
import { createMemoryLogger, TeeMemoryLogger, type MemoryLogger } from '../engine/lua/logger.js';
import { createContractDispatcher } from '../engine/events/dispatcher.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../engine/shims/install.js';
import { RecordedResponseResolver } from '../engine/shims/http-shim.js';
import type { EgressPolicy, HttpTransportPort } from '../engine/shims/http-shim.js';
import type { SwallowSharedDeduper } from '../engine/shims/txquery-shim.js';
import type { RegistrationRecord } from '../engine/registry/capabilities.js';

/**
 * Engine-backed account OnLogin driver (§8.6/D4 login flow): loads the
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
}

export class EngineLoginDriver implements AccountLoginDriver {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly hosts: Set<WasmoonLuaHost> = new Set();

  public constructor(private readonly options: EngineLoginDriverOptions) {}

  public async dispose(): Promise<void> {
    for (const host of this.hosts) {
      await host.dispose();
    }
    this.hosts.clear();
  }

  public login(moduleId: string, credentials: LoginCredentials): Promise<LoginOutcome> {
    // Serialize engine creation/disposal — one wasmoon engine at a time.
    const run = this.tail.then((): Promise<LoginOutcome> => this.runLogin(moduleId, credentials));
    this.tail = run.catch((): void => undefined);
    return run;
  }

  private async runLogin(moduleId: string, credentials: LoginCredentials): Promise<LoginOutcome> {
    const registration = this.options.modules().find((m) => m.id === moduleId);
    if (registration === undefined) {
      throw new ApiError(404, 'not_found', `unknown module: ${moduleId}`);
    }
    const sink = this.options.logSink;
    const logger: MemoryLogger = sink === undefined
      ? createMemoryLogger()
      : new TeeMemoryLogger(sink);
    const host = createLuaHost(logger);
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
            ...(this.options.swallowDeduper !== undefined
              ? { swallowDeduper: this.options.swallowDeduper }
              : {}),
          });
        });
        const shimKit = installed;
        if (shimKit === undefined) {
          throw new ApiError(502, 'upstream_error', 'shim install did not run');
        }
        const dispatcher = createContractDispatcher(engine, abort, logger, undefined, undefined, undefined, {
          makeHTTP: shimKit.makeHTTP,
          account: {
            enabled: credentials.enabled,
            username: credentials.username,
            password: credentials.password,
          },
        });
        const result = dispatcher.dispatch(descriptor, 'Login', {});
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
        const runLua = (code: string): unknown => engine.innerEngine.doStringSync(code);
        const statusRaw = Number(runLua('return MODULE.Account.Status') ?? 0);
        const cookiesRaw = runLua('return MODULE.Account.Cookies');
        return {
          status: accountStatusOrdinal(statusRaw),
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
