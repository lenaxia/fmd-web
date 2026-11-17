import fontoxpath from 'fontoxpath';
const { evaluateXPath } = fontoxpath;
import type { HostLogger, ModuleId } from '@fmd/contract';
import type { LuaFacadeBridge } from '../contract.js';
import { toStr } from '../lua/base-globals.js';
import type { FacadeGetResult, FacadeSpec } from '../lua/facade.js';
import {
  ensureLinkedomLowercase,
  fmdNamespaceResolver,
  innerTextOf,
  itemToString,
  joinSeparatorString,
  parseQueryDocument,
  pascalTrim,
  registerFmdFunctions,
  SwallowLogger,
  type DuckDocument,
  type DuckNode,
  type SwallowSharedDeduper,
} from './txquery-shim.js';
import { transformExpression } from './query-dialect.js';
import type { HttpDocument } from './http-shim.js';

/**
 * TXQuery + IXQValue facades (§5.6, LuaXQuery.pas + LuaIXQValue.pas):
 * the bridge-side half of the TXQuery shim. `CreateTXQuery` accepts an
 * HTTP Document facade, an HTML string, or nothing (LuaXQuery.pas:209-212
 * — `ParseHTML` is the 1-arg instance reparse, :45-56). List-fill
 * overloads mutate the TStrings facade through a Lua-side glue helper
 * (LuaXQuery.pas:124-145). Evaluation errors are swallowed to empty
 * results with rate-limited WARN (XQueryEngineHTML.pas:358-399).
 *
 * Facade TABLES cannot cross the JS↔Lua bridge, so every method that
 * returns a facade (`XPath` → IXQValue, `GetProperty`, `Get`) is wired
 * Lua-side: a Lua closure delegates to a JS engine-global callback that
 * returns the RESULT FACADE ID, and the closure unwraps it from
 * `__fmd_facades`.
 */

const IXQ_GLUE = `
function __fmd_ixq_resolve(id)
  -- Get-or-create the Lua facade TABLE for a (possibly JS-registered)
  -- facade id, then install the IXQValue method slots. Pure Lua: callable
  -- from inside any C-callback without re-entering the bridge.
  -- rawset is REQUIRED: the facade metatable has __newindex (facade set) —
  -- a plain assignment would round-trip the Lua closures through the JS
  -- bridge and hand back userdata-wrapped functions.
  local t = __fmd_facades[id]
  if t ~= nil and rawget(t, 'Get') ~= nil then return t end
  t = __fmd_facade_new(id, '')
  rawset(t, 'Get', __fmd_ixq_make_iter(id))
  rawset(t, 'GetProperty', function(a, b)
    -- colon syntax puts self in slot 1 (LuaIXQValue.pas:124-131)
    local ret = __fmd_js_ixq_getproperty(id, b ~= nil and b or a)
    if ret == nil then return nil end
    return __fmd_ixq_resolve(ret)
  end)
  return t
end
function __fmd_ixq_make_iter(id)
  -- Dot syntax (FMD2 modules: x.Get(), x.Get(2)) puts the argument in
  -- slot 1; colon syntax (x:Get(2)) puts self in slot 1, the argument in
  -- slot 2 (LuaIXQValue.pas:124-131 ixqvalue_get: 0 args => iterator,
  -- integer arg => 1-based item).
  return function(a, b)
    local idx = tonumber(b) or tonumber(a)
    if idx ~= nil then
      local child = __fmd_ixq_item(id, idx)
      if child == nil then return nil end
      return __fmd_ixq_resolve(child)
    end
    local c = 0
    local n = __fmd_ixq_count(id)
    return function()
      c = c + 1
      if c > n then return nil end
      local child = __fmd_ixq_item(id, c)
      if child == nil then return nil end
      return __fmd_ixq_resolve(child)
    end
  end
end
function __fmd_fill_list(list_id, get_item, count)
  local L = __fmd_facades[list_id]
  if L == nil then return end
  for i = 1, count do
    L.Add(get_item(i))
  end
end
`;

interface IxqState {
  readonly items: readonly unknown[];
}

/** Live document holder — ParseHTML swaps the current document. */
interface DocHolder {
  current: DuckDocument;
}

/** The wasmoon engine surface the facade kit needs. */
export interface TxQueryEngineLike {
  global: { set(name: string, value: unknown): void };
  doStringSync(code: string): unknown;
}

export interface TxQueryShimOptions {
  readonly bridge: LuaFacadeBridge;
  readonly engine: TxQueryEngineLike;
  readonly logger: HostLogger | null;
  readonly moduleId: ModuleId;
  /** HTTP Document facade ids → backing stream (ParseHTML argument). */
  readonly documents?: ReadonlyMap<number, HttpDocument>;
  /**
   * §5.6 run-level expression-failure dedup (observability): when
   * present, the max-1-WARN-per-(module, expression-template) bound is
   * enforced across ALL engine instances for the process run, not just
   * this shim instance.
   */
  readonly swallowDeduper?: SwallowSharedDeduper;
}

export class TxQueryShim {
  private readonly ixqStates = new Map<number, IxqState>();
  private readonly txqHolders = new Map<number, DocHolder>();
  /** Lua closures assigned into facades for table-returning methods. */
  private readonly luaSlots = new Map<number, Map<string, (...args: unknown[]) => unknown>>();
  private readonly swallower: SwallowLogger;
  private glueInstalled = false;

  constructor(private readonly options: TxQueryShimOptions) {
    ensureLinkedomLowercase();
    registerFmdFunctions();
    this.swallower = new SwallowLogger(options.logger, options.swallowDeduper);
  }

  private installGlue(): void {
    if (this.glueInstalled) {
      return;
    }
    this.glueInstalled = true;
    const engine = this.options.engine;
    engine.doStringSync(IXQ_GLUE);
    engine.global.set('__fmd_ixq_count', (id: number) => this.ixqStates.get(id)?.items.length ?? 0);
    engine.global.set('__fmd_ixq_item', (id: number, index: number) => this.ixqItemId(id, index));
    engine.global.set('__fmd_js_txq_xpath', (id: number, expr: unknown, node: unknown) => {
      try {
        return this.txqXPath(id, toStr(expr), node);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.swallower.warnOnce(this.options.moduleId, 'txq_xpath', `JS bridge: ${message}`);
        return undefined;
      }
    });
    engine.global.set('__fmd_js_ixq_getproperty', (id: number, prop: unknown) => {
      try {
        return this.ixqGetProperty(id, toStr(prop));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.swallower.warnOnce(this.options.moduleId, 'ixq_getproperty', `JS bridge: ${message}`);
        return undefined;
      }
    });
  }

  /** The Lua closure stored on a facade for a table-returning method. */
  private luaSlot(id: number, name: string): ((...args: unknown[]) => unknown) | undefined {
    return this.luaSlots.get(id)?.get(name);
  }

  // --- IXQValue facades ----------------------------------------------------

  /** Counter for JS-registered facade ids (negative — never collides). */
  private jsFacadeIds = 0;

  /**
   * Register an IXQValue facade PURELY JS-side: spec + state under a
   * negative id, NO Lua-side table yet. The Lua glue materializes the table
   * with `__fmd_ixq_resolve(id)` — so this is safe to call from inside a
   * C-callback (no re-entrant `doStringSync`, which crashes wasmoon).
   */
  private registerIxq(items: readonly unknown[]): number {
    this.installGlue();
    const bridge = this.options.bridge;
    const id = -(++this.jsFacadeIds);
    this.ixqStates.set(id, { items });
    bridge.register(id, {
      get: (k) => {
        const state = this.ixqStates.get(id);
        if (state === undefined) {
          return undefined;
        }
        if (k === 'Count') {
          return state.items.length;
        }
        if (typeof k !== 'string') {
          return undefined;
        }
        const slot = this.luaSlot(id, k);
        if (slot !== undefined) {
          return slot as FacadeGetResult;
        }
        return (this.ixqMethod(state, k) ?? undefined) as FacadeGetResult;
      },
      set: (k, v) => {
        if (typeof k === 'string' && typeof v === 'function') {
          let slots = this.luaSlots.get(id);
          if (slots === undefined) {
            slots = new Map();
            this.luaSlots.set(id, slots);
          }
          slots.set(k, v);
        }
        // unknown keys: silent no-op
      },
    });
    return id;
  }

  /** Create an IXQValue facade over `items`; returns the FACADE ID. */
  createIxq(items: readonly unknown[]): number {
    const id = this.registerIxq(items);
    // Materialize the Lua table + method slots (safe here: this overload
    // runs top-level, not inside a C-callback).
    this.options.engine.doStringSync(`__fmd_ixq_resolve(${id})`);
    return id;
  }

  /** Item facade id for 1-based `Get(i)`; undefined past the end. */
  private ixqItemId(id: number, index: number): number | undefined {
    const state = this.ixqStates.get(id);
    if (state === undefined) {
      return undefined;
    }
    const item = state.items[index - 1];
    return item === undefined ? undefined : this.registerIxq([item]);
  }

  private firstNode(state: IxqState): DuckNode | undefined {
    const first = state.items[0];
    return first !== null && typeof first === 'object' ? (first as DuckNode) : undefined;
  }

  /** GetProperty → child-element IXQValue facade id (empty when missing). */
  private ixqGetProperty(id: number, prop: string): number | undefined {
    const state = this.ixqStates.get(id);
    if (state === undefined) {
      return undefined;
    }
    const node = this.firstNode(state);
    const wanted = prop.toLowerCase();
    if (node !== undefined) {
      const children = (node as unknown as { children?: Iterable<DuckNode> }).children ?? [];
      for (const child of children) {
        const childName =
          (child as { localName?: string }).localName ?? (child as { nodeName?: string }).nodeName ?? '';
        if (childName.toLowerCase() === wanted) {
          return this.registerIxq([child]);
        }
      }
    }
    return this.registerIxq([]); // empty IXQValue — never nil (FMD2 semantics)
  }

  private ixqMethod(state: IxqState, name: string): ((...args: unknown[]) => unknown) | undefined {
    switch (name) {
      case 'GetAttribute':
        return (attr: unknown) => {
          const node = this.firstNode(state);
          if (node === undefined) {
            return '';
          }
          const get = (node as { getAttribute?: (n: string) => string | null }).getAttribute;
          return get === undefined ? '' : (get.call(node, toStr(attr)) ?? '');
        };
      case 'InnerText':
        // InternetTools innerText algorithm (HTML5 innertext over the
        // parsed tree) — NOT the raw string value
        return () => {
          const first = state.items[0];
          return first === undefined ? '' : innerTextOf(first);
        };
      case 'ToString':
        // FMD2 toString: node stringification is trimmed (XQGlobalTrimNodes)
        return () => {
          const first = state.items[0];
          return first === undefined ? '' : itemToString(first);
        };
      case 'InnerHTML':
        return () => {
          const node = this.firstNode(state);
          return node === undefined ? '' : String((node as unknown as { innerHTML?: string }).innerHTML ?? '');
        };
      case 'OuterHTML':
        return () => {
          const node = this.firstNode(state);
          return node === undefined ? '' : String((node as unknown as { outerHTML?: string }).outerHTML ?? '');
        };
      default:
        return undefined;
    }
  }

  // --- evaluation ----------------------------------------------------------

  /** Evaluate one expression, swallowing errors → [] (FMD2 Eval). */
  private evaluateItems(expression: string, context: unknown, doc: DuckDocument): readonly unknown[] {
    const transformed = transformExpression(expression);
    const options = {
      namespaceResolver: fmdNamespaceResolver,
      currentContext: { currentContext: doc },
    };
    try {
      // Node context: bind it as a variable and map the expression over it
      // (`($fmdctx) ! ( expr )` = exact context-item semantics). Passing
      // the node DIRECTLY as the context item breaks when the node was
      // produced by a step over a custom-function result (fontoxpath
      // re-invokes the function with shifted arguments during adaptation).
      const useVariableContext = context !== undefined && context !== null && typeof context === 'object';
      const evaluated = evaluateXPath(
        useVariableContext ? `($fmdctx) ! ( ${transformed} )` : transformed,
        useVariableContext ? doc : context ?? doc,
        null,
        useVariableContext ? { fmdctx: context } : {},
        evaluateXPath.ALL_RESULTS_TYPE,
        options,
      );
      const result = evaluated;
      return Array.isArray(result) ? result : result === undefined || result === null ? [] : [result];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.swallower.warnOnce(this.options.moduleId, expression, message);
      return [];
    }
  }

  private evalScalar(expression: string, context: unknown, doc: DuckDocument): string {
    // FMD2 XPathString = Eval(...).toString: sequence → toJoinedString(''),
    // node items trimmed (XQGlobalTrimNodes)
    const items = this.evaluateItems(expression, context, doc);
    return items.length === 0 ? '' : items.map(itemToString).join('');
  }

  /** Resolve an IXQValue facade argument via the `__fmd_id` marker. */
  private resolveIxqArg(arg: unknown): IxqState | undefined {
    if (arg === null || arg === undefined || typeof arg !== 'object') {
      return undefined;
    }
    const marker = (arg as Record<string, unknown>)['__fmd_id'];
    return typeof marker === 'number' ? this.ixqStates.get(marker) : undefined;
  }

  private facadeId(arg: unknown): number | undefined {
    if (arg === null || arg === undefined || typeof arg !== 'object') {
      return undefined;
    }
    const marker = (arg as Record<string, unknown>)['__fmd_id'];
    return typeof marker === 'number' ? marker : undefined;
  }

  /** Fill a TStrings facade (any spec with Lua-side Add) from items. */
  private fillList(listFacade: unknown, items: readonly string[]): void {
    const listId = this.facadeId(listFacade);
    if (listId === undefined) {
      return;
    }
    const getItem = (i: number): string => items[i - 1] ?? '';
    this.options.engine.global.set('__fmd_fill_items', getItem);
    this.options.engine.doStringSync(`__fmd_fill_list(${listId}, __fmd_fill_items, ${items.length})`);
  }

  private fillPair(
    items: readonly unknown[],
    firstList: unknown,
    firstOf: (item: unknown) => string,
    secondList: unknown,
    secondOf: (item: unknown) => string,
  ): void {
    this.fillList(firstList, items.map(firstOf));
    this.fillList(secondList, items.map(secondOf));
  }

  // --- TXQuery facade ------------------------------------------------------

  /** JS callback: `XPath` → IXQValue facade id (nil on empty results). */
  private txqXPath(id: number, expr: string, node: unknown): number | undefined {
    const holder = this.txqHolders.get(id);
    if (holder === undefined) {
      return undefined;
    }
    const state = this.resolveIxqArg(node);
    const items = this.evaluateItems(expr, state?.items[0], holder.current);
    // Pure-JS registration: the Lua unwrapper resolves the table via
    // __fmd_ixq_resolve (no re-entrant doStringSync from a C-callback).
    return this.registerIxq(items);
  }

  /** Create the TXQuery facade over a document; returns the FACADE ID. */
  createTxQuery(doc: DuckDocument): number {
    this.installGlue();
    const bridge = this.options.bridge;
    const dummy: FacadeSpec = { get: () => undefined, set: () => undefined };
    const id = bridge.create('', dummy);
    const holder: DocHolder = { current: doc };
    this.txqHolders.set(id, holder);
    const spec = this.makeTxQuerySpec(id, holder);
    bridge.register(id, spec);
    // `XPath` returns an IXQValue facade — wire the Lua-side unwrapper
    // (resolves JS-registered ids via the pure-Lua __fmd_ixq_resolve).
    this.options.engine.doStringSync(`
      rawset(__fmd_facades[${id}], 'XPath', function(expr, node)
        local ret = __fmd_js_txq_xpath(${id}, expr, node)
        if ret == nil then return nil end
        return __fmd_ixq_resolve(ret)
      end)
    `);
    return id;
  }

  /** The TXQuery facade spec (§5.6 method surface) for facade `id`. */
  makeTxQuerySpec(id: number, holder: DocHolder): FacadeSpec {
    const methods: Record<string, (...args: unknown[]) => unknown> = {
      // instance method, exactly one argument (string or stream)
      ParseHTML: (html: unknown) => {
        const source = typeof html === 'string' ? html : this.documentText(html);
        holder.current = parseQueryDocument('html', source);
        return undefined;
      },
      XPathString: (expr: unknown, node?: unknown) => {
        const state = this.resolveIxqArg(node);
        return this.evalScalar(toStr(expr), state?.items[0], holder.current);
      },
      XPathStringAll: (expr: unknown, a?: unknown, b?: unknown) => {
        // dispatch by argument type (LuaXQuery.pas:91-148):
        // (expr) → ', '-joined string · (expr, node) → joined ·
        // (expr, list) → fill · (expr, node, list) → fill
        const contextState = this.resolveIxqArg(a);
        const listArg = contextState === undefined && typeof a === 'object' && a !== null ? a : typeof b === 'object' && b !== null ? b : undefined;
        const items = this.evaluateItems(toStr(expr), contextState?.items[0], holder.current);
        if (listArg !== undefined) {
          // EvalStringAll(TheStrings): Add(Trim(v.toString)) per item —
          // empty-string entries ARE added (XQueryEngineHTML.pas:375-381)
          this.fillList(listArg, items.map((item) => pascalTrim(itemToString(item))));
          return undefined;
        }
        // string form: AddSeparatorString ', '-join of trimmed non-empty
        // values (XQueryEngineHTML.pas:130-137)
        return joinSeparatorString(items.map((item) => pascalTrim(itemToString(item))).filter((s) => s !== ''));
      },
      XPathHREFAll: (expr: unknown, links: unknown, names: unknown, node?: unknown) => {
        const state = this.resolveIxqArg(node);
        const items = this.evaluateItems(toStr(expr), state?.items[0], holder.current);
        this.fillPair(items, links, hrefOf, names, (item) => pascalTrim(itemToString(item)));
        return undefined;
      },
      XPathHREFTitleAll: (expr: unknown, links: unknown, titles: unknown, node?: unknown) => {
        const state = this.resolveIxqArg(node);
        const items = this.evaluateItems(toStr(expr), state?.items[0], holder.current);
        this.fillPair(items, links, hrefOf, titles, (item) => attrOf(item, 'title'));
        return undefined;
      },
      XPathCount: (expr: unknown, node?: unknown) => {
        const state = this.resolveIxqArg(node);
        // FMD2: EvalCount = Eval(...).Count — the result-sequence length
        return this.evaluateItems(toStr(expr), state?.items[0], holder.current).length;
      },
    };
    return {
      get: (k) => {
        if (typeof k !== 'string') {
          return undefined;
        }
        if (k === 'XPath') {
          return (this.luaSlot(id, 'XPath') ?? undefined) as FacadeGetResult;
        }
        const method = methods[k];
        return method !== undefined ? (method as FacadeGetResult) : undefined;
      },
      set: (k, v) => {
        // the wired `XPath` closure lands here (createTxQuery assigns it
        // Lua-side after the facade id is known)
        if (k === 'XPath' && typeof v === 'function') {
          let slots = this.luaSlots.get(id);
          if (slots === undefined) {
            slots = new Map();
            this.luaSlots.set(id, slots);
          }
          slots.set('XPath', v);
        }
      },
    };
  }

  /** HTTP Document facade → its backing stream text (ParseHTML arg). */
  private documentText(arg: unknown): string {
    const id = this.facadeId(arg);
    if (id !== undefined) {
      const state = this.options.documents?.get(id);
      if (state !== undefined) {
        return state.toString();
      }
    }
    return '';
  }
}

function hrefOf(item: unknown): string {
  if (item !== null && typeof item === 'object') {
    const node = item as DuckNode;
    if (node.nodeType === 2) {
      return node.nodeValue ?? '';
    }
    const get = (node as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (get !== undefined) {
      return get.call(node, 'href') ?? '';
    }
  }
  return '';
}

function attrOf(item: unknown, name: string): string {
  if (item !== null && typeof item === 'object') {
    const node = item as DuckNode;
    const get = (node as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (get !== undefined) {
      return get.call(node, name) ?? '';
    }
  }
  return '';
}
