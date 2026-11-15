import type { LuaEngine as WasmoonEngine } from 'wasmoon';
import * as core from './crypto-core.js';

/**
 * fmd.crypto Lua bridge (DESIGN.md §5.7, `LuaCrypto.pas:429–494`).
 *
 * The byte-level core (`crypto-core.ts`) speaks latin1 code-point strings;
 * this layer speaks to Lua over a base64 bridge because wasmoon's string
 * marshaling is lossy for Lua byte strings (UTF-8 decode with replacement
 * on read, NUL truncation, UTF-8 encode on push — see COMPAT.md
 * "byte strings"). Every Lua string argument is base64-encoded Lua-side
 * (pure-Lua encoder installed by the glue), the JS methods decode → core →
 * base64-encode results, and the Lua glue decodes back into exact bytes:
 * byte-exact for NULs and all 0x80–0xFF values, single uniform protocol.
 *
 * Result protocol (mirrors the Pascal `lua_push*` returns — JS values must
 * never be null/undefined: wasmoon's pushValue crashes on them):
 *  - string          → one Lua byte string (base64-decoded; '' stays '')
 *  - number          → one Lua integer (CRC16/CRC32, SecretStream tag)
 *  - NIL_SENTINEL    → one nil (SecretStream_InitPull failure, unknown method)
 *  - false           → zero returns (P256_GenerateKeyPair / SecretStream_Pull
 *                      failure — the Pascal `Result := 0`)
 *  - array           → multiple returns, string elements decoded
 *                      (P256_GenerateKeyPair, SecretStream_Pull)
 */

/** Marker for a single-nil return (SecretStream_InitPull failure). */
export const NIL_SENTINEL = '__fmd_nil';

/** Every method of the FMD2 crypto lib (cryptomethods + synacodemethods). */
export const CRYPTO_METHOD_NAMES: readonly string[] = [
  // cryptomethods (LuaCrypto.pas:429–474)
  'EncryptString', 'DecryptString', 'HTMLDecode', 'HTMLEncode',
  'HexToStr', 'StrToHexStr',
  'MD5Hex', 'HMAC_MD5Hex', 'SHA1Hex', 'HMAC_SHA1Hex',
  'SHA256', 'SHA256Hex', 'SHA512', 'SHA512Hex',
  'HMAC_SHA256', 'HMAC_SHA256Hex', 'HMAC_SHA512', 'HMAC_SHA512Hex',
  'AESEncryptCFB', 'AESDecryptCFB', 'AESEncryptCBC', 'AESDecryptCBC',
  'AESEncryptCBCSHA256Base64Pkcs7', 'AESDecryptCBCSHA256Base64Pkcs7',
  'AESDecryptCBCMD5Base64ZerosPadding', 'AESDecryptCBCHexBase64ZerosPadding',
  'AESEncryptECBPkcs7', 'AESDecryptECBPkcs7',
  'AESCTR', 'AESOFB', 'RC4', 'PBKDF2SHA256',
  'EncodeBase64URL', 'DecodeBase64URL',
  'AESEncryptGCM', 'AESDecryptGCM',
  'X25519_PublicKey', 'X25519_SharedSecret',
  'P256_PublicKey', 'P256_SharedSecret', 'P256_GenerateKeyPair',
  'SecretStream_InitPull', 'SecretStream_Pull',
  // synacodemethods (LuaCrypto.pas:476–493)
  'DecodeURL', 'EncodeURL', 'DecodeUU', 'EncodeUU', 'EncodeURLElement',
  'DecodeBase64', 'EncodeBase64', 'CRC16', 'CRC32',
  'MD4', 'MD5', 'HMAC_MD5', 'MD5LongHash',
  'SHA1', 'HMAC_SHA1', 'SHA1LongHash',
];

// ─── bridge plumbing ─────────────────────────────────────────────────────────

/** base64 of a latin1 code-point string (the bridge's byte encoding). */
function b64of(latin1: string): string {
  return Buffer.from(latin1, 'latin1').toString('base64');
}

/** base64 bridge arg → latin1 code-point string for the core. */
function argIn(v: unknown): string {
  if (typeof v === 'string') {
    return Buffer.from(v, 'base64').toString('latin1');
  }
  if (typeof v === 'number') {
    return Math.trunc(v).toString(10);
  }
  return '';
}

function numArg(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Bridge deps — the FMD2 EncryptString/DecryptString key (the hardcoded
 * uBaseUnit constant) is INJECTED here, never embedded: the single holder
 * is `server/src/tools/import/fmd2-crypto.ts` (see its module doc; the
 * eslint boundary + the key-isolation test enforce it). Unwired, the two
 * methods return '' (they are not reachable from any seed module — the
 * contract surface only fixes method NAMES, `CRYPTO_METHOD_NAMES`).
 */
export interface CryptoBridgeDeps {
  readonly encryptKey?: string;
}

/** The full method table over base64-encoded strings. */
export function cryptoBridgeMethods(deps?: CryptoBridgeDeps): Record<string, (...args: unknown[]) => unknown> {
  const encryptKey = deps?.encryptKey ?? '';
  return {
    // composed + plain FMD2 API — (s, key, iv[, aad]) byte strings
    EncryptString: (s: unknown) => b64of(core.encryptString(argIn(s), encryptKey)),
    DecryptString: (s: unknown) => b64of(core.decryptString(argIn(s), encryptKey)),
    HTMLDecode: (s: unknown) => b64of(core.htmlDecode(argIn(s))),
    HTMLEncode: (s: unknown) => b64of(core.htmlEncode(argIn(s))),
    HexToStr: (h: unknown) => b64of(core.hexToStr(argIn(h))),
    StrToHexStr: (s: unknown) => b64of(core.strToHexStr(argIn(s))),
    MD5Hex: (s: unknown) => b64of(core.md5Hex(argIn(s))),
    HMAC_MD5Hex: (s: unknown, key: unknown) => b64of(core.hmacMd5Hex(argIn(s), argIn(key))),
    SHA1Hex: (s: unknown) => b64of(core.sha1Hex(argIn(s))),
    HMAC_SHA1Hex: (s: unknown, key: unknown) => b64of(core.hmacSha1Hex(argIn(s), argIn(key))),
    SHA256: (s: unknown) => b64of(core.sha256(argIn(s))),
    SHA256Hex: (s: unknown) => b64of(core.sha256Hex(argIn(s))),
    SHA512: (s: unknown) => b64of(core.sha512(argIn(s))),
    SHA512Hex: (s: unknown) => b64of(core.sha512Hex(argIn(s))),
    HMAC_SHA256: (s: unknown, key: unknown) => b64of(core.hmacSha256(argIn(s), argIn(key))),
    HMAC_SHA256Hex: (s: unknown, key: unknown) => b64of(core.hmacSha256Hex(argIn(s), argIn(key))),
    HMAC_SHA512: (s: unknown, key: unknown) => b64of(core.hmacSha512(argIn(s), argIn(key))),
    HMAC_SHA512Hex: (s: unknown, key: unknown) => b64of(core.hmacSha512Hex(argIn(s), argIn(key))),
    AESEncryptCFB: (s: unknown, key: unknown, iv: unknown) => b64of(core.aesEncryptCFB(argIn(s), argIn(key), argIn(iv))),
    AESDecryptCFB: (s: unknown, key: unknown, iv: unknown) => b64of(core.aesDecryptCFB(argIn(s), argIn(key), argIn(iv))),
    AESEncryptCBC: (s: unknown, key: unknown, iv: unknown) => b64of(core.aesEncryptCBC(argIn(s), argIn(key), argIn(iv))),
    AESDecryptCBC: (s: unknown, key: unknown, iv: unknown) => b64of(core.aesDecryptCBC(argIn(s), argIn(key), argIn(iv))),
    AESEncryptCBCSHA256Base64Pkcs7: (s: unknown, key: unknown, iv: unknown) =>
      b64of(core.aesEncryptCBCSHA256Base64Pkcs7(argIn(s), argIn(key), argIn(iv))),
    AESDecryptCBCSHA256Base64Pkcs7: (s: unknown, key: unknown, iv: unknown) =>
      b64of(core.aesDecryptCBCSHA256Base64Pkcs7(argIn(s), argIn(key), argIn(iv))),
    AESDecryptCBCMD5Base64ZerosPadding: (s: unknown, key: unknown, iv: unknown) =>
      b64of(core.aesDecryptCBCMD5Base64ZerosPadding(argIn(s), argIn(key), argIn(iv))),
    AESDecryptCBCHexBase64ZerosPadding: (s: unknown, key: unknown, iv: unknown) =>
      b64of(core.aesDecryptCBCHexBase64ZerosPadding(argIn(s), argIn(key), argIn(iv))),
    AESEncryptECBPkcs7: (s: unknown, key: unknown) => b64of(core.aesEncryptECBPkcs7(argIn(s), argIn(key))),
    AESDecryptECBPkcs7: (s: unknown, key: unknown) => b64of(core.aesDecryptECBPkcs7(argIn(s), argIn(key))),
    AESCTR: (s: unknown, key: unknown, iv: unknown) => b64of(core.aesCTR(argIn(s), argIn(key), argIn(iv))),
    AESOFB: (s: unknown, key: unknown, iv: unknown) => b64of(core.aesOFB(argIn(s), argIn(key), argIn(iv))),
    RC4: (s: unknown, key: unknown) => b64of(core.rc4(argIn(s), argIn(key))),
    PBKDF2SHA256: (password: unknown, salt: unknown, iterations: unknown, dkLen: unknown) =>
      b64of(core.pbkdf2Sha256(argIn(password), argIn(salt), numArg(iterations), numArg(dkLen))),
    EncodeBase64URL: (s: unknown) => b64of(core.encodeBase64URL(argIn(s))),
    DecodeBase64URL: (s: unknown) => b64of(core.decodeBase64URL(argIn(s))),
    AESEncryptGCM: (s: unknown, key: unknown, iv: unknown, aad?: unknown) =>
      b64of(core.aesEncryptGCM(argIn(s), argIn(key), argIn(iv), argIn(aad))),
    AESDecryptGCM: (s: unknown, key: unknown, iv: unknown, aad?: unknown) =>
      b64of(core.aesDecryptGCM(argIn(s), argIn(key), argIn(iv), argIn(aad))),
    X25519_PublicKey: (priv: unknown) => b64of(core.x25519PublicKey(argIn(priv))),
    X25519_SharedSecret: (priv: unknown, pub: unknown) => b64of(core.x25519SharedSecret(argIn(priv), argIn(pub))),
    P256_PublicKey: (priv: unknown) => b64of(core.p256PublicKey(argIn(priv))),
    P256_SharedSecret: (priv: unknown, pub: unknown) => b64of(core.p256SharedSecret(argIn(priv), argIn(pub))),
    P256_GenerateKeyPair: () => {
      const pair = core.p256GenerateKeyPair();
      return pair === false ? false : [b64of(pair[0]), b64of(pair[1])];
    },
    SecretStream_InitPull: (header: unknown, key: unknown) => {
      const state = core.secretStreamInitPull(argIn(header), argIn(key));
      return state === null ? [NIL_SENTINEL] : b64of(state);
    },
    SecretStream_Pull: (state: unknown, chunk: unknown) => {
      const pulled = core.secretStreamPull(argIn(state), argIn(chunk));
      return pulled === false ? false : [b64of(pulled[0]), b64of(pulled[1]), pulled[2]];
    },
    // synacode block
    DecodeURL: (s: unknown) => b64of(core.decodeURL(argIn(s))),
    EncodeURL: (s: unknown) => b64of(core.encodeURL(argIn(s))),
    DecodeUU: (s: unknown) => b64of(core.decodeUU(argIn(s))),
    EncodeUU: (s: unknown) => b64of(core.encodeUU(argIn(s))),
    EncodeURLElement: (s: unknown) => b64of(core.encodeURLElement(argIn(s))),
    DecodeBase64: (s: unknown) => b64of(core.decodeBase64(argIn(s))),
    EncodeBase64: (s: unknown) => b64of(core.encodeBase64(argIn(s))),
    CRC16: (s: unknown) => core.crc16(argIn(s)),
    CRC32: (s: unknown) => core.crc32(argIn(s)),
    MD4: (s: unknown) => b64of(core.md4(argIn(s))),
    MD5: (s: unknown) => b64of(core.md5(argIn(s))),
    HMAC_MD5: (s: unknown, key: unknown) => b64of(core.hmacMd5(argIn(s), argIn(key))),
    MD5LongHash: (s: unknown, len: unknown) => b64of(core.md5LongHash(argIn(s), numArg(len))),
    SHA1: (s: unknown) => b64of(core.sha1(argIn(s))),
    HMAC_SHA1: (s: unknown, key: unknown) => b64of(core.hmacSha1(argIn(s), argIn(key))),
    SHA1LongHash: (s: unknown, len: unknown) => b64of(core.sha1LongHash(argIn(s), numArg(len))),
  };
}

/**
 * Dispatch one bridged call (`__fmd_crypto_call(name, ...)`); unknown
 * method names return the nil sentinel (Lua nil) — the surface is fixed by
 * `CRYPTO_METHOD_NAMES`.
 */
export function callCryptoMethod(name: unknown, args: unknown[], deps?: CryptoBridgeDeps): unknown {
  const fn = cryptoBridgeMethods(deps)[typeof name === 'string' ? name : ''];
  if (fn === undefined) {
    return [NIL_SENTINEL];
  }
  return fn(...args);
}

// ─── Lua glue ────────────────────────────────────────────────────────────────

/**
 * Lua side of the bridge: a pure-Lua base64 codec (byte-exact across
 * wasmoon), the `fmd.crypto` preload builder wrapping every method with
 * encode/decode, and the result protocol from the header comment. Installed
 * verbatim — never interpolated.
 */
export const CRYPTO_LUA_GLUE = `
package = package or {}
package.preload = package.preload or {}

local __crypto_alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local __crypto_lookup = {}
for i = 1, #__crypto_alpha do __crypto_lookup[__crypto_alpha:sub(i, i)] = i - 1 end

function __fmd_b64enc(data)
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
    t[#t + 1] = __crypto_alpha:sub(s1, s1) .. __crypto_alpha:sub(s2, s2) .. __crypto_alpha:sub(s3, s3) .. __crypto_alpha:sub(s4, s4)
    i = i + 3
  end
  local rem = n - i + 1
  if rem == 1 then
    local n24 = data:byte(i) * 65536
    local s1 = ((n24 >> 18) & 63) + 1
    local s2 = ((n24 >> 12) & 63) + 1
    t[#t + 1] = __crypto_alpha:sub(s1, s1) .. __crypto_alpha:sub(s2, s2) .. '=='
  elseif rem == 2 then
    local a, b = data:byte(i, i + 1)
    local n24 = a * 65536 + b * 256
    local s1 = ((n24 >> 18) & 63) + 1
    local s2 = ((n24 >> 12) & 63) + 1
    local s3 = ((n24 >> 6) & 63) + 1
    t[#t + 1] = __crypto_alpha:sub(s1, s1) .. __crypto_alpha:sub(s2, s2) .. __crypto_alpha:sub(s3, s3) .. '='
  end
  return table.concat(t)
end

function __fmd_b64dec(text)
  text = text:gsub('[^' .. __crypto_alpha .. '=]', '')
  text = text:gsub('=', '')
  local t = {}
  local n = #text
  local i = 1
  while i + 3 <= n do
    local l1 = __crypto_lookup[text:sub(i, i)] or 0
    local l2 = __crypto_lookup[text:sub(i + 1, i + 1)] or 0
    local l3 = __crypto_lookup[text:sub(i + 2, i + 2)] or 0
    local l4 = __crypto_lookup[text:sub(i + 3, i + 3)] or 0
    local n24 = l1 * 262144 + l2 * 4096 + l3 * 64 + l4
    t[#t + 1] = string.char((n24 >> 16) & 255, (n24 >> 8) & 255, n24 & 255)
    i = i + 4
  end
  local rem = n - i + 1
  if rem == 2 then
    local l1 = __crypto_lookup[text:sub(i, i)] or 0
    local l2 = __crypto_lookup[text:sub(i + 1, i + 1)] or 0
    t[#t + 1] = string.char(((l1 << 2) | (l2 >> 4)) & 255)
  elseif rem == 3 then
    local l1 = __crypto_lookup[text:sub(i, i)] or 0
    local l2 = __crypto_lookup[text:sub(i + 1, i + 1)] or 0
    local l3 = __crypto_lookup[text:sub(i + 2, i + 2)] or 0
    t[#t + 1] = string.char(((l1 << 2) | (l2 >> 4)) & 255, (((l2 & 15) << 4) | (l3 >> 2)) & 255)
  end
  return table.concat(t)
end

package.preload['fmd.crypto'] = function()
  local names = __fmd_crypto_names()
  local lib = {}
  for idx = 1, #names do
    local name = names[idx]
    lib[name] = function(...)
      local n = select('#', ...)
      local args = {}
      for i = 1, n do
        local v = select(i, ...)
        local tv = type(v)
        if tv == 'string' then
          args[i] = __fmd_b64enc(v)
        elseif tv == 'number' then
          args[i] = v
        else
          args[i] = ''
        end
      end
      local r = __fmd_crypto_call(name, table.unpack(args, 1, n))
      local tr = type(r)
      if tr == 'number' then return r end
      if tr == 'string' then return __fmd_b64dec(r) end
      if tr == 'table' or tr == 'userdata' then
        -- arrays arrive as userdata proxies (wasmoon); #r works on them
        if #r == 1 and r[1] == '__fmd_nil' then return nil end
        local out = {}
        for j = 1, #r do
          local v = r[j]
          if type(v) == 'string' then
            out[j] = __fmd_b64dec(v)
          else
            out[j] = v
          end
        end
        return table.unpack(out, 1, #r)
      end
      -- false / anything else: zero returns (Pascal Result := 0)
    end
  end
  return lib
end
`;

/** Install the crypto bridge onto a wasmoon engine (call after the Lua
 * package table exists — the glue only touches `package.preload`).
 * `deps.encryptKey` injects the FMD2 EncryptString key (see
 * {@link CryptoBridgeDeps}); the wiring lives in `install.ts`. */
export function installCryptoShim(engine: WasmoonEngine, deps?: CryptoBridgeDeps): void {
  engine.global.set('__fmd_crypto_names', () => [...CRYPTO_METHOD_NAMES]);
  engine.global.set('__fmd_crypto_call', (name: unknown, ...args: unknown[]) =>
    callCryptoMethod(name, args, deps));
  engine.doStringSync(CRYPTO_LUA_GLUE);
}
