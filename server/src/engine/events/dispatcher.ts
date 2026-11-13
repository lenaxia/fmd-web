import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type {
  ContractDocument,
  EventBinding,
  EventContext,
  EventDeadlineController,
  EventDispatchResult,
  EventDispatcher,
  EventGlobalValue,
  HostLogger,
  HttpAbortHandle,
  LuaModuleDescriptor,
  NetStatusCode,
} from '@fmd/contract';
import { GC_STEP_CALL_THRESHOLD, WasmoonLuaEngine } from '../lua/engine.js';
import { FacadeBridge } from '../lua/facade.js';
import { ModuleBacking } from '../lua/module-facade.js';
import { makeHTTPSpec, makeTStrings } from '../lua/stubs.js';
import { DEFAULT_EVENT_DEADLINE_MS } from '../lua/worker-pool.js';
import { createDeadlineController } from './deadline.js';

/**
 * §5.2 event dispatcher — the binding table is DATA from contract.json
 * (§5 implementation rule: never hand-coded): `MODULE` bound for every
 * event, the row's exact globals, the row's status-constant table
 * (net-status for the code rows, account-status for Login/AccountState/
 * CheckSite), return protocol by row kind (codes / booleans / SaveImage
 * string), `PAGENUMBER` the only read-back global, `URL` never read back.
 */

const require = createRequire(import.meta.url);

function loadContractDocument(): ContractDocument {
  const path = require.resolve('@fmd/contract/contract.json');
  return JSON.parse(readFileSync(path, 'utf8')) as ContractDocument;
}

const CONTRACT_DOCUMENT: ContractDocument = loadContractDocument();

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

  constructor(
    private readonly engine: WasmoonLuaEngine,
    private readonly abort: HttpAbortHandle,
    private readonly deadline: EventDeadlineController,
    private readonly logger: HostLogger,
    private readonly bindings: readonly EventBinding[] = CONTRACT_DOCUMENT.events,
    private readonly deadlineMs: number = DEFAULT_EVENT_DEADLINE_MS,
  ) {
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
    for (const name of binding.globals) {
      switch (name) {
        case 'MODULE':
          this.bindModule(bridge, descriptor);
          break;
        case 'HTTP':
          // a fresh request-scoped HTTP object per call (FMD2 LoadObject)
          bridge.create('HTTP', makeHTTPSpec(() => this.abort, bridge));
          break;
        case 'UPDATELIST':
          bridge.create('UPDATELIST', this.makeUpdateListSpec());
          break;
        case 'TASK':
          bridge.create('TASK', this.makeTaskSpec(bridge));
          break;
        case 'MANGAINFO':
          bridge.create('MANGAINFO', this.makeMangaInfoSpec(bridge));
          break;
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
        default:
          throw new Error(`unknown event global in contract.json: ${name}`);
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
      const backing = ModuleBacking.fromDescriptor(descriptor);
      facadeId = bridge.create('MODULE', backing.spec(bridge));
      this.moduleFacades.set(descriptor.id, { generation, facadeId });
    }
    this.engine.innerEngine.doStringSync(`MODULE = __fmd_facades[${facadeId}]`);
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

  private makeTaskSpec(bridge: FacadeBridge) {
    const pageLinks = makeTStrings(bridge);
    const pageContainerLinks = makeTStrings(bridge);
    const fileNames = makeTStrings(bridge);
    const chapterLinks = makeTStrings(bridge);
    const chapterNames = makeTStrings(bridge);
    let pageNumber = 0;
    const link = { value: '' };
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

  private makeMangaInfoSpec(bridge: FacadeBridge) {
    const strings: Record<string, string> = {
      URL: '',
      Title: '',
      AltTitles: '',
      Link: '',
      CoverLink: '',
      Authors: '',
      Artists: '',
      Genres: '',
      Status: '',
      Summary: '',
    };
    // unknown-property tolerance is behavioral contract: e.g. the
    // MANGAINFO.Artist typo (OrckuMangas.lua:91) silently no-ops (§5.1)
    const chapterLinks = makeTStrings(bridge);
    const chapterNames = makeTStrings(bridge);
    const lists: Record<string, number> = {
      ChapterLinks: bridge.create('', chapterLinks.spec),
      ChapterNames: bridge.create('', chapterNames.spec),
    };
    return {
      get: (k: string | number) => (typeof k === 'string' ? strings[k] : undefined),
      set: (k: string | number, v: EventGlobalValue) => {
        if (typeof k === 'string' && k in strings) {
          strings[k] = typeof v === 'string' ? v : String(v ?? '');
        }
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
): ContractEventDispatcher {
  const controller = deadline ?? createDeadlineController(engine.env.cells);
  return new ContractEventDispatcher(
    engine,
    abort,
    controller,
    logger,
    bindings,
    deadlineMs,
  );
}
