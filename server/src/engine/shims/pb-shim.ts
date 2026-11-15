import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import protobuf from 'protobufjs';
import { LuaMultiReturn, type LuaEngine as WasmoonEngine } from 'wasmoon';

/**
 * pb shim v1 (DESIGN.md §5.7, D17): the native `pb` (lua-protobuf) C
 * module replaced by a byte-exact Lua bridge over a protobufjs core.
 * Covers MangaPlus (`MangaPlus.lua:54` hard `require 'pb'`,
 * `pb.decode` at :123/:143/:191, `protoc:load` at :110) and
 * `utils/protoc.lua`'s whole `has_pb` branch (`Parser:compile` encodes
 * a `.google.protobuf.FileDescriptorSet` table via `pb.encode`,
 * `Parser:load` binds `local ret, pos = pb.load(bytes)` —
 * protoc.lua:1176,1183).
 *
 * ── `pb.load` contract (ground truth) ─────────────────────────────
 * lua-protobuf's README ("`pb` Module" function table) documents
 * `pb.load(data)` as returning `boolean,integer`: "pb.load() accepts
 * the schema binary data and returns a boolean indicates the result of
 * loading, success or failure, and a offset reading in schema so far
 * that is useful to figure out the reason of failure." The
 * implementation (pb.c, `Lpb_load`) always returns exactly TWO values:
 *
 *   return lua_pushboolean(L, r == PB_OK), lua_pushinteger(L, pb_pos(s) + 1), 2;
 *
 * i.e. `(true, offsetReadSoFar+1)` on success, `(false, failingOffset+1)`
 * on failure (1-based offsets; never nil). The bundled consumer binds
 * and uses both returns — FMD2/lua/utils/protoc.lua:
 *
 *   :1176  local ret, pos = pb.load(self:compile(s, name))
 *   :1177  if ret then return ret, pos end
 *   :1178  error("load failed at offset "..pos)   -- pos must be a number
 *   :1144  assert(pb.load(descriptor_pb), "load descriptor msg failed")
 *
 * This shim therefore returns two Lua values per call, with `pos`
 * computed from the protobufjs Reader cursor (`reader.pos + 1`) so the
 * failure offset points into the descriptor bytes protoc.lua compiled.
 *
 * ── input: serialized descriptors only ────────────────────────────
 * Like native pb.load, `load` accepts ONLY a serialized
 * google.protobuf.FileDescriptorSet (the raw `.proto` text path v0
 * offered does not exist in lua-protobuf — protoc.lua is the
 * text→descriptor compiler — so it was removed, not approximated).
 * google.protobuf.* descriptor types are registered eagerly
 * (makePbShim) mirroring protoc.lua's `Parser.reload()`
 * (protoc.lua:1143-1145, called unconditionally at :1188): that is
 * what makes `pb.encode('.google.protobuf.FileDescriptorSet', set)`
 * work before any user load.
 *
 * ── Lua bridge (byte-exact) ───────────────────────────────────────
 * wasmoon marshals Lua strings to JS as UTF-8 (replacement on invalid
 * bytes) and truncates at NUL, and pushes JS strings UTF-8-encoded —
 * lossy for descriptor wire bytes in BOTH directions (COMPAT.md "byte
 * strings"; the same wall the fmd.crypto bridge solved). The Lua-side
 * glue (`PB_LUA_GLUE`, installPbShim) therefore base64-envelopes every
 * binary slot: `load(data)`/`decode(schema, data)` args are b64-encoded
 * Lua-side, `encode` results are b64-decoded Lua-side; `pb.load`
 * forward propagates the two-value return (`local ret, pos =
 * __fmd_pb_call('load', ...)` → `return ret, pos`). JS callers
 * (tests, corpus tooling) use the latin1-string/Buffer core directly.
 */

/**
 * Build the two-value `pb.load` return. wasmoon's `LuaMultiReturn`
 * d.ts only inherits Array's `(arrayLength?)` constructor overload,
 * while the runtime constructor is plain Array-variadic and the
 * function decorator expands the instance into exactly N Lua values
 * (`for (const item of result) pushValue(item); return result.length`)
 * — `Reflect.construct` is the type-honest spelling of `new LuaMultiReturn(ret, pos)`.
 */
function luaLoadReturn(ret: boolean, pos: number): LuaMultiReturn {
  return Reflect.construct(LuaMultiReturn, [ret, pos]) as LuaMultiReturn;
}

/** google.protobuf.FieldDescriptorProto.Type enum values. */
const FIELD_TYPES: Readonly<Record<number, string>> = {
  1: 'double',
  2: 'float',
  3: 'int64',
  4: 'uint64',
  5: 'int32',
  6: 'fixed64',
  7: 'fixed32',
  8: 'bool',
  9: 'string',
  10: 'group',
  11: 'message',
  12: 'bytes',
  13: 'uint32',
  14: 'enum',
  15: 'sfixed32',
  16: 'sfixed64',
  17: 'sint32',
  18: 'sint64',
};

/** google.protobuf.FieldDescriptorProto.Label enum values. */
const FIELD_RULES: Readonly<Record<number, 'optional' | 'required' | 'repeated'>> = {
  1: 'optional',
  2: 'required',
  3: 'repeated',
};

/**
 * The JS-facing pb core surface. Binary slots are latin1 strings or
 * Buffers (JS callers); the Lua bridge wraps these methods with the
 * base64 envelope (see {@link pbBridgeCall}).
 */
export interface PbTable {
  decode(schema: string, data: unknown): Record<string, unknown> | undefined;
  encode(schema: string, table: unknown): string | undefined;
  /**
   * lua-protobuf `pb.load` (README pb-module table; pb.c `Lpb_load`):
   * ALWAYS two values — `(true, offsetReadSoFar+1)` on success,
   * `(false, failingOffset+1)` on failure (1-based byte offsets, never
   * nil). protoc.lua:1176-1179 binds both and concatenates `pos` into
   * its failure error, so the second value must be a number.
   */
  load(data: unknown): LuaMultiReturn;
  setdefault(...args: unknown[]): undefined;
  option(...args: unknown[]): undefined;
}

/**
 * The bundled google/protobuf/descriptor.proto source (protobufjs ships
 * it next to its dist), or undefined when unavailable.
 */
let descriptorProtoSource: string | undefined;
function getDescriptorProtoSource(): string | undefined {
  if (descriptorProtoSource !== undefined) {
    return descriptorProtoSource;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('protobufjs/package.json');
    descriptorProtoSource = readFileSync(join(pkgPath, '..', 'google', 'protobuf', 'descriptor.proto'), 'utf8');
  } catch {
    descriptorProtoSource = undefined;
  }
  return descriptorProtoSource;
}

/** Minimal decoded FileDescriptorProto shapes we walk. */
interface DecodedEnum {
  readonly name?: string;
  readonly value?: ReadonlyArray<{ readonly name?: string; readonly number?: number }>;
}
interface DecodedMessage {
  readonly name?: string;
  readonly field?: ReadonlyArray<{ readonly name?: string; readonly number?: number; readonly label?: number; readonly type?: number; readonly type_name?: string }>;
  readonly nested_type?: ReadonlyArray<DecodedMessage>;
  readonly enum_type?: ReadonlyArray<DecodedEnum>;
}
interface DecodedFile {
  readonly name?: string;
  readonly package?: string;
  readonly message_type?: ReadonlyArray<DecodedMessage>;
  readonly enum_type?: ReadonlyArray<DecodedEnum>;
}

/**
 * lua-protobuf's pb.load overwrites same-named types on re-load (the
 * bundled protoc.lua relies on that: Parser.reload() re-loads the
 * descriptor protos at require time, protoc.lua:1188, and modules then
 * load their own schemas on top). Mirror that: replace-and-add.
 */
function addTolerant(ns: protobuf.Namespace, added: protobuf.ReflectionObject): void {
  const existing = ns.nested?.[added.name];
  if (existing !== undefined && existing !== added) {
    try {
      ns.remove(existing);
    } catch {
      // unremovable (locked) — fall through to add
    }
  }
  try {
    ns.add(added);
  } catch {
    // already registered by an earlier load and replace failed
  }
}

function addEnum(ns: protobuf.Namespace, e: DecodedEnum): void {
  if (e.name === undefined) {
    return;
  }
  const values: Record<string, number> = {};
  for (const v of e.value ?? []) {
    if (v.name !== undefined && v.number !== undefined) {
      values[v.name] = v.number;
    }
  }
  addTolerant(ns, new protobuf.Enum(e.name, values));
}

/** Walk decoded descriptor messages into the protobufjs root. */
function walkDescriptorMessages(ns: protobuf.Namespace, messages: ReadonlyArray<DecodedMessage>): void {
  for (const message of messages) {
    const name = message.name ?? '';
    if (name === '') {
      continue;
    }
    const type = new protobuf.Type(name);
    for (const f of message.field ?? []) {
      if (f.name === undefined || f.number === undefined) {
        continue;
      }
      const wireType = FIELD_TYPES[f.type ?? 0];
      if (wireType === undefined) {
        continue;
      }
      const rule = FIELD_RULES[f.label ?? 1];
      // message/enum fields reference type_name ("./pkg.Msg") — pass the
      // raw name; root.resolveAll() links them after the walk.
      const fieldType = f.type_name !== undefined && f.type_name !== '' ? f.type_name.replace(/^\./, '') : wireType;
      type.add(new protobuf.Field(f.name, f.number, fieldType, rule));
    }
    for (const enumDesc of message.enum_type ?? []) {
      addEnum(type, enumDesc);
    }
    addTolerant(ns, type);
    walkDescriptorMessages(type, message.nested_type ?? []);
  }
}

function addFileDescriptor(root: protobuf.Root, file: DecodedFile): void {
  const pkg = file.package ?? '';
  const ns = pkg === '' ? root : (root.define(pkg) as protobuf.Namespace);
  for (const enumDesc of file.enum_type ?? []) {
    addEnum(ns, enumDesc);
  }
  walkDescriptorMessages(ns, file.message_type ?? []);
}

/**
 * latin1-string/Buffer coercion for JS callers (the Lua bridge has
 * already base64-decoded its slots before reaching these methods).
 */
function toWireBytes(data: unknown): Buffer {
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'latin1');
  }
  return Buffer.from(String(data ?? ''), 'latin1');
}

/**
 * Absent message fields decode as `null` in protobufjs toObject, but
 * native lua-protobuf yields nil for them — and wasmoon's pushValue
 * crashes on JS null crossing into Lua. Strip null-valued keys (and
 * null array elements) so the decoded table mirrors the Lua contract.
 */
function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) {
      continue;
    }
    if (Buffer.isBuffer(v) || typeof v !== 'object') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((e) => (e !== null && e !== undefined && !Buffer.isBuffer(e) && typeof e === 'object' ? stripNulls(e as Record<string, unknown>) : e));
    } else {
      out[k] = stripNulls(v as Record<string, unknown>);
    }
  }
  return out;
}

export function makePbShim(): PbTable {
  const root = new protobuf.Root();

  // Parser.reload() parity (protoc.lua:1143-1145, invoked at :1188):
  // register the google.protobuf.* descriptor types eagerly so
  // `pb.encode('.google.protobuf.FileDescriptorSet', set)` works before
  // any user load — protoc.lua's Parser:compile depends on it
  // (protoc.lua:1165,1171). Best-effort: without descriptor.proto the
  // descriptor-set path is unavailable (load reports failure).
  const descriptorSource = getDescriptorProtoSource();
  if (descriptorSource !== undefined) {
    try {
      // keepCase: lua-protobuf preserves the .proto field names
      const parsed = protobuf.parse(descriptorSource, { keepCase: true });
      parsed.root.resolveAll();
      for (const nested of parsed.root.nestedArray ?? []) {
        try {
          root.add(nested); // duplicate registration tolerated (re-load)
        } catch {
          // already registered by an earlier load
        }
      }
      root.resolveAll();
    } catch {
      // descriptor.proto unparseable → load/encode of descriptor sets
      // reports failure below; MangaPlus direct decode unaffected.
    }
  }

  const table: PbTable = {
    decode(schema: string, data: unknown): Record<string, unknown> | undefined {
      try {
        const bytes = toWireBytes(data);
        const type = root.lookupType(schema);
        const message = type.decode(bytes);
        const obj = stripNulls(type.toObject(message, {
          defaults: true,
          longs: Number,
          // lua-protobuf's default `enum_as_name` option: decoded enums
          // are the VALUE NAME string (MangaPlus.lua:129 GetLang keys
          // off names like 'RUSSIAN'; numbers would break parity).
          enums: String,
          bytes: Buffer,
          oneofs: true,
        }) as Record<string, unknown>);
        // bytes → Lua byte-string via latin1 (top-level fields; the
        // corpus schemas carry no bytes fields — MangaPlus.proto is
        // all `string`).
        for (const [k, v] of Object.entries(obj)) {
          if (Buffer.isBuffer(v)) {
            obj[k] = v.toString('latin1');
          }
        }
        return obj;
      } catch {
        return undefined;
      }
    },
    encode(schema: string, value: unknown): string | undefined {
      try {
        const type = root.lookupType(schema);
        const message = type.fromObject(value ?? {});
        return Buffer.from(type.encode(message).finish()).toString('latin1');
      } catch {
        return undefined;
      }
    },
    load(data: unknown): LuaMultiReturn {
      // lua-protobuf pb.load contract — see the module doc block:
      // README pb-module table (`boolean,integer` + "Schema loading"
      // paragraph) and pb.c Lpb_load (two pushes, `pb_pos(s) + 1`).
      // protoc.lua:1176-1179 binds both and does
      // `error("load failed at offset "..pos)` on failure.
      const bytes = toWireBytes(data);
      if (bytes.length === 0) {
        // native pb.load('') → (false, 1): nothing consumed.
        return luaLoadReturn(false, 1);
      }
      if (descriptorSource === undefined) {
        return luaLoadReturn(false, 1);
      }
      const setType = root.lookupType('google.protobuf.FileDescriptorSet');
      const reader = protobuf.Reader.create(bytes);
      let decoded: protobuf.Message;
      try {
        decoded = setType.decode(reader);
      } catch {
        // failure at the reader cursor: 1-based offset into the bytes
        return luaLoadReturn(false, reader.pos + 1);
      }
      // native pb_load keeps decoding until the slice is exhausted —
      // trailing bytes after the last file entry are a parse error
      // there, mirror that.
      if (reader.pos !== bytes.length) {
        return luaLoadReturn(false, reader.pos + 1);
      }
      try {
        const obj = setType.toObject(decoded, { defaults: false }) as { file?: ReadonlyArray<DecodedFile> };
        for (const file of obj.file ?? []) {
          addFileDescriptor(root, file);
        }
        root.resolveAll();
        // fully consumed: offset read so far, 1-based (pb_pos+1)
        return luaLoadReturn(true, bytes.length + 1);
      } catch {
        return luaLoadReturn(false, reader.pos + 1);
      }
    },
    setdefault: () => undefined,
    option: () => undefined,
  };
  return table;
}

// ─── Lua bridge (byte-exact base64 envelope) ─────────────────────────────

/** The Lua-facing dispatch methods (the preload lib's entries). */
export type PbBridgeMethod = 'load' | 'decode' | 'encode' | 'setdefault' | 'option';

/**
 * The Lua-side protocol dispatcher: binary slots arrive base64-encoded
 * from `PB_LUA_GLUE` (wasmoon UTF-8/NUL marshaling is lossy for wire
 * bytes — module doc). `load`'s LuaMultiReturn crosses back as two Lua
 * values (the wasmoon function decorator expands it), which is exactly
 * the lua-protobuf contract protoc.lua:1176,1183 bind.
 */
export function pbBridgeCall(pb: PbTable, method: unknown, args: readonly unknown[]): unknown {
  switch (String(method)) {
    case 'load': {
      const b64 = typeof args[0] === 'string' ? args[0] : '';
      return pb.load(Buffer.from(b64, 'base64').toString('latin1'));
    }
    case 'decode': {
      const schema = String(args[0] ?? '');
      const b64 = typeof args[1] === 'string' ? args[1] : '';
      return pb.decode(schema, Buffer.from(b64, 'base64').toString('latin1'));
    }
    case 'encode': {
      const encoded = pb.encode(String(args[0] ?? ''), args[1]);
      return typeof encoded === 'string' ? Buffer.from(encoded, 'latin1').toString('base64') : undefined;
    }
    case 'setdefault':
    case 'option':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Lua side of the bridge: a self-contained pure-Lua base64 codec (byte
 * exact across wasmoon, order-independent of the fmd.crypto glue) and
 * the `pb` preload builder wrapping every entry with encode/decode.
 * `lib.load` forward-propagates BOTH return values (`local ret, pos =
 * __fmd_pb_call('load', ...)` → `return ret, pos`) — the contract
 * protoc.lua:1176,1183 and protoc.lua:1144 (`Parser.reload`) rely on.
 * Installed verbatim — never interpolated.
 */
export const PB_LUA_GLUE = `
package = package or {}
package.loaded = package.loaded or {}
package.preload = package.preload or {}

local __pb_alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local __pb_lookup = {}
for i = 1, #__pb_alpha do __pb_lookup[__pb_alpha:sub(i, i)] = i - 1 end

function __fmd_pb_b64enc(data)
  local t = {}
  local n = #data
  local i = 1
  while i + 2 <= n do
    local a, b, c = data:byte(i, i + 2)
    local n24 = a * 65536 + b * 256 + c
    local s1 = ((n24 >> 18) & 63) + 1
    local s2 = ((n24 >> 12) & 63) + 1
    local s3 = ((n24 >> 6) & 63) + 1
    local s4 = (n24 & 63) + 1
    t[#t + 1] = __pb_alpha:sub(s1, s1) .. __pb_alpha:sub(s2, s2) .. __pb_alpha:sub(s3, s3) .. __pb_alpha:sub(s4, s4)
    i = i + 3
  end
  local rem = n - i + 1
  if rem == 1 then
    local n24 = data:byte(i) * 65536
    local s1 = ((n24 >> 18) & 63) + 1
    local s2 = ((n24 >> 12) & 63) + 1
    t[#t + 1] = __pb_alpha:sub(s1, s1) .. __pb_alpha:sub(s2, s2) .. '=='
  elseif rem == 2 then
    local a, b = data:byte(i, i + 1)
    local n24 = a * 65536 + b * 256
    local s1 = ((n24 >> 18) & 63) + 1
    local s2 = ((n24 >> 12) & 63) + 1
    local s3 = ((n24 >> 6) & 63) + 1
    t[#t + 1] = __pb_alpha:sub(s1, s1) .. __pb_alpha:sub(s2, s2) .. __pb_alpha:sub(s3, s3) .. '='
  end
  return table.concat(t)
end

function __fmd_pb_b64dec(text)
  text = text:gsub('[^' .. __pb_alpha .. '=]', '')
  text = text:gsub('=', '')
  local t = {}
  local n = #text
  local i = 1
  while i + 3 <= n do
    local l1 = __pb_lookup[text:sub(i, i)] or 0
    local l2 = __pb_lookup[text:sub(i + 1, i + 1)] or 0
    local l3 = __pb_lookup[text:sub(i + 2, i + 2)] or 0
    local l4 = __pb_lookup[text:sub(i + 3, i + 3)] or 0
    local n24 = l1 * 262144 + l2 * 4096 + l3 * 64 + l4
    t[#t + 1] = string.char((n24 >> 16) & 255, (n24 >> 8) & 255, n24 & 255)
    i = i + 4
  end
  local rem = n - i + 1
  if rem == 2 then
    local l1 = __pb_lookup[text:sub(i, i)] or 0
    local l2 = __pb_lookup[text:sub(i + 1, i + 1)] or 0
    t[#t + 1] = string.char(((l1 << 2) | (l2 >> 4)) & 255)
  elseif rem == 3 then
    local l1 = __pb_lookup[text:sub(i, i)] or 0
    local l2 = __pb_lookup[text:sub(i + 1, i + 1)] or 0
    local l3 = __pb_lookup[text:sub(i + 2, i + 2)] or 0
    t[#t + 1] = string.char(((l1 << 2) | (l2 >> 4)) & 255, (((l2 & 15) << 4) | (l3 >> 2)) & 255)
  end
  return table.concat(t)
end

package.preload['pb'] = function()
  local lib = {}
  -- lua-protobuf pb.load(data) -> (boolean, integer): README pb-module
  -- table + pb.c Lpb_load (two values, always). protoc.lua binds both:
  --   local ret, pos = pb.load(self:compile(s, name))   -- :1176
  --   if ret then return ret, pos end
  --   error("load failed at offset "..pos)              -- :1178
  function lib.load(data)
    local ret, pos = __fmd_pb_call('load', __fmd_pb_b64enc(data))
    return ret, pos
  end
  function lib.decode(schema, data)
    return __fmd_pb_call('decode', schema, __fmd_pb_b64enc(data))
  end
  function lib.encode(schema, value)
    local enc = __fmd_pb_call('encode', schema, value)
    if type(enc) == 'string' then return __fmd_pb_b64dec(enc) end
    return enc -- nil on failure (protoc.lua:1165 asserts on the bytes)
  end
  function lib.setdefault() return __fmd_pb_call('setdefault') end
  function lib.option() return __fmd_pb_call('option') end
  return lib
end
`;

/**
 * Install the pb shim onto a wasmoon engine (call after the Lua
 * `package` table exists — the glue only touches package.preload).
 * Replaces the v0 `libs.set('pb', …)` host-lib wiring: `require 'pb'`
 * now resolves through `package.preload['pb']` (MangaPlus.lua:54),
 * byte-exact over the base64 envelope.
 */
export function installPbShim(engine: WasmoonEngine): void {
  const pb = makePbShim();
  engine.global.set('__fmd_pb_call', (method: unknown, ...args: unknown[]) => pbBridgeCall(pb, method, args));
  engine.doStringSync(PB_LUA_GLUE);
}
