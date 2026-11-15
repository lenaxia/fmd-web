import type { HostLogRecord } from '@fmd/contract';
import { ApiError } from '../api/errors.js';
import type { InfoService, NormalizedInfo } from '../api/services.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../engine/lua/abort.js';
import { createLuaHost, type WasmoonLuaHost } from '../engine/lua/host.js';
import { createMemoryLogger, TeeMemoryLogger, type MemoryLogger } from '../engine/lua/logger.js';
import { createContractDispatcher } from '../engine/events/dispatcher.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../engine/shims/install.js';
import { RecordedResponseResolver } from '../engine/shims/http-shim.js';
import type { EgressPolicy, HttpTransportPort } from '../engine/shims/http-shim.js';
import type { ProxyConfig } from '../engine/shims/http-proxy.js';
import type { BypassExecutorPort } from '../engine/sidecar/bypass-adapter.js';
import type { SwallowSharedDeduper } from '../engine/shims/txquery-shim.js';
import { normalizeMangaInfo } from '../engine/normalize/udata.js';
import type { RegistrationRecord } from '../engine/registry/capabilities.js';

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
}

/** no_error / net_problem (§5.2 dispatch result codes). */
const NO_ERROR = 0;

export class EngineInfoService implements InfoService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly hosts: Set<WasmoonLuaHost> = new Set();

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
    const host: WasmoonLuaHost = createLuaHost(logger);
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
        const dispatcher = createContractDispatcher(engine, abort, logger, undefined, undefined, undefined, {
          makeHTTP: shimKit.makeHTTP,
        });
        const result = dispatcher.dispatch(descriptor, 'GetInfo', { url });
        if (result.kind === 'failed') {
          throw new ApiError(
            502,
            'upstream_error',
            `GetInfo failed: ${result.reason}${result.timedOut ? ' (deadline)' : ''}`,
          );
        }
        if (result.kind !== 'code' || result.value !== NO_ERROR) {
          throw new ApiError(502, 'upstream_error', `GetInfo returned net_problem for ${url}`);
        }
        return this.readNormalizedInfo(engine.innerEngine.doStringSync.bind(engine.innerEngine));
      } finally {
        await engine.dispose();
      }
    } finally {
      this.hosts.delete(host);
      await host.dispose();
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
