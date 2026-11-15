import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FMD2_LUA_ROOT } from '../../../src/engine/shims/install.js';
import { installPbShim } from '../../../src/engine/shims/pb-shim.js';
import { installRequireShim } from '../../../src/engine/shims/lua-require.js';

/**
 * pb shim × REAL utils/protoc.lua integration (audit bucket C): the
 * `has_pb` branch of the untouched, bundled protoc.lua runs end-to-end
 * through the shim on a real wasmoon engine — no stub, no reimplementation:
 *
 *   protoc.lua:993   local has_pb, pb = pcall(require, "pb")
 *   protoc.lua:1188  Parser.reload()   → assert(pb.load(descriptor_pb))
 *                    ── the embedded descriptor set crosses the
 *                       base64 Lua bridge as real bytes
 *   protoc.lua:1176  local ret, pos = pb.load(self:compile(s, name))
 *   protoc.lua:1177  if ret then return ret, pos end
 *   protoc.lua:1178  error("load failed at offset "..pos)
 *
 * Then a real schema MangaPlus actually uses (MangaPlus.proto — the
 * committed fixture copy of FMD2/lua/modules/MangaPlus.proto, loaded
 * exactly like MangaPlus.lua:110 `protoc:load(ReadFile(target_file))`
 * with `protoc.proto3_optional = true`, MangaPlus.lua:109) round-trips
 * encode/decode, and the RECORDED golden Response payload
 * (corpus/fixtures/seed/MangaPlus/source.bin — the §13.1 seed fixture,
 * "pb.decode Response payload — provenance for the pb shim") decodes
 * through the exact access chain MangaPlus.lua:123 walks.
 *
 * Offline: no network — everything reads committed files.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_FIXTURE = join(HERE, 'fixtures', 'MangaPlus.proto');
const GOLDEN_PAYLOAD = resolve(HERE, '..', '..', '..', '..', 'corpus', 'fixtures', 'seed', 'MangaPlus', 'source.bin');

describe('real utils/protoc.lua through the pb shim (wasmoon, offline)', () => {
  let engine: LuaEngine;

  beforeAll(async () => {
    engine = await new LuaFactory().createEngine();
    // The production §5.7 wiring: require shim over the synced FMD2 lua
    // tree — this installs the file searcher that serves
    // `require 'utils.protoc'` AND the pb base64 bridge (installPbShim).
    installRequireShim(engine, { luaRoot: FMD2_LUA_ROOT });
  });

  afterAll(() => {
    engine.global.close();
  });

  it('require "utils.protoc" runs the has_pb branch incl. Parser.reload() through the shim', () => {
    // Loading the chunk executes protoc.lua:993 pcall(require, "pb")
    // (our preload) and protoc.lua:1188 Parser.reload() — which
    // asserts pb.load(descriptor_pb) on the EMBEDDED descriptor-set
    // bytes (packed decimal escapes ≥ 0x80, NULs): the byte-exact
    // bridge path. A require failure here fails the test.
    const ok = engine.doStringSync(`
      local protoc = require 'utils.protoc'
      return type(protoc) == 'table' and protoc.compile ~= nil and protoc.load ~= nil
    `);
    expect(ok).toBe(true);
  });

  it('pb.load binds (ret, pos) as two values from Lua — the protoc.lua:1176 shape', () => {
    // protoc.lua:1143-1145 ran INSIDE the require above; assert the
    // shim's two-value contract survives the same call shape from Lua.
    const r = engine.doStringSync(`
      local pb = require 'pb'
      -- empty input: nothing consumed → (false, 1), exactly two values
      local count = select('#', pb.load(''))
      -- garbage: the failure binding protoc.lua:1176-1178 relies on
      local ret, pos = pb.load(string.char(9, 200)) -- wire type fixed64, no bytes
      return { count, ret, pos, type(pos) }
    `) as unknown[];
    const [count, ret, pos, posType] = [...(r ?? [])];
    expect(count).toBe(2);
    expect(ret).toBe(false);
    expect(posType).toBe('number');
    expect(pos).toBeGreaterThanOrEqual(1);
  });

  it('protoc:load(MangaPlus.proto) binds (ret, pos) and pos equals the compiled size+1', () => {
    const schema = readFileSync(PROTO_FIXTURE, 'utf8');
    engine.global.set('__fmd_test_proto_src', schema);
    // MangaPlus.lua:109-110 shape: protoc.proto3_optional = true;
    // protoc:load(schema) — protoc.lua:1176 binds BOTH pb.load returns
    // and propagates them (protoc.lua:1177 `return ret, pos`).
    const r = engine.doStringSync(`
      local protoc = require 'utils.protoc'
      protoc.proto3_optional = true
      local ret, pos = protoc:load(__fmd_test_proto_src)
      local bytes = protoc:compile(__fmd_test_proto_src)
      return { ret, pos, #bytes, type(pos) }
    `) as unknown[];
    const [ret, pos, compiledLen, posType] = [...(r ?? [])];
    expect(ret).toBe(true);
    // lua-protobuf: pos = offset read so far (1-based) = byte count+1
    // for a fully consumed descriptor set — tied here to the SAME
    // parser's own compile output.
    expect(posType).toBe('number');
    expect(pos).toBe(Number(compiledLen) + 1);
  });

  it('round-trips a MangaPlus schema message through pb.encode/pb.decode', () => {
    const r = engine.doStringSync(`
      local pb = require 'pb'
      local src = {
        success = {
          titleDetailView = {
            title = { titleId = 100000001, name = 'Fixture Title', author = 'Fixture Author', language = 'ENGLISH' },
            titleImageUrl = 'https://example.invalid/image.jpg',
            overview = 'fixture overview',
            tags = { { tag = 'shonen' } },
            titleLabels = { releaseSchedule = 'WEEKLY' },
          },
        },
      }
      local wire = pb.encode('Response', src)
      local back = pb.decode('Response', wire)
      local t = back.success.titleDetailView
      return {
        t ~= nil, t.title.titleId, t.title.name, t.title.author, t.title.language,
        t.tags[1].tag, t.titleImageUrl, t.overview, t.titleLabels.releaseSchedule,
      }
    `) as unknown[];
    expect([...(r ?? [])]).toEqual([
      true, 100000001, 'Fixture Title', 'Fixture Author', 'ENGLISH',
      'shonen', 'https://example.invalid/image.jpg', 'fixture overview', 'WEEKLY',
    ]);
  });

  it('decodes the recorded golden Response payload via MangaPlus.lua:123 access chain', () => {
    const payload = readFileSync(GOLDEN_PAYLOAD);
    expect(payload.length).toBeGreaterThan(0);
    // Binary payload crosses via the bridge's own b64 decoder (the same
    // envelope the HTTP.Document.ToString → pb.decode path uses).
    engine.global.set('__fmd_test_payload_b64', payload.toString('base64'));
    const r = engine.doStringSync(`
      local pb = require 'pb'
      local data = __fmd_pb_b64dec(__fmd_test_payload_b64)
      -- the recorded seed fixture is the API's field-2 ERROR variant
      -- ("Account Banned", corpus/fixtures/seed/MangaPlus/manifest.json
      -- "pb.decode Response payload"): field 2 is not in the trimmed
      -- MangaPlus.proto (only success = 1), so native lua-protobuf
      -- skips it and success stays nil.
      local first = data:byte(1)
      local banned = data:find('MANGA Plus', 1, true) ~= nil
      -- MangaPlus.lua:123-124 — the exact production access chain: with
      -- native pb the module's unguarded chain errors on an error-variant
      -- payload (success nil), and FMD2's event pcall turns that into
      -- net_problem. Assert the same shape here.
      local ok, err = pcall(function()
        return pb.decode('Response', data).success.allTitlesViewV2.AllTitlesGroup
      end)
      return { first, banned, ok, err }
    `) as unknown[];
    const [firstByte, bannedText, ok, err] = [...(r ?? [])];
    expect(firstByte).toBe(0x12); // Response field 2 (error variant)
    expect(bannedText).toBe(true);
    expect(ok).toBe(false);
    expect(String(err)).toContain("attempt to index a nil value (field 'success')");
  });

  it('runs the full GetNameAndLink chain on a schema-true allTitlesViewV2 Response', () => {
    // The schema MangaPlus actually consumes (MangaPlus.lua:123-129):
    // build the payload with the shim's own encode (protoc-loaded
    // schema) and walk it exactly like the module body does.
    const r = engine.doStringSync(`
      local pb = require 'pb'
      local src = {
        success = {
          allTitlesViewV2 = {
            AllTitlesGroup = {
              { titles = {
                  { titleId = 100000001, name = 'One Fixture', author = 'A', language = 'ENGLISH' },
                  { titleId = 100000002, name = 'Deux Fixtures', author = 'B', language = 'FRENCH' },
              } },
              { titles = {
                  { titleId = 100000010, name = 'Пример', author = 'C', language = 'RUSSIAN' },
              } },
            },
          },
        },
      }
      local wire = pb.encode('Response', src)
      local manga = pb.decode('Response', wire).success.allTitlesViewV2.AllTitlesGroup
      if not manga then return { false } end
      -- MangaPlus.lua:126-129 shape: LINKS.Add / NAMES.Add per title
      local links, names = {}, {}
      for _, group in ipairs(manga) do
        for _, v in ipairs(group.titles) do
          links[#links + 1] = 'titles/' .. v.titleId
          names[#names + 1] = v.name
        end
      end
      local langs = {}
      for _, group in ipairs(manga) do
        for _, v in ipairs(group.titles) do
          langs[#langs + 1] = v.language
        end
      end
      return { true, #links, links[1], links[3], names[1], names[3], langs[2], langs[3] }
    `) as unknown[];
    expect([...(r ?? [])]).toEqual([
      true, 3, 'titles/100000001', 'titles/100000010',
      'One Fixture', 'Пример', 'FRENCH', 'RUSSIAN',
    ]);
  });
});

describe('pb.load failure path through protoc.lua error shape (wasmoon)', () => {
  let engine: LuaEngine;

  beforeAll(async () => {
    engine = await new LuaFactory().createEngine();
    installPbShim(engine);
  });

  afterAll(() => {
    engine.global.close();
  });

  it('protoc.lua:1178 error() concatenates the numeric offset the shim returned', () => {
    // The literal failure branch of Parser:load (protoc.lua:1174-1179)
    // against a shim-rejected payload: pos must be a NUMBER (the concat
    // is the audit's complaint) and the error message carries it.
    engine.global.set('__fmd_test_bad_b64', Buffer.from('\x00\x01not-a-schema', 'latin1').toString('base64'));
    const msg = engine.doStringSync(`
      local pb = require 'pb'
      local ret, pos = pb.load(__fmd_pb_b64dec(__fmd_test_bad_b64))
      if ret then return 'unexpected success' end
      return 'load failed at offset ' .. pos
    `);
    expect(msg).toMatch(/^load failed at offset \d+$/);
  });
});
