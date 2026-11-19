/**
 * Engine-backed live info (§5.8) — MOVED inside the engine by the
 * engine-boundary story: host-driving MECHANISM. The api layer sees only
 * the ModuleInfoPort + the contract's NormalizedInfo domain shape (via the
 * facade); failures throw the contract's typed ApiError envelope.
 */
import type { HostLogRecord } from '@fmd/contract';
import type { LuaHost, LuaHostFactory } from '../contract.js';
import { ApiError, type NormalizedInfo } from '@fmd/contract';
import { DeadlineAbortHandle, createDeadlineCells } from '../lua/abort.js';
import { createMemoryLogger, TeeMemoryLogger, type MemoryLogger } from '../lua/logger.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../shims/install.js';
import { RecordedResponseResolver } from '../shims/http-shim.js';
import type { EgressPolicy, HttpTransportPort } from '../shims/http-shim.js';
import type { ProxyConfig } from '../shims/http-proxy.js';
import type { BypassExecutorPort } from '../sidecar/bypass-adapter.js';
import type { SwallowSharedDeduper } from '../shims/txquery-shim.js';
import { normalizeMangaInfo } from '../normalize/udata.js';
import type { RegistrationRecord } from '../registry/capabilities.js';
import type { ModuleSharedState } from '../state/module-state.js';
import {
  classifyHttpOutcome,
  readHttpOutcome,
  type AvailabilitySink,
} from './availability.js';

/**
 * Engine-backed live info (§5.8): POST /api/info runs the module's real
 * GetInfo through a wasmoon engine with the §5.4 HTTP shims — requests
 * go out over the configured transport (loopback / compose mock
 * allow-list) and the RAW MANGAINFO is post-processed by the §5.8
 * pipeline (`normalizeMangaInfo`) before it is cached/returned.
 *
 * One engine per call, created and disposed inside the call: the
 * worker-pool story (§5.12) replaces this with pooled engines once the
 * queue lands; a simple promise chain serializes calls meanwhile.
 */

export interface EngineInfoOptions {
  /** Synced lua tree root (`<dataDir>/lua`). */
  readonly luaRoot: string;
  /** Registry rows provider (re-read per call — the registry can refresh). */
  readonly modules: () => readonly RegistrationRecord[];
  /** Live transport (LoopbackHttpTransport with the mock allow-list). */
  readonly transport: HttpTransportPort;
  /** Egress policy for module HTTP (allow-lists the mock upstream). */
  readonly egress: EgressPolicy;
  /**
   * §5.6 run-level expression-failure dedup shared across every engine
   * this service creates (observability assembly binds its logger's
   * deduper so the max-1-WARN bound holds for the whole run).
   */
  readonly swallowDeduper?: SwallowSharedDeduper;
  /**
   * §4 structured-log tee: every HostLogRecord (module print routing +
   * swallowed-expression WARNs) is ALSO forwarded here, so the run log
   * carries module-id-correlated lines (the per-call MemoryLogger keeps
   * feeding the engine internals).
   */
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
   * via module_state at the end of the call.
   */
  readonly moduleState?: (moduleId: string) => Promise<ModuleSharedState>;
  /**
   * Site-availability sink (dead-site discovery): after every GetInfo
   * dispatch the request-scoped HTTP readback (the httpFailureDetail
   * seam) is classified — transport/5xx → unreachable, 2xx/3xx →
   * reachable, 4xx/abstain → nothing. Fire-and-forget; never throws
   * into the traffic path.
   */
  readonly availabilitySink?: AvailabilitySink;
  /**
   * Lua host factory (injected by the composition root): constructs the
   * per-call host behind the contract LuaHost interface — substitute
   * hosts (test doubles) wire in here without touching this service.
   */
  readonly hostFactory: LuaHostFactory;
}

/** no_error / net_problem (§5.2 dispatch result codes). */
const NO_ERROR = 0;

/** The module-info SERVICE port (facade-exported; stub substrates implement this). */
export interface ModuleInfoPort {
  getInfo(moduleId: string, url: string): Promise<NormalizedInfo>;
  /** Dispose any engine still alive (SIGTERM drain). */
  dispose(): Promise<void>;
}

export class EngineInfoService implements ModuleInfoPort {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly hosts: Set<LuaHost> = new Set();

  constructor(private readonly options: EngineInfoOptions) {}

  async getInfo(moduleId: string, url: string): Promise<NormalizedInfo> {
    // Serialize engine creation/disposal — one wasmoon engine at a time
    // until the pooled worker story lands.
    const run = this.tail.then((): Promise<NormalizedInfo> => this.runGetInfo(moduleId, url));
    this.tail = run.catch((): void => undefined);
    return run;
  }

  /** Dispose any engine still alive (SIGTERM drain). */
  async dispose(): Promise<void> {
    for (const host of this.hosts) {
      await host.dispose();
    }
    this.hosts.clear();
  }

  private async runGetInfo(moduleId: string, url: string): Promise<NormalizedInfo> {
    const registration = this.options.modules().find((m) => m.id === moduleId);
    if (registration === undefined) {
      throw new ApiError(404, 'not_found', `unknown module: ${moduleId}`);
    }
    const sink = this.options.logSink;
    const logger: MemoryLogger = sink === undefined
      ? createMemoryLogger()
      : new TeeMemoryLogger(sink);
    const host: LuaHost = this.options.hostFactory.createHost(logger);
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
        ...(this.options.bypass !== undefined ? { bypass: this.options.bypass } : {}),
      });
      // registration.file is the basename within the tree's modules dir
      // (the sweep's discovery order); chunk cache + engine load are
      // keyed by the lua-root-relative path.
      const modulePath = `modules/${registration.file}`;
      const descriptors = await loadRealModuleFile(host, luaRoot, modulePath, hook);
      const descriptor = descriptors.find((d) => d.id === moduleId) ?? descriptors[0];
      if (descriptor === undefined) {
        throw new ApiError(502, 'upstream_error', `module ${moduleId} failed to initialize`);
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
        const initialProxy = this.options.proxyFor?.(descriptor.id);
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
            ...(initialProxy !== undefined ? { initialProxy } : {}),
            ...(this.options.bypass !== undefined ? { bypass: this.options.bypass } : {}),
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
        });
        const result = dispatcher.dispatch(descriptor, 'GetInfo', { url });
        // Site-availability opportunistic write: ONE seam point after
        // the dispatch — the §5.2 readback classifies the site's HTTP
        // state on success AND failure paths alike.
        this.reportAvailability(descriptor.id, engine);
        if (sharedState !== undefined) {
          await sharedState.persist();
        }
        if (result.kind === 'failed') {
          throw new ApiError(
            502,
            'upstream_error',
            `GetInfo failed: ${result.reason}${result.timedOut ? ' (deadline)' : ''}`,
          );
        }
        if (result.kind !== 'code' || result.value !== NO_ERROR) {
          throw new ApiError(
            502,
            'upstream_error',
            `GetInfo returned net_problem for ${url}${this.httpFailureDetail(engine)}`,
          );
        }
        return this.readNormalizedInfo(engine.doStringSync.bind(engine));
      } finally {
        await engine.dispose();
      }
    } finally {
      this.hosts.delete(host);
      await host.dispose();
    }
  }

  /**
   * The request-scoped HTTP object survives the dispatch on the engine
   * (same readback path MANGAINFO uses): after a net_problem its
   * ResultCode/ResultString name the failing hop — ResultString carries
   * the transport error text ('timeout', TLS failure…) or the response
   * status line (an error status with an empty body fails the
   * Document.Size>0 rule, e.g. a parked domain's 405). Without this the
   * upstream_error is an unattributable 'net_problem' (the MangaPark
   * incident: parked mirror + slow-origin 523s both rendered identically
   * silent). Reads are best-effort — a cleared env keeps the bare
   * message.
   */
  private httpFailureDetail(engine: { doStringSync: (code: string) => unknown }): string {
    const read = readHttpOutcome(engine.doStringSync.bind(engine));
    if (read === undefined || read.resultString === '') {
      return '';
    }
    return ` (HTTP ${String(read.resultCode)}: ${read.resultString.slice(0, 200)})`;
  }

  /**
   * Classify the surviving request-scoped HTTP state into the
   * availability sink (never throws — a broken sink must not take the
   * info path down with it).
   */
  private reportAvailability(moduleId: string, engine: { doStringSync: (code: string) => unknown }): void {
    const sink = this.options.availabilitySink;
    if (sink === undefined) {
      return;
    }
    const read = readHttpOutcome(engine.doStringSync.bind(engine));
    if (read === undefined) {
      return;
    }
    const outcome = classifyHttpOutcome(read.resultCode, read.resultString);
    if (outcome === undefined) {
      return;
    }
    try {
      sink(moduleId, outcome);
    } catch {
      // fire-and-forget by contract
    }
  }

  /**
   * Read the MANGAINFO backing after a successful dispatch: scalar
   * fields one round-trip each, chapter TStrings by index — the same
   * host-side reads the e2e golden harness uses — then run §5.8.
   */
  private readNormalizedInfo(
    runLua: (code: string) => unknown,
  ): NormalizedInfo {
    const field = (name: string): string => String(runLua(`return MANGAINFO.${name}`) ?? '');
    const count = Number(runLua('return MANGAINFO.ChapterLinks.Count') ?? 0);
    const chapterLinks: string[] = [];
    const chapterNames: string[] = [];
    for (let i = 0; i < count; i += 1) {
      chapterLinks.push(String(runLua(`return MANGAINFO.ChapterLinks[${String(i)}]`) ?? ''));
      chapterNames.push(String(runLua(`return MANGAINFO.ChapterNames[${String(i)}]`) ?? ''));
    }
    const normalized = normalizeMangaInfo({
      url: field('URL'),
      title: field('Title'),
      altTitles: field('AltTitles'),
      authors: field('Authors'),
      artists: field('Artists'),
      genres: field('Genres'),
      status: field('Status'),
      summary: field('Summary'),
      coverLink: field('CoverLink'),
      link: field('Link'),
      chapterLinks,
      chapterNames,
    });
    return {
      title: normalized.title,
      altTitles: normalized.altTitles,
      authors: normalized.authors,
      artists: normalized.artists,
      genres: normalized.genres,
      status: normalized.status,
      summary: normalized.summary,
      coverLink: normalized.coverLink,
      url: normalized.url,
      link: normalized.link,
      chapterLinks: [...normalized.chapterLinks],
      chapterNames: [...normalized.chapterNames],
      numChapter: normalized.numChapter,
    };
  }
}

/** Shape used only for the log projection of a failed dispatch. */
export function summarizeLog(records: readonly HostLogRecord[]): string {
  return records.slice(-5).map((r) => r.message).join(' | ');
}
