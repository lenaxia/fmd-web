import type { LuaEngine as WasmoonEngine } from 'wasmoon';

/**
 * LuaClass-style facade bridge (§5.1, LuaClass.pas:94-169): one shared
 * metatable per Lua state whose `__index`/`__newindex`/`__len` delegate to
 * JS closures keyed by a numeric facade id. Facade instances are plain
 * Lua tables, so property access follows FMD2's LuaClass semantics
 * exactly — keys are case-sensitive, unknown keys silently no-op on get
 * (nil) and set (dropped), and `obj['key']` bracket access flows through
 * the same traps.
 *
 * Sub-objects (e.g. `list.Values`, `MODULE.Storage`, `HTTP.Headers`) are
 * themselves facades: the parent's `sub()` returns the child facade id
 * (a plain number across the boundary) and the Lua glue hands out the
 * matching `__fmd_facades[id]` table.
 */

export type FacadeKey = string | number;
export type FacadeValue = string | number | boolean | null | undefined;
/** get() returns plain values OR methods (JS functions become Lua functions). */
export type FacadeGetResult = FacadeValue | ((...args: never[]) => unknown);

/** Per-id get/set/len behavior supplied by the facade owner. */
export interface FacadeSpec {
  get(key: FacadeKey): FacadeGetResult;
  set(key: FacadeKey, value: FacadeValue): void;
  len?(): number;
  /** Child facade id for a sub-object property, if this key is one. */
  sub?(key: FacadeKey): number | undefined;
}

const FACADE_GLUE = `
__fmd_facades = {}
function __fmd_facade_new(id, target)
  local mt = {
    __index = function(_, k)
      local child = __fmd_facade_sub(id, k)
      if child ~= nil then return __fmd_facades[child] end
      return __fmd_facade_get(id, k)
    end,
    __newindex = function(_, k, v) __fmd_facade_set(id, k, v) end,
    __len = function(_) return __fmd_facade_len(id) end,
  }
  local t = setmetatable({}, mt)
  __fmd_facades[id] = t
  if target ~= nil and target ~= '' then _G[target] = t end
  return t
end
`;

export class FacadeBridge {
  private readonly specs = new Map<number, FacadeSpec>();
  private nextId = 1;

  constructor(private readonly engine: WasmoonEngine) {
    engine.global.set('__fmd_facade_get', (id: number, key: FacadeKey) => {
      const spec = this.specs.get(id);
      return spec === undefined ? undefined : nullToUndefined(spec.get(key));
    });
    engine.global.set('__fmd_facade_set', (id: number, key: FacadeKey, value: FacadeValue) => {
      this.specs.get(id)?.set(key, value);
    });
    engine.global.set('__fmd_facade_len', (id: number) => {
      const spec = this.specs.get(id);
      return spec?.len === undefined ? 0 : spec.len();
    });
    engine.global.set('__fmd_facade_sub', (id: number, key: FacadeKey) => {
      const spec = this.specs.get(id);
      if (spec?.sub === undefined) {
        return undefined;
      }
      const child = spec.sub(key);
      return child === undefined ? undefined : child;
    });
    engine.doStringSync(FACADE_GLUE);
  }

  /**
   * Create a facade table and assign it to a Lua global (`target`, empty
   * string = keep unassigned). Returns the facade id.
   */
  create(target: string, spec: FacadeSpec): number {
    const id = this.nextId;
    this.nextId += 1;
    this.specs.set(id, spec);
    this.engine.doStringSync(`__fmd_facade_new(${id}, '${escapeLuaString(target)}')`);
    return id;
  }

  /**
   * Register a spec under an id whose Lua table is created Lua-side (e.g.
   * `NewWebsiteModule()` returns `__fmd_facade_new(id, '')` from glue).
   */
  register(id: number, spec: FacadeSpec): void {
    this.specs.set(id, spec);
    if (id >= this.nextId) {
      this.nextId = id + 1;
    }
  }

  dispose(): void {
    this.specs.clear();
  }
}

/** wasmoon crashes pushing `null` through its type extensions — use undefined. */
function nullToUndefined(value: FacadeGetResult): FacadeGetResult {
  return value === null ? undefined : value;
}

export function escapeLuaString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
}