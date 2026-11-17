/**
 * Engine-backed download hooks (§7.1) — MOVED inside the engine by the
 * engine-boundary story: host-driving MECHANISM. The jobs layer sees only
 * the ChapterModuleHooks port + the facade factory; failures throw the
 * contract's typed ApiError envelope.
 */
import { ApiError } from '@fmd/contract';
import { DeadlineAbortHandle, createDeadlineCells } from '../lua/abort.js';
import { createMemoryLogger, TeeMemoryLogger, type MemoryLogger } from '../lua/logger.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../shims/install.js';
import type { ProxyConfig } from '../shims/http-proxy.js';
import type { BypassExecutorPort } from '../sidecar/bypass-adapter.js';
import { RecordedResponseResolver } from '../shims/http-shim.js';
import type { EgressPolicy, HttpTransportPort } from '../shims/http-shim.js';
import type { SwallowSharedDeduper } from '../shims/txquery-shim.js';
import type { HostLogRecord } from '@fmd/contract';
import type { EventDispatchResult, EventDispatcher, LuaEngine, LuaHost, LuaHostFactory, LuaModuleDescriptor } from '../contract.js';
import type { RegistrationRecord } from '../registry/capabilities.js';
import type { ModuleSharedState } from '../state/module-state.js';
import type { ChapterModuleHooks, TaskWriter } from './download-ports.js';

/**
 * Engine-backed download hooks (§7.1): one wasmoon engine per chapter
 * run, the §5.4 HTTP shims live, and the §5.2 download events
 * (TaskStart / GetPageNumber / GetImageURL) dispatched through the
 * contract dispatcher. TASK is the persistent download task across the
 * events — the host seeds `TASK.PageLinks` from the pipeline mirror
 * before each dispatch (the module reads the container URL at
 * [WORKID-1] and writes the resolved image URL back, LuaDownloadTask
 * parity) and reads the backing after the call (dispatcher `readTask`).
 *
 * BeforeDownloadImage / SaveImage / AfterImageSaved stay HOST-DEFAULT:
 * the hooks bind only what the descriptor registers, and the seed
 * fixture registers none — the runner then downloads verbatim and
 * writes files itself (FMD2's default writer path).
 */

/** no_error (§5.2 dispatch result codes; GetPageNumber returns boolean). */
const NO_ERROR = 0;

export interface EngineDownloadOptions {
  /** Synced lua tree root (`<dataDir>/lua`). */
  readonly luaRoot: string;
  /** Registry rows provider (re-read per run — the registry can refresh). */
  readonly modules: () => readonly RegistrationRecord[];
  /** Live transport (LoopbackHttpTransport with the mock allow-list). */
  readonly transport: HttpTransportPort;
  /** Egress policy for module HTTP (allow-lists the mock upstream). */
  readonly egress: EgressPolicy;
  /** §5.6 run-level expression-failure dedup (same instance as the info path). */
  readonly swallowDeduper?: SwallowSharedDeduper;
  /** §4 structured-log tee (module print + swallow WARNs). */
  readonly logSink?: (record: HostLogRecord) => void;
  /**
   * Settings-resolved per-module proxy (module override → global →
   * none, §9/§10): seeds each HTTP object's initial SetProxy state.
   */
  readonly proxyFor?: (moduleId: string) => ProxyConfig | undefined;
  /** §5.11 browser sidecar adapter (undefined = denied stub stands). */
  readonly bypass?: BypassExecutorPort;
  /**
   * §5.3 per-module shared-state resolver (audit F-2): when wired, the
   * module's SharedCookieJar backs BOTH the HTTP shims (request cookie
   * injection) and the MODULE cookie methods, and the jar text persists
   * via module_state at hook creation.
   */
  readonly moduleState?: (moduleId: string) => Promise<ModuleSharedState>;
  /**
   * Lua host factory (injected by the composition root): constructs the
   * per-run host behind the contract LuaHost interface — substitute
   * hosts (test doubles) wire in here without touching these hooks.
   */
  readonly hostFactory: LuaHostFactory;
}

type DispatchResult = EventDispatchResult;

/** The download-hooks SERVICE shape (facade-exported; stubs implement this). */
export type ModuleDownloadHooks = ChapterModuleHooks & {
  /** Engine + host teardown (end of the chapter run). */
  dispose(): Promise<void>;
};

export class EngineDownloadHooks implements ModuleDownloadHooks {
  private readonly taskStartHandler: string | undefined;
  private readonly getPageNumberHandler: string | undefined;
  private readonly getImageURLHandler: string | undefined;
  /** TASK.PageLinks mirror — the seed for the next dispatch. */
  private readonly pageLinksMirror: string[] = [];

  private constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly descriptor: LuaModuleDescriptor,
    private readonly host: LuaHost,
    private readonly engine: LuaEngine,
    private readonly logger: MemoryLogger,
    private readonly sharedState?: ModuleSharedState,
  ) {
    this.taskStartHandler = descriptor.eventHandlers['TaskStart'];
    this.getPageNumberHandler = descriptor.eventHandlers['GetPageNumber'];
    this.getImageURLHandler = descriptor.eventHandlers['GetImageURL'];
  }

  /** Load the module (Init pass + chunk cache) and bind the engine. */
  static async create(
    moduleId: string,
    options: EngineDownloadOptions,
  ): Promise<EngineDownloadHooks> {
    const registration = options.modules().find((m) => m.id === moduleId);
    if (registration === undefined) {
      throw new ApiError(404, 'not_found', `unknown module: ${moduleId}`);
    }
    const sink = options.logSink;
    const logger: MemoryLogger = sink === undefined
      ? createMemoryLogger()
      : new TeeMemoryLogger(sink);
    const host = options.hostFactory.createHost(logger);
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    const resolver = new RecordedResponseResolver([]);
    const luaRoot = options.luaRoot;
    const hook = initShimsHook({
      resolver,
      abort,
      logger,
      moduleId: registration.file,
      luaRoot,
      ...(options.bypass !== undefined ? { bypass: options.bypass } : {}),
    });
    const modulePath = `modules/${registration.file}`;
    const descriptors = await loadRealModuleFile(host, luaRoot, modulePath, hook);
    const descriptor = descriptors.find((d) => d.id === moduleId) ?? descriptors[0];
    if (descriptor === undefined) {
      await host.dispose();
      throw new ApiError(502, 'upstream_error', `module ${moduleId} failed to initialize`);
    }
    const engine = await host.createEngine();
    try {
      // §5.3 module shared state (audit F-2): ONE jar per module id —
      // the HTTP objects' request-cookie injection and the MODULE cookie
      // methods run over it; the jar text persists via module_state.
      const sharedState = options.moduleState !== undefined
        ? await options.moduleState(descriptor.id)
        : undefined;
      const sharedCookies = sharedState?.cookies;
      let installed: ReturnType<typeof installShims> | undefined;
      const initialProxy: ProxyConfig | undefined = options.proxyFor?.(descriptor.id);
      await engine.loadModule(modulePath, (inner, bridge): void => {
        installed = installShims(inner, bridge, {
          resolver,
          abort,
          logger,
          moduleId: descriptor.id,
          luaRoot,
          egress: options.egress,
          transport: options.transport,
          ...(sharedCookies !== undefined ? { sharedCookies } : {}),
          ...(initialProxy !== undefined ? { initialProxy } : {}),
          ...(options.bypass !== undefined ? { bypass: options.bypass } : {}),
          ...(options.swallowDeduper !== undefined
            ? { swallowDeduper: options.swallowDeduper }
            : {}),
        });
      });
      if (installed === undefined) {
        throw new ApiError(502, 'upstream_error', 'shim install did not run');
      }
      const dispatcher = host.createDispatcher(engine, abort, undefined, {
        makeHTTP: installed.makeHTTP,
        ...(sharedCookies !== undefined ? { moduleCookies: () => sharedCookies } : {}),
      });
      if (sharedState !== undefined) {
        await sharedState.persist();
      }
      return new EngineDownloadHooks(dispatcher, descriptor, host, engine, logger, sharedState);
    } catch (error: unknown) {
      await engine.dispose();
      await host.dispose();
      throw error;
    }
  }

  /** Engine + host teardown (end of the chapter run); the module cookie
   * jar (§5.3, audit F-2) persists to module_state before disposal. */
  async dispose(): Promise<void> {
    if (this.sharedState !== undefined) {
      await this.sharedState.persist();
    }
    await this.engine.dispose();
    await this.host.dispose();
  }

  /** §5.2 TaskStart — unbound skips (Assigned(OnTaskStart) = false); false aborts. */
  async taskStart(_task: TaskWriter): Promise<boolean> {
    if (this.taskStartHandler === undefined) {
      return true;
    }
    return this.toBoolean(
      this.dispatcher.dispatch(this.descriptor, 'TaskStart', {
        task: { pageLinks: [...this.pageLinksMirror] },
      }),
      'TaskStart',
    );
  }

  /** dispatch result → boolean, failures carrying the engine log tail. */
  private toBoolean(result: DispatchResult, event: string): boolean {
    if (result.kind === 'failed') {
      const tail = this.logger.records
        .slice(-3)
        .map((r) => r.message)
        .join(' | ');
      throw new Error(
        `${event} failed: ${result.reason}${result.timedOut ? ' (deadline)' : ''}${tail === '' ? '' : ` — ${tail}`}`,
      );
    }
    if (result.kind === 'code') {
      return result.value === NO_ERROR;
    }
    return result.kind === 'boolean' ? result.value : false;
  }

  /** §5.2 GetPageNumber — module sets TASK.PageNumber + TASK.PageLinks[]. */
  async getPageNumber(task: TaskWriter, url: string): Promise<boolean> {
    if (this.getPageNumberHandler === undefined) {
      return false;
    }
    const result = this.dispatcher.dispatch(this.descriptor, 'GetPageNumber', {
      url,
      task: { pageLinks: [...this.pageLinksMirror] },
    });
    if (!this.toBoolean(result, 'GetPageNumber')) {
      return false;
    }
    return this.adoptReadBack(task, true);
  }

  /**
   * §5.2 GetImageURL — TASK.PageLinks seeded with the current state; the
   * module resolves slot `workId` in place (FMD2: TASK.PageLinks[WORKID-1]).
   * WORKID is 1-based on the Lua side (FMD2 convention) — the runner's
   * 0-based PipelineWorkId shifts by one at this boundary.
   */
  async getImageURL(task: TaskWriter, workId: number, url: string): Promise<boolean> {
    if (this.getImageURLHandler === undefined) {
      return false;
    }
    const result = this.dispatcher.dispatch(this.descriptor, 'GetImageURL', {
      url,
      workId: workId + 1,
      task: { pageLinks: [...this.pageLinksMirror] },
    });
    if (!this.toBoolean(result, 'GetImageURL')) {
      return false;
    }
    if (!this.adoptReadBack(task)) {
      return false;
    }
    return (this.pageLinksMirror[workId] ?? '').trim() !== '';
  }

  /**
   * Sync the read TASK backing into the mirror + the runner's writer.
   * `pad=true` replicates the DoGetPageNumber padding (uDownloadsManager
   * :849-856): PageLinks grow to PageNumber with 'W' placeholders — the
   * write path GetImageURL relies on (slots are pre-materialized
   * server-side, so the module's `TASK.PageLinks[WORKID-1] = url` never
   * raises an out-of-bounds error).
   */
  private adoptReadBack(task: TaskWriter, pad = false): boolean {
    const read = this.dispatcher.readTask();
    this.pageLinksMirror.length = 0;
    this.pageLinksMirror.push(...read.pageLinks);
    if (pad) {
      while (this.pageLinksMirror.length < read.pageNumber) {
        this.pageLinksMirror.push('W');
      }
    }
    task.pageLinks.length = 0;
    task.pageLinks.push(...this.pageLinksMirror);
    task.pageNumber = read.pageNumber;
    return true;
  }
}

