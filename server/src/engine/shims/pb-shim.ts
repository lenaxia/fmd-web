import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import protobuf from 'protobufjs';

/**
 * pb shim v0 (DESIGN.md §5.7, D17): the native `pb` (lua-protobuf) C
 * module replaced by a `package.preload['pb']` table backed by
 * protobufjs. Covers MangaPlus (`MangaPlus.lua:54` hard `require 'pb'`,
 * `pb.decode` at :123/:143/:191) and `utils/protoc.lua`'s `has_pb`
 * branch (`Parser:compile` encodes a `.google.protobuf.FileDescriptorSet`
 * table via `pb.encode`, `Parser:load` calls `pb.load(bytes)` binding
 * `(ret, pos)` — protoc.lua:1176,1183). Corpus-verified: no
 * `pb.option`/`pb.setdefault`/`pb.loadfile` usage exists.
 *
 * `pb.load` accepts BOTH raw `.proto` text (direct path) and a
 * serialized FileDescriptorSet binary (the protoc.lua path; lua-protobuf
 * preloads the descriptor, mirrored here from protobufjs' bundled
 * descriptor.proto), walking the descriptor set into the root.
 */

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

export interface PbTable {
  decode(schema: string, data: unknown): Record<string, unknown> | undefined;
  encode(schema: string, table: unknown): string | undefined;
  load(data: unknown): boolean | undefined;
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
  ns.add(new protobuf.Enum(e.name, values));
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
    ns.add(type);
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

export function makePbShim(): PbTable {
  const root = new protobuf.Root();
  const table: PbTable = {
    decode(schema: string, data: unknown): Record<string, unknown> | undefined {
      try {
        const bytes = typeof data === 'string' ? Buffer.from(data, 'binary') : Buffer.from(String(data ?? ''), 'binary');
        const type = root.lookupType(schema);
        const message = type.decode(bytes);
        const obj = type.toObject(message, {
          defaults: true,
          longs: Number,
          enums: Number,
          bytes: Buffer,
          oneofs: true,
        }) as Record<string, unknown>;
        // bytes → Lua byte-string via latin1
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
    load(data: unknown): boolean | undefined {
      try {
        const s = typeof data === 'string' ? data : Buffer.from(String(data ?? ''), 'binary').toString('latin1');
        if (s === '') {
          return undefined; // lua-protobuf: empty load fails (nil, offset)
        }
        // (a) raw .proto text
        if (s.includes('message ') || s.includes('syntax ') || s.includes('package ') || s.includes('enum ')) {
          try {
            // keepCase: lua-protobuf preserves the .proto field names
            const parsed = protobuf.parse(s, { keepCase: true });
            parsed.root.resolveAll();
            let added = 0;
            for (const nested of parsed.root.nestedArray ?? []) {
              if (nested instanceof protobuf.Type || nested instanceof protobuf.Enum || nested instanceof protobuf.Namespace) {
                try {
                  root.add(nested); // duplicate names are tolerated (re-load)
                  added += 1;
                } catch {
                  // already registered by an earlier load
                }
              }
            }
            if (added > 0 || s.includes('package ')) {
              root.resolveAll();
              return true;
            }
          } catch {
            // fall through to descriptor-set parsing
          }
        }
        // (b) serialized google.protobuf.FileDescriptorSet (lua-protobuf
        // preloads the descriptor — mirrored from protobufjs' bundled copy)
        const descriptorSource = getDescriptorProtoSource();
        if (descriptorSource === undefined) {
          return undefined;
        }
        const descRoot = protobuf.parse(descriptorSource).root;
        descRoot.resolveAll();
        const set = descRoot.lookupType('google.protobuf.FileDescriptorSet');
        const decoded = set.decode(Buffer.from(s, 'latin1'));
        const obj = set.toObject(decoded, { defaults: false }) as { file?: ReadonlyArray<DecodedFile> };
        for (const file of obj.file ?? []) {
          addFileDescriptor(root, file);
        }
        root.resolveAll();
        return true;
      } catch {
        return undefined;
      }
    },
    setdefault: () => undefined,
    option: () => undefined,
  };
  return table;
}
