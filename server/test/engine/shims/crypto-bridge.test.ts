import { randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sodium from 'sodium-native';
import { installRequireShim } from '../../../src/engine/shims/lua-require.js';
import { CRYPTO_METHOD_NAMES } from '../../../src/engine/shims/crypto-shim.js';
import * as core from '../../../src/engine/shims/crypto-core.js';

/**
 * fmd.crypto Lua bridge integration (wasmoon): the base64 byte-exact
 * bridge carries NUL bytes and 0x80–0xFF values through Lua↔JS, mirrors
 * the Pascal lua_push* return protocol (values / nil / zero returns /
 * multi-returns), and the full 59-method surface is require-able.
 */

const fromLatin1 = (s: string): Buffer => Buffer.from(s, 'latin1');

describe('fmd.crypto Lua bridge', () => {
  const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-crypto-bridge-'));
  const factory = new LuaFactory();
  let engine: LuaEngine;

  beforeAll(async () => {
    engine = await factory.createEngine();
    installRequireShim(engine, { luaRoot });
  });

  afterAll(() => {
    engine.global.close();
  });

  it('exposes the full 59-method surface under require lib fmd.crypto', () => {
    const names = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local keys = {}
      for k in pairs(c) do keys[#keys + 1] = k end
      table.sort(keys)
      return keys
    `)) as unknown[];
    expect([...names]).toEqual([...CRYPTO_METHOD_NAMES].sort());
  });

  it('carries NUL bytes and high bytes byte-exactly (hash chain)', () => {
    // Binary strings are built Lua-side (the module path — globals and
    // literals cross wasmoon's UTF-8 marshaling and would truncate NULs).
    const key = Buffer.from([0x00, 0xc3, 0x00, 0xff, 0x7f]).toString('latin1');
    const data = 'payload\u0000\u0080tail';
    const [shaHex, macHex] = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local k = string.char(0, 0xc3, 0, 0xff, 0x7f)
      local d = 'payload' .. string.char(0, 0x80) .. 'tail'
      local function tohex(s)
        local t = {}
        for i = 1, #s do t[i] = string.format('%02x', s:byte(i)) end
        return table.concat(t)
      end
      return { tohex(c.SHA256(d)), tohex(c.HMAC_SHA256(d, k)) }
    `)) as string[];
    expect(shaHex).toBe(core.sha256Hex(data));
    expect(macHex).toBe(core.hmacSha256Hex(data, key));
    // hex text path (pure ASCII) is byte-exact too
    expect((engine.doStringSync(`local c = require 'fmd.crypto' local d = 'payload' .. string.char(0, 0x80) .. 'tail' return c.SHA256Hex(d)`)) as string)
      .toBe(core.sha256Hex(data));
  });

  it('CRC16/CRC32 return Lua integers (CRC32 above 2^31 intact)', () => {
    // crc32('123456789') = 0xCBF43926 > 2^31
    expect(core.crc32('123456789')).toBeGreaterThan(2 ** 31);
    const [c16, c32] = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      return { c.CRC16('123456789'), c.CRC32('123456789') }
    `)) as number[];
    expect(Number(c16)).toBe(core.crc16('123456789'));
    expect(Number(c32)).toBe(core.crc32('123456789'));
  });

  it('P256_GenerateKeyPair returns two values; SharedSecret agrees in Lua', () => {
    const result = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local priv1, pub1 = c.P256_GenerateKeyPair()
      local priv2, pub2 = c.P256_GenerateKeyPair()
      local s1 = c.P256_SharedSecret(priv1, pub2)
      local s2 = c.P256_SharedSecret(priv2, pub1)
      return { select('#', c.P256_GenerateKeyPair()), #priv1, #pub1, pub1:byte(1), s1 == s2, #s1 }
    `)) as [number, number, number, number, boolean, number];
    expect(result[0]).toBe(2); // two return values
    expect(result[1]).toBe(32);
    expect(result[2]).toBe(65);
    expect(result[3]).toBe(0x04);
    expect(result[4]).toBe(true); // symmetric secrets
    expect(result[5]).toBe(32);
  });

  it('SecretStream: sodium push stream pulls in Lua (3 values + tag); tamper gives zero returns', () => {
    const key = randomBytes(32);
    const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
    const header = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, key);
    const msg1 = Buffer.from(Array.from({ length: 50 }, (_, i) => (i * 13 + 7) & 0xff));
    const cipher1 = Buffer.alloc(50 + sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
    sodium.crypto_secretstream_xchacha20poly1305_push(
      state, cipher1, msg1, null,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    // Binary chunks cross into Lua as byte-number tables (strings would go
    // through wasmoon's lossy UTF-8 marshaling); the Lua script assembles
    // exact byte strings from the tables.
    engine.global.set('KBYTES', [...key]);
    engine.global.set('HBYTES', [...header]);
    engine.global.set('CBYTES', [...cipher1]);
    const result = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local function bytesFromTable(t)
        local parts = {}
        for i = 1, #t do parts[i] = string.char(t[i]) end
        return table.concat(parts)
      end
      local key = bytesFromTable(KBYTES)
      local hdr = bytesFromTable(HBYTES)
      local chunk = bytesFromTable(CBYTES)
      local st = c.SecretStream_InitPull(hdr, key)
      if st == nil then return { 'init-nil' } end
      local nstate, m1, tag1 = c.SecretStream_Pull(st, chunk)
      if nstate == nil then return { 'pull-nil' } end
      -- bad state token → zero returns
      local arityBad = select('#', c.SecretStream_Pull('x', string.rep('y', 40)))
      -- tampered chunk → zero returns
      local chunk2 = chunk:sub(1, 10) .. string.char(chunk:byte(11) ~ 0xff) .. chunk:sub(12)
      local arityTampered = select('#', c.SecretStream_Pull(nstate, chunk2))
      local function tohex(s)
        local t = {}
        for i = 1, #s do t[i] = string.format('%02x', s:byte(i)) end
        return table.concat(t)
      end
      return { 'ok', #m1, tag1, arityBad, arityTampered, tohex(m1) }
    `)) as [string, number, number, number, number, string];
    expect(result[0]).toBe('ok');
    expect(result[1]).toBe(50);
    expect(result[2]).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
    expect(result[3]).toBe(0);
    expect(result[4]).toBe(0);
    expect(result[5]).toBe(msg1.toString('hex'));
  });

  it('EncryptString/DecryptString roundtrip inside Lua', () => {
    const roundtrip = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local enc = c.EncryptString('settings value')
      return c.DecryptString(enc) == 'settings value' and #enc > 0
    `)) as boolean;
    expect(roundtrip).toBe(true);
  });

  it('full module chain (NexusScanlation shape): keypair → ECDH → HMAC chain → AES-GCM', () => {
    const ok = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local priv, pub = c.P256_GenerateKeyPair()
      -- second keypair plays the server side
      local spriv, spub = c.P256_GenerateKeyPair()
      local shared = c.P256_SharedSecret(priv, spub)
      local prk = c.HMAC_SHA256(shared, string.rep(string.char(0), 32))
      local okm = c.HMAC_SHA256('Content-Encoding: key' .. string.char(0, 1), prk):sub(1, 16)
      local nonce = c.HMAC_SHA256('Content-Encoding: nonce' .. string.char(0, 1), prk):sub(1, 12)
      local plain = 'the chapter pages'
      local sealed = c.AESEncryptGCM(plain, okm, nonce, '')
      local opened = c.AESDecryptGCM(sealed, okm, nonce, '')
      -- AESCTR roundtrip on binary payload (PhiliaScans shape)
      local payload = string.rep(string.char(0xa5, 0x00, 0xff), 7)
      local keystreamed = c.AESCTR(payload, okm, string.rep(string.char(0), 16))
      return opened == plain and c.AESCTR(keystreamed, okm, string.rep(string.char(0), 16)) == payload
    `)) as boolean;
    expect(ok).toBe(true);
    // independent JS check of the same chain shape
    const p1 = core.p256GenerateKeyPair();
    const p2 = core.p256GenerateKeyPair();
    if (p1 === false || p2 === false) throw new Error('keygen failed');
    const shared = core.p256SharedSecret(p1[0], p2[1]);
    const prk = createHmac('sha256', Buffer.alloc(32)).update(fromLatin1(shared)).digest();
    const okm = createHmac('sha256', prk).update('Content-Encoding: key\u0000\u0001').digest().subarray(0, 16).toString('latin1');
    const nonce = createHmac('sha256', prk).update('Content-Encoding: nonce\u0000\u0001').digest().subarray(0, 12).toString('latin1');
    const sealed = core.aesEncryptGCM('the chapter pages', okm, nonce, '');
    expect(core.aesDecryptGCM(sealed, okm, nonce, '')).toBe('the chapter pages');
  });

  it('failure protocol shapes: "" failures and the Pascal error behavior', () => {
    const shapes = (engine.doStringSync(`
      local c = require 'fmd.crypto'
      local okLongHash = pcall(function() c.MD5LongHash('', 5) end)
      return {
        c.NoSuchMethod == nil,
        c.AESEncryptCBC('', 'k', 'i') == '',
        c.RC4('', 'k') == '',
        c.PBKDF2SHA256('', 's', 1, 32) == '',
        select('#', c.SecretStream_Pull('x', 'short')) == 0,
        select('#', c.SecretStream_InitPull('short', 'key')) == 1,
        okLongHash,
      }
    `)) as [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
    expect(shapes[0]).toBe(true); // unknown method → nil
    expect(shapes[1]).toBe(true);
    expect(shapes[2]).toBe(true);
    expect(shapes[3]).toBe(true);
    expect(shapes[4]).toBe(true); // bad pull → zero returns
    expect(shapes[5]).toBe(true); // bad init → exactly one nil
    // value = '' divides by zero in the Pascal — surfaced as a Lua error
    expect(shapes[6]).toBe(false);
  });
});
