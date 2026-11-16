import { CatalogFallbackError, type CatalogEntry, type LuaModuleDescriptor } from '@fmd/contract';
import type { RegistrationRecord } from '../engine/registry/capabilities.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../engine/lua/abort.js';
import { createLuaHost, type WasmoonLuaHost } from '../engine/lua/host.js';
import { createMemoryLogger, TeeMemoryLogger, type MemoryLogger } from '../engine/lua/logger.js';
import { createContractDispatcher, type ContractEventDispatcher } from '../engine/events/dispatcher.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../engine/shims/install.js';
import { RecordedResponseResolver } from '../engine/shims/http-shim.js';
import type { EgressPolicy, HttpTransportPort } from '../engine/shims/http-shim.js';
import type { HostGatePort } from '../engine/shims/http-hostgate.js';
import type { ProxyConfig } from '../engine/shims/http-proxy.js';
import type { BypassExecutorPort } from '../engine/sidecar/bypass-adapter.js';
import type { SwallowSharedDeduper } from '../engine/shims/txquery-shim.js';
import type { HostLogRecord } from '@fmd/contract';
import { normalizeMangaInfo } from '../engine/normalize/udata.js';
import type { ModuleSharedState } from '../engine/state/module-state.js';

/**
 * §6.8 live-scrape directory walk: ONE pass of the FMD2 update-thread
 * directory algorithm (uUpdateThread.pas) against a real module file —
 *
 * 1. `GetDirectoryPageNumber` (PAGENUMBER in → READ BACK, §5.2) gives
 *    the site's directory page count. A failed/net_problem answer is a
 *    typed `walk_failed` — FMD2 would log-and-continue with 1 page, but
 *    a browse response must NEVER be a silently truncated directory.
 * 2. `GetNameAndLink` per page (`URL` = 0-based page index; modules do
 *    `URL + 1` against their pagination template, uUpdateThread loop
 *    parity). NAMES/LINKS are read back host-side after each call (the
 *    same runLua reads the e2e golden harness uses). ANY page failure
 *    discards the whole walk — never a partial page.
 * 3. Every (title, link) pair goes through the §5.8 post-processing
 *    pipeline (`normalizeMangaInfo`, uData.pas:85-207): title cleanup
 *    chain + the link fallback from URL (`removeHostFromURL`,
 *    uData.pas:111-113) — the same host-strip uUpdateThread.pas:236-239
 *    applies to update-list scraped links. Entries whose link reduces
 *    to '' are dropped (RemoveHostFromURLsPair :983 parity).
 *
 * Each walk runs one wasmoon engine created and disposed inside the
 * call (the engine-per-call model EngineInfoService uses), under the
 * §5.4 HTTP shims: egress policy, per-host gate, proxy, sidecar bypass.
 * The wall-clock story is the per-event deadline (§4) wired by the
 * dispatcher — every page event is bounded; the caller (the fallback
 * store) bounds WALKS with the update-lane slot budget.
 */

/** Directory entries exactly as the module wrote them (pre-§5.8). */
export interface RawDirectoryEntry {
  readonly title: string;
  readonly link: string;
}

/** The module-API walk seam the fallback store consumes (§6.8). */
export interface DirectoryWalkPort {
  walk(moduleId: string): Promise<readonly CatalogEntry[]>;
}

/** Sane ceiling on a module-reported directory page count — a hostile
 * PAGENUMBER (1e9) is a walk failure, never a truncated crawl. */
export const MAX_DIRECTORY_PAGES = 10_000;

export interface EngineDirectoryWalkerOptions {
  /** Synced lua tree root (`<dataDir>/lua`). */
  readonly luaRoot: string;
  /** Registry rows provider (re-read per walk — the registry can refresh). */
  readonly modules: () => readonly RegistrationRecord[];
  /** Live transport (LoopbackHttpTransport with the mock allow-list). */
  readonly transport: HttpTransportPort;
  /** Egress policy for module HTTP. */
  readonly egress: EgressPolicy;
  /** §5.4 per-host connection gate (limits + start-interval delays). */
  readonly hostGate?: HostGatePort;
  /** §5.6 run-level expression-failure dedup (shared with the run). */
  readonly swallowDeduper?: SwallowSharedDeduper;
  /** §4 structured-log tee (module print routing + WARNs). */
  readonly logSink?: (record: HostLogRecord) => void;
  /** Settings-resolved per-module proxy (§9/§10). */
  readonly proxyFor?: (moduleId: string) => ProxyConfig | undefined;
  /** §5.11 browser sidecar adapter (undefined = denied stub stands). */
  readonly bypass?: BypassExecutorPort;
  /**
   * §5.3 per-module shared-state resolver (audit F-2): when wired, the
   * module's SharedCookieJar backs BOTH the HTTP shims (request cookie
   * injection) and the MODULE cookie methods, and the jar text persists
   * via module_state at the end of the walk.
   */
  readonly moduleState?: (moduleId: string) => Promise<ModuleSharedState>;
}

/** no_error / net_problem (§5.2 dispatch result codes). */
const NO_ERROR = 0;

export class EngineDirectoryWalker implements DirectoryWalkPort {
  constructor(private readonly options: EngineDirectoryWalkerOptions) {}

  /** §6.8 capability check shared by the store's `supports()`. */
  canWalk(moduleId: string): boolean {
    const row = this.options.modules().find((m) => m.id === moduleId);
    return row?.capabilities.live_scrape_fallback === true;
  }

  async walk(moduleId: string): Promise<readonly CatalogEntry[]> {
    const registration = this.options.modules().find((m) => m.id === moduleId);
    if (registration === undefined || registration.capabilities.live_scrape_fallback !== true) {
      throw new CatalogFallbackError(
        'fallback_unavailable',
        `module ${moduleId} is not registered (or declares no directory walk) — no catalog and no live fallback (§6.8)`,
      );
    }
    const sink = this.options.logSink;
    const logger: MemoryLogger = sink === undefined
      ? createMemoryLogger()
      : new TeeMemoryLogger(sink);
    const host: WasmoonLuaHost = createLuaHost(logger);
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
      const modulePath = `modules/${registration.file}`;
      const descriptors = await loadRealModuleFile(host, luaRoot, modulePath, hook);
      const descriptor = descriptors.find((d) => d.id === moduleId) ?? descriptors[0];
      if (descriptor === undefined) {
        throw new CatalogFallbackError('walk_failed', `module ${moduleId} failed to initialize`);
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
            ...(this.options.hostGate !== undefined ? { gate: this.options.hostGate } : {}),
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
          throw new CatalogFallbackError('walk_failed', 'shim install did not run');
        }
        const dispatcher = createContractDispatcher(engine, abort, logger, undefined, undefined, undefined, {
          makeHTTP: shimKit.makeHTTP,
          ...(sharedCookies !== undefined ? { moduleCookies: () => sharedCookies } : {}),
        });
        const runLua = (code: string): unknown => engine.innerEngine.doStringSync(code);
        const raw = walkDirectory(dispatcher, descriptor, runLua);
        if (sharedState !== undefined) {
          await sharedState.persist();
        }
        return normalizeDirectoryEntries(raw);
      } finally {
        await engine.dispose();
      }
    } finally {
      await host.dispose();
    }
  }
}

/** The uUpdateThread directory loop: page count → per-page pair
 * harvest; ANY failure throws `walk_failed` (never partial). */
function walkDirectory(
  dispatcher: ContractEventDispatcher,
  descriptor: LuaModuleDescriptor,
  runLua: (code: string) => unknown,
): readonly RawDirectoryEntry[] {
  const pages = readDirectoryPageCount(dispatcher, descriptor);
  const raw: RawDirectoryEntry[] = [];
  for (let page = 0; page < pages; page += 1) {
    const result = dispatcher.dispatch(descriptor, 'GetNameAndLink', { url: String(page) });
    if (result.kind === 'failed') {
      throw new CatalogFallbackError(
        'walk_failed',
        `GetNameAndLink failed on page ${page}: ${result.reason}${result.timedOut ? ' (deadline)' : ''}`,
      );
    }
    if (result.kind !== 'code' || result.value !== NO_ERROR) {
      throw new CatalogFallbackError('walk_failed', `GetNameAndLink returned net_problem on page ${page}`);
    }
    raw.push(...readNamesAndLinks(runLua));
  }
  return raw;
}

/** GetDirectoryPageNumber with the §5.2 PAGENUMBER read-back. */
function readDirectoryPageCount(
  dispatcher: ContractEventDispatcher,
  descriptor: LuaModuleDescriptor,
): number {
  if (descriptor.eventHandlers['GetDirectoryPageNumber'] === undefined) {
    return 1; // static TotalDirectory modules are not §6.8-capable anyway
  }
  const result = dispatcher.dispatch(descriptor, 'GetDirectoryPageNumber', {
    pageNumber: 1,
    workPtr: 0,
  });
  if (result.kind === 'failed') {
    throw new CatalogFallbackError(
      'walk_failed',
      `GetDirectoryPageNumber failed: ${result.reason}${result.timedOut ? ' (deadline)' : ''}`,
    );
  }
  if (result.kind !== 'code' || result.value !== NO_ERROR) {
    throw new CatalogFallbackError('walk_failed', 'GetDirectoryPageNumber returned net_problem');
  }
  const reported = result.readBack['PAGENUMBER'];
  const pages =
    typeof reported === 'number' && Number.isFinite(reported) ? Math.trunc(reported) : 1;
  if (pages > MAX_DIRECTORY_PAGES) {
    throw new CatalogFallbackError(
      'walk_failed',
      `module reported ${pages} directory pages (over the ${MAX_DIRECTORY_PAGES} safety ceiling)`,
    );
  }
  return Math.max(1, pages);
}

/** Host-side NAMES/LINKS read-back after one GetNameAndLink call —
 * the same runLua reads the e2e golden harness uses. Pairs zip to the
 * SHORTER list (defensive: FMD2 assumes parallel lists). */
function readNamesAndLinks(runLua: (code: string) => unknown): readonly RawDirectoryEntry[] {
  const nameCount = Number(runLua('return NAMES.Count') ?? 0);
  const linkCount = Number(runLua('return LINKS.Count') ?? 0);
  const count = Math.max(0, Math.min(Math.trunc(nameCount), Math.trunc(linkCount)));
  const pairs: RawDirectoryEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    pairs.push({
      title: String(runLua(`return NAMES[${String(i)}]`) ?? ''),
      link: String(runLua(`return LINKS[${String(i)}]`) ?? ''),
    });
  }
  return pairs;
}

/** §5.8 pipeline over the scraped pairs (see module doc): title cleanup
 * chain + link fallback from URL (host strip, uData.pas:111-113);
 * link-less entries are dropped (uBaseUnit.pas:983 pair parity). */
export function normalizeDirectoryEntries(
  raw: readonly RawDirectoryEntry[],
): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const pair of raw) {
    const normalized = normalizeMangaInfo({
      url: pair.link,
      title: pair.title,
      link: '',
      chapterLinks: [],
      chapterNames: [],
    });
    if (normalized.link === '') {
      continue;
    }
    entries.push({
      link: normalized.link,
      title: normalized.title,
      alttitles: '',
      authors: '',
      artists: '',
      genres: '',
      status: '',
      summary: '',
      numChapter: 0,
      jdn: 0,
    });
  }
  return entries;
}
