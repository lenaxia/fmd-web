import { describe, expect, it } from 'vitest';
import { makePbShim, pbBridgeCall } from '../../../src/engine/shims/pb-shim.js';

/**
 * pb shim unit tests (§5.7 D17, acceptance): the shim's `pb.load`
 * implements lua-protobuf's DOCUMENTED two-value contract —
 * `boolean, integer` per the README pb-module table ("returns a boolean
 * indicates the result of loading, success or failure, and a offset
 * reading in schema so far"), always pushed as exactly two values by
 * pb.c `Lpb_load` — and protoc.lua binds both returns:
 *
 *   local ret, pos = pb.load(self:compile(s, name))  -- protoc.lua:1176
 *   if ret then return ret, pos end
 *   error("load failed at offset "..pos)             -- protoc.lua:1178
 *
 * so the second value MUST be a number (it is concatenated). Inputs are
 * serialized google.protobuf.FileDescriptorSet bytes only (the raw
 * .proto-text path v0 offered does not exist in lua-protobuf and was
 * removed): protoc.lua:1165 `pb.encode('.google.protobuf.FileDescriptorSet',
 * set)` is the producer, enabled by the shim's eager descriptor preload
 * (Parser.reload parity — protoc.lua:1143-1145,1188).
 */

const MINI_DESCRIPTOR_SET = {
  file: [
    {
      name: 'fmd/test.proto',
      package: 'fmd.test',
      syntax: 'proto3',
      enum_type: [
        {
          name: 'Lang',
          value: [
            { name: 'UNKNOWN', number: 0 },
            { name: 'EN', number: 1 },
            { name: 'FR', number: 2 },
          ],
        },
      ],
      message_type: [
        {
          name: 'Chapter',
          field: [
            { name: 'hid', number: 1, label: 1, type: 9 },
            { name: 'number', number: 2, label: 1, type: 13 },
            { name: 'groups', number: 3, label: 3, type: 9 },
            { name: 'lang', number: 4, label: 1, type: 14, type_name: '.fmd.test.Lang' },
            { name: 'sub', number: 5, label: 1, type: 11, type_name: '.fmd.test.SubChapter' },
          ],
        },
        {
          name: 'SubChapter',
          field: [
            { name: 'title', number: 1, label: 1, type: 9 },
            { name: 'premium', number: 2, label: 1, type: 8 },
          ],
        },
        {
          name: 'ChapterList',
          field: [
            { name: 'data', number: 1, label: 3, type: 11, type_name: '.fmd.test.Chapter' },
            { name: 'last_page', number: 2, label: 1, type: 5 },
          ],
        },
      ],
    },
  ],
};

describe('pb shim (protobufjs-backed package.preload["pb"]) — load contract', () => {
  it('preloads the descriptor protos (Parser.reload parity) so protoc.lua compile works', () => {
    const pb = makePbShim();
    // protoc.lua:1165 — pb.encode('.google.protobuf.FileDescriptorSet', set)
    // must work before any user pb.load (protoc.lua:1188 Parser.reload()).
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET);
    expect(typeof bytes).toBe('string');
    expect((bytes ?? '').length).toBeGreaterThan(0);
  });

  it('pb.load returns the true (ret, pos) contract: (true, consumed+1) on success', () => {
    const pb = makePbShim();
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET) ?? '';
    const result = pb.load(bytes);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    const [ret, pos] = result;
    expect(ret).toBe(true);
    expect(typeof pos).toBe('number');
    // pb.c Lpb_load: lua_pushinteger(L, pb_pos(s) + 1) — the 1-based
    // offset read so far; a fully consumed descriptor reads len bytes.
    expect(pos).toBe(Buffer.from(bytes, 'latin1').length + 1);
  });

  it('pb.load returns (false, offset-number) on garbage — protoc.lua:1178 can concatenate pos', () => {
    const pb = makePbShim();
    const [ret, pos] = pb.load('\x00\x01not-a-schema');
    expect(ret).toBe(false);
    expect(typeof pos).toBe('number');
    expect(pos).toBeGreaterThanOrEqual(1);
    // The exact statement protoc.lua:1178 runs on failure (pos must be a
    // number or the concat itself would throw).
    expect(() => {
      const [r, p] = pb.load('\x00\x01not-a-schema');
      if (!r) {
        throw new Error(`load failed at offset ${String(p)}`);
      }
    }).toThrow(/^load failed at offset \d+$/);
    // empty data: nothing consumed → (false, 1), like native pb.load('')
    const [retEmpty, posEmpty] = pb.load('');
    expect(retEmpty).toBe(false);
    expect(posEmpty).toBe(1);
  });

  it('pb.load rejects trailing bytes after the descriptor set (native pb_load parity)', () => {
    const pb = makePbShim();
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET) ?? '';
    const [ret, pos] = pb.load(bytes + '\x09tail-junk');
    expect(ret).toBe(false);
    expect(typeof pos).toBe('number');
    expect(pos).toBeGreaterThan(1);
  });

  it('loaded schemas round-trip encode/decode with proto3 defaults + enum-as-name', () => {
    const pb = makePbShim();
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET) ?? '';
    expect(pb.load(bytes)[0]).toBe(true);
    const decoded = pb.decode('fmd.test.ChapterList', pb.encode('fmd.test.ChapterList', {
      data: [
        { hid: 'abc', number: 179, groups: ['Flame Scans', 'MangaPlus'], lang: 'EN', sub: { title: 'Finale', premium: false } },
        { hid: 'def', number: 178, groups: [], lang: 'FR' },
      ],
      last_page: 1,
    }));
    expect(decoded).toBeDefined();
    const data = decoded?.['data'] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(data[0]?.['hid']).toBe('abc');
    expect(data[0]?.['number']).toBe(179);
    expect(data[0]?.['groups']).toEqual(['Flame Scans', 'MangaPlus']);
    expect((data[0]?.['sub'] as Record<string, unknown>)['title']).toBe('Finale');
    // lua-protobuf's default enum_as_name option (MangaPlus.lua:129
    // GetLang keys off names like 'RUSSIAN').
    expect(data[0]?.['lang']).toBe('EN');
    expect(data[1]?.['lang']).toBe('FR');
    expect(decoded?.['last_page']).toBe(1);
  });

  it('re-loading the same descriptor set stays (true, …) — protoc.lua reload + re-load', () => {
    const pb = makePbShim();
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET) ?? '';
    // Parser.reload() runs pb.load(descriptor_pb) at require time
    // (protoc.lua:1188); modules then load their own schemas on top —
    // duplicate registrations are tolerated and still succeed.
    expect(pb.load(bytes)[0]).toBe(true);
    expect(pb.load(bytes)[0]).toBe(true);
    const decoded = pb.decode('fmd.test.Chapter', pb.encode('fmd.test.Chapter', { hid: 'rt', number: 2 }));
    expect(decoded?.['hid']).toBe('rt');
    expect(decoded?.['number']).toBe(2);
  });
});

describe('pb shim Lua bridge protocol (base64 envelope, two-value load)', () => {
  it('carries load through base64 and expands the two-value return', () => {
    const pb = makePbShim();
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET) ?? '';
    const b64 = Buffer.from(bytes, 'latin1').toString('base64');
    const result = pbBridgeCall(pb, 'load', [b64]) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(true);
    expect(result[1]).toBe(Buffer.from(bytes, 'latin1').length + 1);
  });

  it('carries encode/decode through base64 byte-exactly (NUL + high bytes)', () => {
    const pb = makePbShim();
    const bytes = pb.encode('.google.protobuf.FileDescriptorSet', MINI_DESCRIPTOR_SET) ?? '';
    expect(pb.load(bytes)[0]).toBe(true);
    const wire = pb.encode('fmd.test.Chapter', {
      hid: 'a\u0000b\u00e9\u4e2d', number: 7, groups: ['g\u00001'], lang: 'EN',
    }) ?? '';
    expect(wire.length).toBeGreaterThan(0);
    const b64 = Buffer.from(wire, 'latin1').toString('base64');
    const round = pbBridgeCall(pb, 'encode', ['fmd.test.Chapter', {
      hid: 'a\u0000b\u00e9\u4e2d', number: 7, groups: ['g\u00001'], lang: 'EN',
    }]);
    expect(typeof round).toBe('string');
    expect(Buffer.from(round as string, 'base64').toString('latin1')).toBe(wire);
    const decoded = pbBridgeCall(pb, 'decode', ['fmd.test.Chapter', b64]) as Record<string, unknown>;
    expect(decoded?.['hid']).toBe('a\u0000b\u00e9\u4e2d');
    expect(decoded?.['number']).toBe(7);
    expect(decoded?.['groups']).toEqual(['g\u00001']);
    expect(decoded?.['lang']).toBe('EN');
  });

  it('decode failure yields undefined (nil through the bridge)', () => {
    const pb = makePbShim();
    expect(pbBridgeCall(pb, 'decode', ['fmd.test.Chapter', Buffer.from('junk').toString('base64')])).toBeUndefined();
    expect(pbBridgeCall(pb, 'setdefault', [])).toBeUndefined();
    expect(pbBridgeCall(pb, 'option', [])).toBeUndefined();
  });
});
