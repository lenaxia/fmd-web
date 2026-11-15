import type {
  EventBinding,
  EventContext,
  EventDeadlineController,
  EventDispatchResult,
  EventDispatcher,
  EventGlobalValue,
  EventTaskSeed,
  HostLogger,
  HttpAbortHandle,
  LuaModuleDescriptor,
  NetStatusCode,
} from '@fmd/contract';
import { GC_STEP_CALL_THRESHOLD, WasmoonLuaEngine } from '../lua/engine.js';
import type { FacadeBridge, FacadeSpec } from '../lua/facade.js';
import { ModuleBacking } from '../lua/module-facade.js';
import { makeMangaInfoSpec } from '../lua/mangainfo.js';
import { makeHTTPSpec, makeTStrings } from '../lua/stubs.js';
import { TStringsStorageStrings } from '../lua/storage.js';
import { DEFAULT_EVENT_DEADLINE_MS } from '../lua/worker-pool.js';
import { EVENT_BINDINGS, type EventGlobalName } from './bindings.js';
import { createDeadlineController } from './deadline.js';

/**
 * §5.2 event dispatcher — the binding table is GENERATED DATA from
 * contract.json (§5 implementation rule: never hand-coded, see
 * bindings.generated.ts): `MODULE` bound for every event, the row's exact
 * globals, the row's status-constant table (net-status for the code rows,
 * account-status for Login/AccountState/CheckSite), return protocol by row
 * kind (codes / booleans / SaveImage string), `PAGENUMBER` the only
 * read-back global, `URL` never read back.
 */

/** Optional v0 shim hooks (§5.4/§5.2): real HTTP objects + accounts. */
export interface DispatcherShims {
  /** Fresh request-scoped HTTP facade per event call (FMD2 LoadObject). */
  readonly makeHTTP?: (bridge: FacadeBridge) => FacadeSpec;
  /**
   * Host-level account credentials reached as MODULE.Account (§5.2).
   * `cookies`/`status` seed the persisted prior-session state (FMD2's
   * loaded TWebsiteModuleAccount — modules.json Account.Cookies/Status);
   * the handler reads/writes the same fields (read-back after Login).
   */
  readonly account?: {
    readonly enabled: boolean;
    readonly username: string;
    readonly password: string;
    readonly cookies?: string;
    readonly status?: number;
  };
}

export class EventNotBoundError extends Error {
  constructor(
    event: string,
    detail = 'no such event row',
  ) {
    super(`event not bound: ${event} (${detail})`);
  }
}

const LUA_TBOOLEAN = 1;
const LUA_TNUMBER = 3;
const LUA_TSTRING = 4;

/** The module-writable TASK backing of the last dispatched download event. */
interface TaskHandle {
  readonly pageLinks: { readonly list: { readonly count: number; get(i: number): string } };
  readonly pageContainerLinks: { readonly list: { readonly count: number; get(i: number): string } };
  readonly fileNames: { readonly list: { readonly count: number; get(i: number): string } };
  readonly pageNumber: () => number;
}

/** §5.2 status constants (WebsiteModules.pas:19-21, :78). */
const NET_STATUS: Readonly<Record<string, number>> = {
  no_error: 0,
  net_problem: 1,
  information_not_found: 2,
};
const ACCOUNT_STATUS: Readonly<Record<string, number>> = {
  asUnknown: 0,
  asChecking: 1,
  asValid: 2,
  asInvalid: 3,
};

export class ContractEventDispatcher implements EventDispatcher {
  private readonly moduleFacades = new Map<string, { generation: number; facadeId: number }>();

  /** §5.3 shared storage per module id — THE one instance across events.
   * The Lua-facing contract (TStringsStorage semantics) lives in
   * lua/storage.ts; the host-side state service (state/module-state.ts)
   * adapts to it via the StorageStrings seam. */
  private readonly storageBackings = new Map<string, TStringsStorageStrings>();

  /** Optional v0 shim hooks (§5.4/§5.2) — installed by the shim installer. */
  private readonly shims: DispatcherShims;

  /** The TASK backing of the LAST dispatched event (download events;
   * the host's readTask accessor reads the module's writes back). */
  private lastTask: TaskHandle | undefined;

  constructor(
    private readonly engine: WasmoonLuaEngine,
    private readonly abort: HttpAbortHandle,
    private readonly deadline: EventDeadlineController,
    private readonly logger: HostLogger,
    private readonly bindings: readonly EventBinding[] = EVENT_BINDINGS,
    private readonly deadlineMs: number = DEFAULT_EVENT_DEADLINE_MS,
    shims: DispatcherShims = {},
  ) {
    this.shims = shims;
    // attach the event environment: abort + interrupt cells + attribution
    engine.env = {
      abort: this.abort,
      cells: this.deadline.cells,
      logger: this.logger,
      moduleId: '',
    };
  }

  dispatch(descriptor: LuaModuleDescriptor, event: string, context: EventContext = {}): EventDispatchResult {
    const binding = this.bindings.find((b) => b.event === event);
    if (binding === undefined) {
      throw new EventNotBoundError(event);
    }
    const handler = descriptor.eventHandlers[event];
    if (handler === undefined || handler === '') {
      throw new EventNotBoundError(event, `module ${descriptor.id} does not bind a handler`);
    }

    // lua_gc stepping every N calls (LuaHandler.pas:136-141)
    if (this.engine.callsSinceGc > GC_STEP_CALL_THRESHOLD) {
      this.engine.gcCollect();
    }
    this.engine.env = {
      abort: this.abort,
      cells: this.deadline.cells,
      logger: this.logger,
      moduleId: descriptor.id,
    };

    const outcome = this.deadline.run(this.deadlineMs, this.abort, () =>
      this.runEvent(binding, descriptor, handler, context),
    );
    this.engine.stepCalls();

    if (outcome.timedOut) {
      const reason = errorMessage(outcome.error) || 'event deadline exceeded';
      this.logger.write({
        level: 'warn',
        moduleId: descriptor.id,
        message: `LUA>${event}("${descriptor.name}") deadline exceeded`,
      });
      return { kind: 'failed', reason, timedOut: true };
    }
    if (outcome.threw) {
      const reason = errorMessage(outcome.error);
      this.logger.write({
        level: 'error',
        moduleId: descriptor.id,
        message: `LUA>${event}("${descriptor.name}")> ${reason}`,
      });
      return { kind: 'failed', reason, timedOut: false };
    }
    return outcome.value as EventDispatchResult;
  }

  private runEvent(
    binding: EventBinding,
    descriptor: LuaModuleDescriptor,
    handler: string,
    context: EventContext,
  ): EventDispatchResult {
    const engine = this.engine.innerEngine;
    const bridge = this.requireBridge();
    this.bindGlobals(bridge, binding, descriptor, context);

    const wasm = engine.global.lua;
    const state = engine.global.address;
    wasm.lua_getglobal(state, handler);
    const pcallResult = wasm.lua_pcallk(state, 0, 1, 0, 0, null);
    if (pcallResult !== 0) {
      const message = wasm.lua_tolstring(state, -1, null);
      wasm.lua_settop(state, 0);
      throw new Error(message ?? `lua_pcall(${handler}) failed: ${pcallResult}`);
    }
    const result = this.readResult(binding, wasm, state);
    const readBack = this.readBackGlobals(binding, wasm, state);
    wasm.lua_settop(state, 0);
    return withReadBack(result, readBack);
  }

  private bindGlobals(
    bridge: FacadeBridge,
    binding: EventBinding,
    descriptor: LuaModuleDescriptor,
    context: EventContext,
  ): void {
    const engine = this.engine.innerEngine;
    const g = engine.global;
    // The generated table guarantees globals ⊆ EventGlobalName; the cast
    // keeps the switch below exhaustive against the generated union.
    const boundGlobals = binding.globals as readonly EventGlobalName[];
    for (const name of boundGlobals) {
      switch (name) {
        case 'MODULE':
          this.bindModule(bridge, descriptor);
          break;
        case 'HTTP':
          // a fresh request-scoped HTTP object per call (FMD2 LoadObject);
          // the §5.4 shim factory (when installed) replaces the inert stub
          bridge.create('HTTP', this.shims.makeHTTP !== undefined ? this.shims.makeHTTP(bridge) : makeHTTPSpec(() => this.abort, bridge));
          break;
        case 'UPDATELIST':
          bridge.create('UPDATELIST', this.makeUpdateListSpec());
          break;
        case 'TASK':
          bridge.create('TASK', this.makeTaskSpec(bridge, context.task));
          break;
        case 'MANGAINFO': {
          // §5.5: the exact LuaMangaInfo field set (engine/lua/mangainfo.ts).
          // The GetInfo host flow harvests the raw module output from that
          // module's handle and runs the §5.8 pipeline (engine/normalize).
          bridge.create('MANGAINFO', makeMangaInfoSpec(bridge).spec);
          break;
        }
        case 'NAMES': {
          const names = makeTStrings(bridge);
          bridge.create('NAMES', names.spec);
          break;
        }
        case 'LINKS': {
          const links = makeTStrings(bridge);
          bridge.create('LINKS', links.spec);
          break;
        }
        case 'PAGENUMBER':
          g.set('PAGENUMBER', context.pageNumber ?? 0);
          break;
        case 'WORKPTR':
          g.set('WORKPTR', context.workPtr ?? 0);
          break;
        case 'WORKID':
          g.set('WORKID', context.workId ?? 0);
          break;
        case 'URL':
          // push-only: never read back (§5.2)
          g.set('URL', context.url ?? '');
          break;
        case 'PATH':
          g.set('PATH', context.path ?? '');
          break;
        case 'FILENAME':
          g.set('FILENAME', context.fileName ?? '');
          break;
        default: {
          // Compile-time drift guard: if contract.json grows a global the
          // dispatcher does not bind, the generated EventGlobalName union
          // widens and this `never` assignment fails the build.
          const unhandled: never = name;
          throw new Error(`unknown event global in contract.json: ${String(unhandled)}`);
        }
      }
    }
    // status constants per row (§5.2): net-status for code rows,
    // account-status for Login/AccountState/CheckSite
    const constants =
      binding.constants === 'net-status'
        ? NET_STATUS
        : binding.constants === 'account-status'
          ? ACCOUNT_STATUS
          : null;
    if (constants !== null) {
      for (const [name, value] of Object.entries(constants)) {
        g.set(name, value);
      }
    }
  }

  /** MODULE is bound for every event, the same object each time (:47-49). */
  private bindModule(bridge: FacadeBridge, descriptor: LuaModuleDescriptor): void {
    const generation = this.engine.generation;
    const cached = this.moduleFacades.get(descriptor.id);
    let facadeId: number;
    if (cached !== undefined && cached.generation === generation) {
      facadeId = cached.facadeId;
    } else {
      let storage = this.storageBackings.get(descriptor.id);
      if (storage === undefined) {
        storage = new TStringsStorageStrings();
        this.storageBackings.set(descriptor.id, storage);
      }
      const backing = ModuleBacking.fromDescriptor(descriptor, this.shims.account, storage);
      facadeId = bridge.create('MODULE', backing.spec(bridge));
      this.moduleFacades.set(descriptor.id, { generation, facadeId });
    }
    this.engine.innerEngine.doStringSync(`MODULE = __fmd_facades[${facadeId}]`);
  }

  /**
   * Host-side TASK readback (§5.2 download events): the module-writable
   * backing of the LAST dispatched event — the DownloadPageNumber/
   * GetImageURL flow reads PageLinks + PageNumber out of it. Empty
   * arrays when the last event bound no TASK.
   */
  readTask(): Required<EventTaskSeed> {
    const task = this.lastTask;
    if (task === undefined) {
      return { pageLinks: [], pageContainerLinks: [], fileNames: [], pageNumber: 0, link: '' };
    }
    const readList = (list: { count: number; get(i: number): string }): string[] => {
      const out: string[] = [];
      for (let i = 0; i < list.count; i += 1) {
        out.push(list.get(i));
      }
      return out;
    };
    return {
      pageLinks: readList(task.pageLinks.list),
      pageContainerLinks: readList(task.pageContainerLinks.list),
      fileNames: readList(task.fileNames.list),
      pageNumber: task.pageNumber(),
      link: '',
    };
  }

  private makeUpdateListSpec() {
    // §5.2 UPDATELIST = CurrentDirectoryPageNumber + UpdateStatusText
    let currentDirectoryPageNumber = 0;
    return {
      get: (k: string | number) =>
        k === 'CurrentDirectoryPageNumber'
          ? currentDirectoryPageNumber
          : k === 'UpdateStatusText'
            ? () => undefined
            : undefined,
      set: (k: string | number, v: EventGlobalValue) => {
        if (k === 'CurrentDirectoryPageNumber') {
          currentDirectoryPageNumber = typeof v === 'number' ? Math.trunc(v) : 0;
        }
      },
    };
  }

  private makeTaskSpec(bridge: FacadeBridge, seed?: EventTaskSeed) {
    const pageLinks = makeTStrings(bridge);
    const pageContainerLinks = makeTStrings(bridge);
    const fileNames = makeTStrings(bridge);
    const chapterLinks = makeTStrings(bridge);
    const chapterNames = makeTStrings(bridge);
    let pageNumber = seed?.pageNumber ?? 0;
    const link = { value: seed?.link ?? '' };
    // Pre-seed the module-writable lists from the host pipeline state
    // (§5.2: TASK is the persistent download task — GetImageURL reads
    // PageLinks[WORKID-1]). Host-side reads go through the same handles
    // (`readTask`), so the backing survives exactly one dispatch call.
    for (const value of seed?.pageLinks ?? []) {
      pageLinks.list.add(value);
    }
    for (const value of seed?.pageContainerLinks ?? []) {
      pageContainerLinks.list.add(value);
    }
    for (const value of seed?.fileNames ?? []) {
      fileNames.list.add(value);
    }
    this.lastTask = {
      pageLinks,
      pageContainerLinks,
      fileNames,
      pageNumber: (): number => pageNumber,
    };
    const lists: Record<string, number> = {
      PageLinks: bridge.create('', pageLinks.spec),
      PageContainerLinks: bridge.create('', pageContainerLinks.spec),
      FileNames: bridge.create('', fileNames.spec),
      ChapterLinks: bridge.create('', chapterLinks.spec),
      ChapterNames: bridge.create('', chapterNames.spec),
    };
    return {
      get: (k: string | number) => {
        if (k === 'PageNumber') {
          return pageNumber;
        }
        if (k === 'CurrentDownloadChapterPtr') {
          return 0; // read-only: host-maintained download pointer
        }
        if (k === 'CurrentMaxFileNameLength') {
          return 0; // read-only: host-maintained
        }
        if (k === 'Link') {
          return link.value;
        }
        return undefined;
      },
      set: (k: string | number, v: EventGlobalValue) => {
        if (k === 'PageNumber') {
          pageNumber = typeof v === 'number' ? Math.trunc(v) : 0;
        }
        // CurrentDownloadChapterPtr/CurrentMaxFileNameLength/Link are
        // read-only (contract.json taskFields) — writes silently dropped
      },
      sub: (k: string | number) => (typeof k === 'string' ? lists[k] : undefined),
    };
  }

  private readResult(
    binding: EventBinding,
    wasm: import('wasmoon').LuaWasm,
    state: number,
  ): EventDispatchResult {
    switch (binding.returns) {
      case 'code': {
        // FMD2: Result := lua_tointeger(L, -1) — nil reads as 0
        const value = Number(wasm.lua_tointegerx(state, -1, null)) as NetStatusCode;
        return { kind: 'code', value, readBack: {} };
      }
      case 'boolean':
        return { kind: 'boolean', value: wasm.lua_toboolean(state, -1) !== 0 };
      case 'string':
        return { kind: 'string', value: wasm.lua_tolstring(state, -1, null) ?? '' };
      default: {
        const exhaustive: never = binding.returns;
        throw new Error(`unknown return kind: ${String(exhaustive)}`);
      }
    }
  }

  private readBackGlobals(
    binding: EventBinding,
    wasm: import('wasmoon').LuaWasm,
    state: number,
  ): Record<string, EventGlobalValue> {
    const readBack: Record<string, EventGlobalValue> = {};
    for (const name of binding.readBack) {
      wasm.lua_getglobal(state, name);
      const type = wasm.lua_type(state, -1);
      let value: EventGlobalValue = null;
      if (type === LUA_TNUMBER) {
        value = wasm.lua_tonumberx(state, -1, null);
      } else if (type === LUA_TSTRING) {
        value = wasm.lua_tolstring(state, -1, null) ?? '';
      } else if (type === LUA_TBOOLEAN) {
        value = wasm.lua_toboolean(state, -1) !== 0;
      }
      wasm.lua_pop(state, 1);
      readBack[name] = value;
    }
    return readBack;
  }

  private requireBridge(): FacadeBridge {
    return this.engine.debugBridge;
  }
}

function withReadBack(
  result: EventDispatchResult,
  readBack: Record<string, EventGlobalValue>,
): EventDispatchResult {
  if (result.kind === 'code') {
    return { kind: 'code', value: result.value, readBack };
  }
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Factory: attach a dispatcher (with its watchdog) to a worker engine. */
export function createContractDispatcher(
  engine: WasmoonLuaEngine,
  abort: HttpAbortHandle,
  logger: HostLogger,
  deadline?: EventDeadlineController,
  bindings?: readonly EventBinding[],
  deadlineMs?: number,
  shims?: DispatcherShims,
): ContractEventDispatcher {
  const controller = deadline ?? createDeadlineController(engine.env.cells);
  return new ContractEventDispatcher(
    engine,
    abort,
    controller,
    logger,
    bindings,
    deadlineMs,
    shims,
  );
}
