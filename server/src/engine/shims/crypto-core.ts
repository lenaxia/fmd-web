import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import type { CipherGCM, DecipherGCM } from 'node:crypto';

/**
 * fmd.crypto byte-level core (DESIGN.md §5.7, `LuaCrypto.pas:429–494` +
 * `BaseCrypto.pas` + `synacode.pas` + `uBaseUnit.pas` port).
 *
 * Byte-string convention (COMPAT.md "byte strings"): every string argument /
 * result is a JS string whose code points ARE the bytes (latin1 view,
 * `Buffer.from(s, 'latin1')` ⇄ `buf.toString('latin1')`). The Lua-facing
 * bridge (`crypto-shim.ts`) keeps code point = byte across wasmoon's
 * UTF-8 marshaling, and tests use this view directly for byte-exact
 * vectors.
 *
 * Every function ports the exact FMD2 edge cases; the doc comment of each
 * cites the Pascal lines it mirrors.
 */

type Bytes = Buffer;

// ─── byte-string helpers ─────────────────────────────────────────────────────

/** JS string (latin1 code points) → raw bytes. */
function b(s: string): Bytes {
  return Buffer.from(s, 'latin1');
}

/** Raw bytes → JS string (latin1 code points). */
function s(v: Bytes): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1');
}

function hexUpper(v: Bytes): string {
  return v.toString('hex').toUpperCase();
}

/** FPC `BinToHex`/`IntToHex` lower/upper distinction is per-caller. */
function hexLower(v: Bytes): string {
  return v.toString('hex');
}

/** BaseCrypto.HexToStr (BaseCrypto.pas:71–85): '' on odd length or any non-hex char. */
export function hexToStr(h: string): string {
  if (h.length === 0 || (h.length & 1) !== 0) {
    return '';
  }
  const out = Buffer.alloc(h.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = hexDigit(h.charCodeAt(i * 2));
    const lo = hexDigit(h.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      return '';
    }
    out[i] = (hi << 4) | lo;
  }
  return s(out);
}

function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // '0'..'9'
  if (c >= 97 && c <= 102) return c - 97 + 10; // 'a'..'f'
  if (c >= 65 && c <= 70) return c - 65 + 10; // 'A'..'F'
  return -1;
}

/** BaseCrypto.StrToHexStr (BaseCrypto.pas:120–124, FPC BinToHex): uppercase. */
export function strToHexStr(v: string): string {
  return hexUpper(b(v));
}

// ─── hashes ──────────────────────────────────────────────────────────────────

/** BaseCrypto.MD5Raw (BaseCrypto.pas:397–410). */
export function md5(v: string): string {
  return s(createHash('md5').update(b(v)).digest());
}

/** BaseCrypto.MD5Hex (BaseCrypto.pas:412–415): lowercase hex. */
export function md5Hex(v: string): string {
  return hexLower(createHash('md5').update(b(v)).digest());
}

/** synacode.MD5LongHash (synacode.pas:1142–1158): hash of value repeated to Len.
 * Value '' divides by zero in Pascal (crash) — mirrored as an error. */
export function md5LongHash(v: string, len: number): string {
  return s(longHash(createHash('md5'), b(v), len));
}

/** BaseCrypto.SHA1Raw (BaseCrypto.pas:491–504). */
export function sha1(v: string): string {
  return s(createHash('sha1').update(b(v)).digest());
}

/** BaseCrypto.SHA1Hex (BaseCrypto.pas:506–509). */
export function sha1Hex(v: string): string {
  return hexLower(createHash('sha1').update(b(v)).digest());
}

/** synacode.SHA1LongHash (synacode.pas:1370–1386). */
export function sha1LongHash(v: string, len: number): string {
  return s(longHash(createHash('sha1'), b(v), len));
}

/** BaseCrypto.SHA256 (BaseCrypto.pas:564–577). */
export function sha256(v: string): string {
  return s(createHash('sha256').update(b(v)).digest());
}

/** BaseCrypto.SHA256Hex (BaseCrypto.pas:579–582). */
export function sha256Hex(v: string): string {
  return hexLower(createHash('sha256').update(b(v)).digest());
}

/** BaseCrypto.SHA512 (BaseCrypto.pas:640–653). */
export function sha512(v: string): string {
  return s(createHash('sha512').update(b(v)).digest());
}

/** BaseCrypto.SHA512Hex (BaseCrypto.pas:655–658). */
export function sha512Hex(v: string): string {
  return hexLower(createHash('sha512').update(b(v)).digest());
}

function longHash(hash: ReturnType<typeof createHash>, value: Bytes, len: number): Bytes {
  const l = value.length;
  if (l === 0) {
    // Pascal: Len div 0 → EDivByZero (fatal). Surface as an error, not ''.
    throw new Error('MD5LongHash/SHA1LongHash: empty value (Pascal: division by zero)');
  }
  let cnt = Math.trunc(len / l);
  const rest = Math.trunc(len % l);
  if (len < 0) {
    cnt = 0;
  }
  for (let n = 0; n < cnt; n += 1) {
    hash.update(value);
  }
  if (rest > 0) {
    hash.update(value.subarray(0, rest));
  }
  return hash.digest();
}

// ─── HMACs ───────────────────────────────────────────────────────────────────
// The Pascal hand-rolls HMAC with 64/128-byte blocks and hashes overlong
// keys — the RFC 2104/4231 construction `node:crypto` implements. Vectors
// assert parity (BaseCrypto.pas:417–468, 511–562, 584–638, 660–714).

/** BaseCrypto.HMAC_MD5Hex (BaseCrypto.pas:417–468). */
export function hmacMd5Hex(v: string, key: string): string {
  return hexLower(createHmac('md5', b(key)).update(b(v)).digest());
}

/** synacode.HMAC_MD5 (synacode.pas:1115–1138). */
export function hmacMd5(v: string, key: string): string {
  return s(createHmac('md5', b(key)).update(b(v)).digest());
}

/** BaseCrypto.HMAC_SHA1Hex (BaseCrypto.pas:511–562). */
export function hmacSha1Hex(v: string, key: string): string {
  return hexLower(createHmac('sha1', b(key)).update(b(v)).digest());
}

/** synacode.HMAC_SHA1 (synacode.pas:1343–1366). */
export function hmacSha1(v: string, key: string): string {
  return s(createHmac('sha1', b(key)).update(b(v)).digest());
}

/** BaseCrypto.HMAC_SHA256 (BaseCrypto.pas:584–633). */
export function hmacSha256(v: string, key: string): string {
  return s(createHmac('sha256', b(key)).update(b(v)).digest());
}

/** BaseCrypto.HMAC_SHA256Hex (BaseCrypto.pas:635–638). */
export function hmacSha256Hex(v: string, key: string): string {
  return hexLower(createHmac('sha256', b(key)).update(b(v)).digest());
}

/** BaseCrypto.HMAC_SHA512 (BaseCrypto.pas:660–709). */
export function hmacSha512(v: string, key: string): string {
  return s(createHmac('sha512', b(key)).update(b(v)).digest());
}

/** BaseCrypto.HMAC_SHA512Hex (BaseCrypto.pas:711–714). */
export function hmacSha512Hex(v: string, key: string): string {
  return hexLower(createHmac('sha512', b(key)).update(b(v)).digest());
}

// ─── CRC (synacode block) ────────────────────────────────────────────────────

/** synacode.Crc32 (synacode.pas:830–846): IEEE reflected, init $FFFFFFFF,
 * final xor — identical to zlib. */
export function crc32(v: string): number {
  return zlibCrc32(b(v)) >>> 0;
}

/** synacode.Crc16 (synacode.pas:850–865): reflected CCITT table, init $FFFF,
 * NO final xor (the synacode signature). */
export function crc16(v: string): number {
  let crc = 0xffff;
  const data = b(v);
  for (let n = 0; n < data.length; n += 1) {
    crc = (((crc >> 8) & 0x00ff) ^ (CRC16_TAB[(crc ^ (data[n] ?? 0)) & 0x00ff] ?? 0)) & 0xffff;
  }
  return crc;
}

const CRC16_TAB: number[] = [
  0x0000, 0x1189, 0x2312, 0x329b, 0x4624, 0x57ad, 0x6536, 0x74bf,
  0x8c48, 0x9dc1, 0xaf5a, 0xbed3, 0xca6c, 0xdbe5, 0xe97e, 0xf8f7,
  0x1081, 0x0108, 0x3393, 0x221a, 0x56a5, 0x472c, 0x75b7, 0x643e,
  0x9cc9, 0x8d40, 0xbfdb, 0xae52, 0xdaed, 0xcb64, 0xf9ff, 0xe876,
  0x2102, 0x308b, 0x0210, 0x1399, 0x6726, 0x76af, 0x4434, 0x55bd,
  0xad4a, 0xbcc3, 0x8e58, 0x9fd1, 0xeb6e, 0xfae7, 0xc87c, 0xd9f5,
  0x3183, 0x200a, 0x1291, 0x0318, 0x77a7, 0x662e, 0x54b5, 0x453c,
  0xbdcb, 0xac42, 0x9ed9, 0x8f50, 0xfbef, 0xea66, 0xd8fd, 0xc974,
  0x4204, 0x538d, 0x6116, 0x709f, 0x0420, 0x15a9, 0x2732, 0x36bb,
  0xce4c, 0xdfc5, 0xed5e, 0xfcd7, 0x8868, 0x99e1, 0xab7a, 0xbaf3,
  0x5285, 0x430c, 0x7197, 0x601e, 0x14a1, 0x0528, 0x37b3, 0x263a,
  0xdecd, 0xcf44, 0xfddf, 0xec56, 0x98e9, 0x8960, 0xbbfb, 0xaa72,
  0x6306, 0x728f, 0x4014, 0x519d, 0x2522, 0x34ab, 0x0630, 0x17b9,
  0xef4e, 0xfec7, 0xcc5c, 0xddd5, 0xa96a, 0xb8e3, 0x8a78, 0x9bf1,
  0x7387, 0x620e, 0x5095, 0x411c, 0x35a3, 0x242a, 0x16b1, 0x0738,
  0xffcf, 0xee46, 0xdcdd, 0xcd54, 0xb9eb, 0xa862, 0x9af9, 0x8b70,
  0x8408, 0x9581, 0xa71a, 0xb693, 0xc22c, 0xd3a5, 0xe13e, 0xf0b7,
  0x0840, 0x19c9, 0x2b52, 0x3adb, 0x4e64, 0x5fed, 0x6d76, 0x7cff,
  0x9489, 0x8500, 0xb79b, 0xa612, 0xd2ad, 0xc324, 0xf1bf, 0xe036,
  0x18c1, 0x0948, 0x3bd3, 0x2a5a, 0x5ee5, 0x4f6c, 0x7df7, 0x6c7e,
  0xa50a, 0xb483, 0x8618, 0x9791, 0xe32e, 0xf2a7, 0xc03c, 0xd1b5,
  0x2942, 0x38cb, 0x0a50, 0x1bd9, 0x6f66, 0x7eef, 0x4c74, 0x5dfd,
  0xb58b, 0xa402, 0x9699, 0x8710, 0xf3af, 0xe226, 0xd0bd, 0xc134,
  0x39c3, 0x284a, 0x1ad1, 0x0b58, 0x7fe7, 0x6e6e, 0x5cf5, 0x4d7c,
  0xc60c, 0xd785, 0xe51e, 0xf497, 0x8028, 0x91a1, 0xa33a, 0xb2b3,
  0x4a44, 0x5bcd, 0x6956, 0x78df, 0x0c60, 0x1de9, 0x2f72, 0x3efb,
  0xd68d, 0xc704, 0xf59f, 0xe416, 0x90a9, 0x8120, 0xb3bb, 0xa232,
  0x5ac5, 0x4b4c, 0x79d7, 0x685e, 0x1ce1, 0x0d68, 0x3ff3, 0x2e7a,
  0xe70e, 0xf687, 0xc41c, 0xd595, 0xa12a, 0xb0a3, 0x8238, 0x93b1,
  0x6b46, 0x7acf, 0x4854, 0x59dd, 0x2d62, 0x3ceb, 0x0e70, 0x1ff9,
  0xf78f, 0xe606, 0xd49d, 0xc514, 0xb1ab, 0xa022, 0x92b9, 0x8330,
  0x7bc7, 0x6a4e, 0x58d5, 0x495c, 0x3de3, 0x2c6a, 0x1ef1, 0x0f78,
];

function zlibCrc32(data: Bytes): number {
  // IEEE table CRC (synacode Crc32Tab) — computed without a 256-entry table
  // (bitwise, identical result) to keep this file table-light.
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc;
}

// ─── MD4 (pure JS; OpenSSL 3 dropped MD4) ────────────────────────────────────

/** synacode.MD4 (synacode.pas:1390–1469, RFC 1320). Pure JS — node:crypto
 * cannot compute MD4 under OpenSSL 3.x (COMPAT.md "RC4/OpenSSL legacy"). */
export function md4(v: string): string {
  const data = b(v);
  const bitLen = data.length * 8;
  const padLen = ((data.length + 8) % 64 === 0) ? 8 : 64 - ((data.length + 8) % 64);
  const total = Buffer.alloc(data.length + padLen + 8);
  data.copy(total, 0);
  total[data.length] = 0x80;
  total.writeUInt32LE(bitLen >>> 0, total.length - 8);
  total.writeUInt32LE(Math.floor(bitLen / 0x100000000), total.length - 4);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;
  const f = (x: number, y: number, z: number): number => (x & y) | (~x & z);
  const g = (x: number, y: number, z: number): number => (x & y) | (x & z) | (y & z);
  const h = (x: number, y: number, z: number): number => x ^ y ^ z;
  const x = Buffer.alloc(64);
  for (let off = 0; off < total.length; off += 64) {
    total.copy(x, 0, off, off + 64);
    const m: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      m.push(x.readUInt32LE(i * 4));
    }
    let a = a0;
    let bb = b0;
    let c = c0;
    let d = d0;
    const step = (
      fn: (xv: number, y: number, z: number) => number,
      kIdx: number, sh: number, extra: number,
    ): void => {
      a = rotl((a + fn(bb, c, d) + (m[kIdx] ?? 0) + extra) >>> 0, sh);
      const t = a; a = d; d = c; c = bb; bb = t;
    };
    // round 1 (no constant), k order 0..15, shifts 3/7/11/19
    const R1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i += 1) {
      step(f, i, R1[i % 4] ?? 0, 0);
    }
    // round 2, k order 0,4,8,12,1,5,9,13,…, shifts 3/5/9/13
    const R2 = [3, 5, 9, 13];
    for (let i = 0; i < 16; i += 1) {
      step(g, (i % 4) * 4 + Math.floor(i / 4), R2[i % 4] ?? 0, 0x5a827999);
    }
    // round 3, k order 0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15, shifts 3/9/11/15
    const R3K = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const R3S = [3, 9, 11, 15];
    for (let i = 0; i < 16; i += 1) {
      step(h, R3K[i] ?? 0, R3S[i % 4] ?? 0, 0x6ed9eba1);
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + bb) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a0, 0);
  out.writeUInt32LE(b0, 4);
  out.writeUInt32LE(c0, 8);
  out.writeUInt32LE(d0, 12);
  return s(out);
}

// ─── RC4 (pure JS; OpenSSL 3 legacy provider) ────────────────────────────────

/** BaseCrypto.RC4 (BaseCrypto.pas:470–489, DCPrc4 Init/Encrypt): textbook
 * KSA + PRGA, no drop-N. '' when s/key empty or key > 256 bytes. */
export function rc4(v: string, key: string): string {
  if (v === '' || key === '' || key.length > 256) {
    return '';
  }
  const k = b(key);
  const data = b(v);
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    sbox[i] = i;
  }
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (sbox[i] ?? 0) + (k[i % k.length] ?? 0)) & 0xff;
    const t = sbox[i] ?? 0;
    sbox[i] = sbox[j] ?? 0;
    sbox[j] = t;
  }
  const out = Buffer.alloc(data.length);
  let i2 = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i2 = (i2 + 1) & 0xff;
    j = (j + (sbox[i2] ?? 0)) & 0xff;
    const t = sbox[i2] ?? 0;
    sbox[i2] = sbox[j] ?? 0;
    sbox[j] = t;
    out[n] = (data[n] ?? 0) ^ (sbox[((sbox[i2] ?? 0) + t) & 0xff] ?? 0);
  }
  return s(out);
}

// ─── PBKDF2 ──────────────────────────────────────────────────────────────────

/** BaseCrypto.PBKDF2SHA256 (BaseCrypto.pas:879–913): standard PBKDF2-HMAC-
 * SHA256 (password as key, salt + big-endian block index as data). '' when
 * password/salt empty or iterations/dkLen < 1. */
export function pbkdf2Sha256(password: string, saltV: string, iterations: number, dkLen: number): string {
  if (password === '' || saltV === '' || iterations < 1 || dkLen < 1) {
    return '';
  }
  return s(pbkdf2Sync(b(password), b(saltV), Math.trunc(iterations), Math.trunc(dkLen), 'sha256'));
}

// ─── AES primitives ──────────────────────────────────────────────────────────

/**
 * TDCP_rijndael.InitKey key normalization (DCPrijndael.pas:135–167 +
 * DCPcrypt2 TDCP_cipher.Init 417–424): key bits must be 1..256 and a
 * multiple of 32 bits (always true for whole bytes); the schedule zero-pads
 * into 16/24/32-byte key words — i.e. len ≤ 16 → AES-128, 17..24 → AES-192,
 * 25..32 → AES-256. A zero-length key raises in Pascal ('' results guard
 * before Init at every BaseCrypto call site).
 */
function normalizeAesKey(key: string): { key: Buffer; algorithm: string } | null {
  const len = key.length;
  if (len < 1 || len > 32) {
    return null; // Pascal raises EDCP_cipher → caught → ''
  }
  const size = len <= 16 ? 16 : len <= 24 ? 24 : 32;
  const out = Buffer.alloc(size);
  b(key).copy(out, 0);
  return { key: out, algorithm: `aes-${size * 8}` };
}

/** DCP InitVector normalization (BaseCrypto fills a zeroed 16-byte array and
 * moves the first bytes of the iv string in — BaseCrypto.pas:214–216 et al). */
function normalizeIv(iv: string): Buffer {
  const out = Buffer.alloc(16);
  b(iv).subarray(0, 16).copy(out, 0);
  return out;
}

/**
 * DCPblockcipher128 CBC (DCPblockciphers.pas:473–547): full 16-byte blocks
 * in standard CBC; a trailing partial block is encrypted/decrypted with
 * E(CV) as keystream (both directions), which node's cbc does NOT do — so
 * CBC is implemented manually over the raw ECB primitive via cbc for full
 * blocks + the DCP partial-block rule. Input '' guards at the caller.
 */
function dcpCbcEncrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const algorithm = `aes-${key.length * 8}-ecb`;
  const ecb = createCipheriv(algorithm, key, null);
  ecb.setAutoPadding(false);
  let cv = Buffer.from(iv);
  const full = Math.floor(data.length / 16);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < full; i += 1) {
    const block = data.subarray(i * 16, i * 16 + 16);
    const xored = Buffer.alloc(16);
    for (let j = 0; j < 16; j += 1) {
      xored[j] = (block[j] ?? 0) ^ (cv[j] ?? 0);
    }
    cv = ecb.update(xored);
    cv.copy(out, i * 16);
  }
  const rem = data.length % 16;
  if (rem !== 0) {
    // DCP: EncryptECB(CV,CV); out = plain xor CV (partial)
    cv = ecb.update(cv);
    for (let j = 0; j < rem; j += 1) {
      out[full * 16 + j] = (data[full * 16 + j] ?? 0) ^ (cv[j] ?? 0);
    }
  }
  return out;
}

function dcpCbcDecrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const dcb = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  dcb.setAutoPadding(false);
  let cv = Buffer.from(iv);
  const full = Math.floor(data.length / 16);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < full; i += 1) {
    const block = data.subarray(i * 16, i * 16 + 16);
    const plain = dcb.update(block);
    for (let j = 0; j < 16; j += 1) {
      out[i * 16 + j] = (plain[j] ?? 0) ^ (cv[j] ?? 0);
    }
    cv = Buffer.from(block);
  }
  const rem = data.length % 16;
  if (rem !== 0) {
    // DCP: EncryptECB(CV,CV); plain = cipher xor CV (partial)
    const ecbE = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
    ecbE.setAutoPadding(false);
    cv = ecbE.update(cv);
    for (let j = 0; j < rem; j += 1) {
      out[full * 16 + j] = (data[full * 16 + j] ?? 0) ^ (cv[j] ?? 0);
    }
  }
  return out;
}

/** BaseCrypto.AESEncryptCBC (BaseCrypto.pas:293–323). */
export function aesEncryptCBC(v: string, key: string, iv: string): string {
  if (v === '' || key === '' || iv === '') {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  return s(dcpCbcEncrypt(b(v), k.key, normalizeIv(iv)));
}

/** BaseCrypto.AESDecryptCBC (BaseCrypto.pas:325–355). */
export function aesDecryptCBC(v: string, key: string, iv: string): string {
  if (v === '' || key === '' || iv === '') {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  return s(dcpCbcDecrypt(b(v), k.key, normalizeIv(iv)));
}

/** BaseCrypto.AESEncryptCFB (BaseCrypto.pas:199–244): full-block CFB
 * (segment 128) — identical to OpenSSL `cfb128` for all outputs (the final
 * shift-register state differs, but is never observable). */
export function aesEncryptCFB(v: string, key: string, iv: string): string {
  return aesStreamCipher(v, key, iv, 'cfb', false);
}

/** BaseCrypto.AESDecryptCFB (BaseCrypto.pas:246–291). */
export function aesDecryptCFB(v: string, key: string, iv: string): string {
  return aesStreamCipher(v, key, iv, 'cfb', true);
}

/** BaseCrypto.AESCTR (BaseCrypto.pas:778–834): full-width big-endian counter
 * — OpenSSL `ctr` semantics. */
export function aesCTR(v: string, key: string, iv: string): string {
  return aesStreamCipher(v, key, iv, 'ctr', false);
}

/** BaseCrypto.AESOFB (BaseCrypto.pas:836–877): OFB-128. */
export function aesOFB(v: string, key: string, iv: string): string {
  return aesStreamCipher(v, key, iv, 'ofb', false);
}

function aesStreamCipher(v: string, key: string, iv: string, mode: 'cfb' | 'ctr' | 'ofb', decrypt: boolean): string {
  if (v === '' || key === '' || iv === '') {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  const algorithm = `${k.algorithm}-${mode}`;
  try {
    if (decrypt) {
      const d = createDecipheriv(algorithm, k.key, normalizeIv(iv));
      d.setAutoPadding(false);
      return s(Buffer.concat([d.update(b(v)), d.final()]));
    }
    const e = createCipheriv(algorithm, k.key, normalizeIv(iv));
    e.setAutoPadding(false);
    return s(Buffer.concat([e.update(b(v)), e.final()]));
  } catch {
    return '';
  }
}

/** BaseCrypto.Pkcs7AddPad (BaseCrypto.pas:127–135): always adds 1..16 bytes. */
function pkcs7AddPad(data: Buffer): Buffer {
  const pad = 16 - (data.length & 15);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

/** BaseCrypto.Pkcs7RemovePad (BaseCrypto.pas:137–141): blind chop of the last
 * byte value — no validation (mirrored; corruption chops garbage). */
function pkcs7RemovePad(data: Buffer): Buffer | null {
  if (data.length === 0) {
    return null; // Pascal reads Result[0] of '' → UB → callers treat as ''
  }
  const chop = data[data.length - 1] ?? 0;
  if (chop > data.length) {
    return null; // SetLength(negative) raises → '' in the Pascal callers
  }
  return data.subarray(0, data.length - chop);
}

/** BaseCrypto.AESEncryptECBPkcs7 (BaseCrypto.pas:716–745). */
export function aesEncryptECBPkcs7(v: string, key: string): string {
  if (v === '' || key === '') {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  try {
    const e = createCipheriv(`${k.algorithm}-ecb`, k.key, null);
    e.setAutoPadding(false);
    const padded = pkcs7AddPad(b(v));
    return s(Buffer.concat([e.update(padded), e.final()]));
  } catch {
    return '';
  }
}

/** BaseCrypto.AESDecryptECBPkcs7 (BaseCrypto.pas:747–776): requires multiple
 * of 16; blind last-byte chop (no pad validation). */
export function aesDecryptECBPkcs7(v: string, key: string): string {
  if (v === '' || key === '' || v.length % 16 !== 0) {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  try {
    const d = createDecipheriv(`${k.algorithm}-ecb`, k.key, null);
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(b(v)), d.final()]);
    const unpadded = pkcs7RemovePad(plain);
    return unpadded === null ? '' : s(unpadded);
  } catch {
    return '';
  }
}

// ─── composed FMD2 variants ──────────────────────────────────────────────────

/**
 * BaseCrypto.AESEncryptCBCSHA256Base64Pkcs7 (BaseCrypto.pas:143–169):
 * guards s/key/iv '' and iv length ≠ 32 chars; key = AES-256 InitStr
 * (SHA256 of the key string); iv = HexToBytes (32 hex chars → 16 bytes,
 * invalid hex raises in Pascal → ''); Pkcs7AddPad + CBC + base64.
 */
export function aesEncryptCBCSHA256Base64Pkcs7(v: string, key: string, iv: string): string {
  if (v === '' || key === '' || iv === '' || iv.length !== 32) {
    return '';
  }
  const ivb = strictHex(iv);
  if (ivb === null) {
    return '';
  }
  const k = sha256(key);
  try {
    const e = createCipheriv('aes-256-cbc', b(k), ivb);
    e.setAutoPadding(false); // Pkcs7AddPad already applied (BaseCrypto.pas:158)
    const padded = pkcs7AddPad(b(v));
    return Buffer.concat([e.update(padded), e.final()]).toString('base64');
  } catch {
    return '';
  }
}

/**
 * BaseCrypto.AESDecryptCBCSHA256Base64Pkcs7 (BaseCrypto.pas:171–197):
 * base64-decode, CBC decrypt with the SHA256-derived key + hex iv, then the
 * blind Pkcs7RemovePad chop.
 */
export function aesDecryptCBCSHA256Base64Pkcs7(v: string, key: string, iv: string): string {
  if (v === '' || key === '' || iv === '' || iv.length !== 32) {
    return '';
  }
  const ivb = strictHex(iv);
  if (ivb === null) {
    return '';
  }
  const data = lenientBase64Decode(v);
  if (data.length === 0) {
    return '';
  }
  const k = sha256(key);
  try {
    const d = createDecipheriv('aes-256-cbc', b(k), ivb);
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(data), d.final()]);
    const unpadded = pkcs7RemovePad(plain);
    return unpadded === null ? '' : s(unpadded);
  } catch {
    return '';
  }
}

/**
 * BaseCrypto.AESDecryptCBCMD5Base64ZerosPadding (BaseCrypto.pas:357–365):
 * base64-decode → AESDecryptCBC with key = MD5Hex(key) (lowercase hex TEXT
 * → AES-128 zero-padded schedule) → strip trailing #0 bytes.
 */
export function aesDecryptCBCMD5Base64ZerosPadding(v: string, key: string, iv: string): string {
  if (v === '' || key === '' || iv === '') {
    return '';
  }
  const data = lenientBase64Decode(v);
  const decrypted = b(aesDecryptCBC(s(data), md5Hex(key), iv));
  let end = decrypted.length;
  while (end > 0 && decrypted[end - 1] === 0) {
    end -= 1;
  }
  return s(decrypted.subarray(0, end));
}

/**
 * BaseCrypto.AESDecryptCBCHexBase64ZerosPadding (BaseCrypto.pas:367–395):
 * key and iv are BOTH hex (iv 32 chars); base64 data; trailing #0 strip.
 */
export function aesDecryptCBCHexBase64ZerosPadding(v: string, key: string, iv: string): string {
  if (v === '' || key === '' || iv === '' || iv.length !== 32) {
    return '';
  }
  const keyBytes = strictHex(key);
  const ivb = strictHex(iv);
  if (keyBytes === null || ivb === null || keyBytes.length < 1) {
    return '';
  }
  const k = normalizeAesKey(s(keyBytes));
  if (k === null) {
    return '';
  }
  const data = lenientBase64Decode(v);
  if (data.length === 0) {
    return '';
  }
  try {
    const plain = dcpCbcDecrypt(data, k.key, ivb);
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) {
      end -= 1;
    }
    return s(plain.subarray(0, end));
  } catch {
    return '';
  }
}

/** Strict hex decode — Pascal HexToBytes raises on invalid hex ('' results). */
function strictHex(h: string): Buffer | null {
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) {
    return null;
  }
  return Buffer.from(h, 'hex');
}

/** FPC base64 unit DecodeStringBase64 is tolerant; '=' characters are
 * position-independent in synacode's table decode — strip them and let
 * node's lenient decoder handle the rest (COMPAT.md base64 note). */
function lenientBase64Decode(v: string): Buffer {
  return Buffer.from(v.replace(/=/g, ''), 'base64');
}

// ─── GCM ─────────────────────────────────────────────────────────────────────

/**
 * BaseCrypto.AESEncryptGCM (BaseCrypto.pas:1061–1129): textbook GCM —
 * ciphertext followed by the 16-byte tag; any IV length (non-12-byte IVs
 * take the J0 = GHASH(H, '', iv) path, which OpenSSL implements per spec).
 */
export function aesEncryptGCM(v: string, key: string, iv: string, aad: string): string {
  if (v === '' || key === '' || iv === '') {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  try {
    const e = createCipheriv(`${k.algorithm}-gcm`, k.key, Buffer.from(iv, 'latin1')) as CipherGCM;
    if (aad !== '') {
      e.setAAD(b(aad));
    }
    const ct = Buffer.concat([e.update(b(v)), e.final()]);
    return s(Buffer.concat([ct, e.getAuthTag()]));
  } catch {
    return '';
  }
}

/** BaseCrypto.AESDecryptGCM (BaseCrypto.pas:1131–1206): last 16 bytes are
 * the tag; verification failure → ''. */
export function aesDecryptGCM(v: string, key: string, iv: string, aad: string): string {
  if (v.length < 16 || key === '' || iv === '') {
    return '';
  }
  const k = normalizeAesKey(key);
  if (k === null) {
    return '';
  }
  const data = b(v);
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  try {
    const d = createDecipheriv(`${k.algorithm}-gcm`, k.key, Buffer.from(iv, 'latin1')) as DecipherGCM;
    d.setAuthTag(tag);
    if (aad !== '') {
      d.setAAD(b(aad));
    }
    return s(Buffer.concat([d.update(ct), d.final()]));
  } catch {
    return '';
  }
}

// ─── EncryptString / DecryptString (uBaseUnit.pas:1556–1589) ─────────────────

/**
 * uBaseUnit EncryptString/DecryptString: TDCP_rijndael.InitStr(EncryptKey,
 * TDCP_sha512) → AES-256 key = SHA512('B74945FB50E84FD58BF9FEAB8E4BEA6B')
 * [first 32 bytes]; Init(…, nil) seeds the DCP default IV = E_K(zero block)
 * (DCPblockciphers.pas:479–491); TDCP_blockcipher.EncryptString = CFB8bit +
 * base64 (DCPcrypt2.pas — the canonical 2.0.4 override). Deterministic.
 */
const ENCRYPT_KEY = 'B74945FB50E84FD58BF9FEAB8E4BEA6B';

let encryptStringKey: Buffer | null = null;
let encryptStringIv: Buffer | null = null;

function encryptStringParams(): { key: Buffer; iv: Buffer } {
  if (encryptStringKey === null || encryptStringIv === null) {
    encryptStringKey = createHash('sha512').update(ENCRYPT_KEY, 'latin1').digest().subarray(0, 32);
    const ecb = createCipheriv('aes-256-ecb', encryptStringKey, null);
    ecb.setAutoPadding(false);
    encryptStringIv = ecb.update(Buffer.alloc(16));
  }
  return { key: encryptStringKey, iv: encryptStringIv };
}

/** uBaseUnit.EncryptString (uBaseUnit.pas:1559–1573): '' for '' input. */
export function encryptString(v: string): string {
  if (v === '') {
    return '';
  }
  const { key, iv } = encryptStringParams();
  const e = createCipheriv('aes-256-cfb8', key, iv);
  return Buffer.concat([e.update(b(v)), e.final()]).toString('base64');
}

/** uBaseUnit.DecryptString (uBaseUnit.pas:1575–1589). */
export function decryptString(v: string): string {
  if (v === '') {
    return '';
  }
  try {
    const { key, iv } = encryptStringParams();
    const data = Buffer.from(v.replace(/=/g, ''), 'base64');
    if (data.length === 0) {
      return '';
    }
    const d = createDecipheriv('aes-256-cfb8', key, iv);
    return s(Buffer.concat([d.update(data), d.final()]));
  } catch {
    return '';
  }
}

// ─── synacode encodings ──────────────────────────────────────────────────────

/** synacode.EncodeBase64 (synacode.pas:713–716, Encode3to4 + TableBase64):
 * standard padded base64. */
export function encodeBase64(v: string): string {
  return b(v).toString('base64');
}

/** synacode.DecodeBase64 (synacode.pas:706–709, Decode4to3Ex): invalid chars
 * (including '=' anywhere) are skipped — strip '=' then let node's lenient
 * decoder handle it (parity with the table walk). */
export function decodeBase64(v: string): string {
  const data = v.replace(/=/g, '');
  if (data.length === 0) {
    return '';
  }
  return s(Buffer.from(data, 'base64'));
}

/** BaseCrypto.EncodeBase64URL (BaseCrypto.pas:915–921). */
export function encodeBase64URL(v: string): string {
  return b(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** BaseCrypto.DecodeBase64URL (BaseCrypto.pas:923–934): restore alphabet,
 * re-pad to a multiple of 4 (2 → '==', 3 → '='), lenient decode. */
export function decodeBase64URL(v: string): string {
  let padded = v.replace(/-/g, '+').replace(/_/g, '/');
  const rem = padded.length % 4;
  if (rem === 2) {
    padded += '==';
  } else if (rem === 3) {
    padded += '=';
  }
  return s(Buffer.from(padded.replace(/=/g, ''), 'base64'));
}

/** synacode.EncodeURL (synacode.pas:547–550 over URLSpecialChar). */
export function encodeURL(v: string): string {
  return encodeTriplet(v, isUrlSpecialChar);
}

/** synacode.EncodeURLElement (synacode.pas:540–543): URLSpecialChar +
 * URLFullSpecialChar. */
export function encodeURLElement(v: string): string {
  return encodeTriplet(v, (code) => isUrlSpecialChar(code) || isUrlFullSpecialChar(code));
}

function isUrlSpecialChar(code: number): boolean {
  // [#0..#32] … wait: Pascal set is [#0..#$20] — bytes 0..32 — then the
  // specials < > " % { } | \ ^ [ ] ` and #$7F..#$FF.
  return code <= 0x20 || code >= 0x7f || '<>"%{}|\\^[]`'.includes(String.fromCharCode(code));
}

function isUrlFullSpecialChar(code: number): boolean {
  return ';/:?@=&#'.includes(String.fromCharCode(code)) && code !== 0;
}

function encodeTriplet(v: string, specials: (code: number) => boolean): string {
  const data = b(v);
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    if (specials(byte)) {
      parts.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    } else {
      parts.push(String.fromCharCode(byte));
    }
  }
  return parts.join('');
}

/** synacode.DecodeURL (synacode.pas:485–488 → DecodeTriplet '%', 403–474):
 * '%' + CRLF/LF/CR is dropped; bad hex keeps the literal '%'; trailing '%'
 * (delimiter is the last char) breaks the loop dropping it. */
export function decodeURL(v: string): string {
  const data = b(v);
  const out: number[] = [];
  let x = 0;
  const lv = data.length;
  while (x < lv) {
    const c = data[x] ?? 0;
    x += 1;
    if (c !== 0x25 /* '%' */) {
      out.push(c);
      continue;
    }
    // Pascal: `if x < lv then decode-case else break` with x 1-based at the
    // char after '%' — breaks when that char is the LAST one (its digit
    // pair cannot complete), dropping '%' and the digit.
    if (x >= lv - 1) {
      break;
    }
    const n1 = data[x] ?? 0;
    if (n1 === 13 /* CR */) {
      x += (data[x + 1] ?? 0) === 10 ? 2 : 1;
      continue;
    }
    if (n1 === 10 /* LF */) {
      x += (data[x + 1] ?? 0) === 13 ? 2 : 1;
      continue;
    }
    const hi = hexDigit(n1);
    const lo = hexDigit(data[x + 1] ?? 0); // past-end → -1 → bad (Pascal reads past too)
    if (hi < 0 || lo < 0) {
      out.push(c); // literal '%'
      continue;
    }
    out.push(((hi << 4) | lo) & 0xff);
    x += 2;
  }
  return s(Buffer.from(out));
}

// ─── UU (synacode TableUU) ───────────────────────────────────────────────────

const TABLE_UU = '`!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_';

/** synacode.EncodeUU (synacode.pas:767–772): length byte (TableUU[len+1])
 * + Encode3to4 with TableUU — NO '=' padding (TableUU has 64 chars; the
 * $40 slots fall off the table). Only encodes lines shorter than 64. */
export function encodeUU(v: string): string {
  if (v.length >= TABLE_UU.length) {
    return '';
  }
  const data = b(v);
  let out = TABLE_UU[data.length] ?? '';
  for (let i = 0; i < data.length; i += 3) {
    const c0 = data[i] ?? 0;
    const has1 = i + 1 < data.length;
    const has2 = i + 2 < data.length;
    const c1 = has1 ? (data[i + 1] ?? 0) : 0;
    const c2 = has2 ? (data[i + 2] ?? 0) : 0;
    // Encode3to4 (synacode.pas:653–702) with no padding table entries:
    // DOut[3] = $40 when a byte is missing → skipped (TableUU too short).
    out += TABLE_UU[(c0 & 0xfc) >> 2] ?? '';
    out += TABLE_UU[((c0 & 0x03) << 4) | ((has1 ? (c1 & 0xf0) >> 4 : 0) & 0x0f)] ?? '';
    if (has1) {
      out += TABLE_UU[((c1 & 0x0f) << 2) | (has2 ? (c2 & 0xc0) >> 6 : 0)] ?? '';
      if (has2) {
        out += TABLE_UU[c2 & 0x3f] ?? '';
      }
    }
  }
  return out;
}

/** synacode.DecodeUU (synacode.pas:734–763): length byte → line length via
 * the mod-3 table, Copy 2.., space-pad, Decode4to3 (misses → 0). */
export function decodeUU(v: string): string {
  const trimmed = v.trim().toUpperCase();
  if (trimmed === '') {
    return '';
  }
  if (trimmed.startsWith('BEGIN') || trimmed.startsWith('END') || trimmed.startsWith('TABLE')) {
    return '';
  }
  const lenIdx = TABLE_UU.indexOf(String.fromCharCode(b(v)[0] ?? 0));
  if (lenIdx < 0) {
    return ''; // Pascal Pos → 0 → x = -1 → garbage; treat as empty
  }
  let x = lenIdx;
  switch (x % 3) {
    case 0: x = (x / 3) * 4; break;
    case 1: x = ((x / 3) | 0) * 4 + 2; break;
    default: x = ((x / 3) | 0) * 4 + 3; break;
  }
  const raw = b(v).subarray(1, 1 + x);
  if (raw.length === 0) {
    return '';
  }
  // pad with spaces to x (Decode4to3 maps unknown chars — space included —
  // to table position 0 = byte 0)
  const padded = Buffer.alloc(x);
  raw.copy(padded, 0);
  let out = Buffer.alloc(0);
  for (let i = 0; i < x; i += 4) {
    const d: number[] = [];
    for (let n = 0; n < 4; n += 1) {
      const pos = TABLE_UU.indexOf(String.fromCharCode(padded[i + n] ?? 0));
      d.push(pos < 0 ? 0 : pos);
    }
    const chunk = Buffer.from([((d[0] ?? 0) & 0x3f) << 2 | ((d[1] ?? 0) & 0x30) >> 4]);
    out = Buffer.concat([out, chunk]);
    if (d[2] !== 64) {
      out = Buffer.concat([out, Buffer.from([((d[1] ?? 0) & 0x0f) << 4 | ((d[2] ?? 0) & 0x3c) >> 2])]);
      if (d[3] !== 64) {
        out = Buffer.concat([out, Buffer.from([((d[2] ?? 0) & 0x03) << 6 | ((d[3] ?? 0) & 0x3f)])]);
      }
    }
  }
  return s(out);
}

// ─── HTML encode/decode ──────────────────────────────────────────────────────

/**
 * LuaCrypto.HTMLEncode → htmlelements.EscapeHTML. The htmlelements unit is
 * a third-party FMD2 dependency not present in this source snapshot — the
 * canonical Pascal escape set (& < > ") is implemented; corpus module runs
 * are the ground truth (COMPAT.md "HTMLEncode").
 */
export function htmlEncode(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * LuaCrypto.HTMLDecode → uBaseUnit.HTMLDecode (uBaseUnit.pas:1312–1383):
 * &amp; &lt; &gt; &nbsp; &quot; &#N; ONLY. Any other '&' + letter ENTITY
 * (e.g. &hellip;) hits `else Exit` — the string is TRUNCATED at the '&'.
 * '&' + an unmatched 'a'/'l'/'g'/'n'/'q' head (e.g. &laquo;) skips both
 * chars with the output position unwritten (Pascal reads uninitialized
 * memory — modeled as nothing emitted). '#N' parses decimal; Chr(N) with
 * N > 255 raises in Pascal → truncation (mirrored).
 */
export function htmlDecode(v: string): string {
  const data = b(v);
  const out: number[] = [];
  let sp = 0;
  // Pascal walks with PChar (`while Sp^ <> #0`) — an embedded NUL byte
  // terminates the scan early; mirrored.
  while (sp < data.length && data[sp] !== 0) {
    const c = data[sp] ?? 0;
    if (c !== 0x26 /* '&' */) {
      out.push(c);
      sp += 1;
      continue;
    }
    sp += 1;
    const head = sp < data.length ? String.fromCharCode(data[sp] ?? 0) : '';
    switch (head) {
      case 'a': {
        if (startsWithAt(data, sp, 'amp;')) {
          sp += 3;
          out.push(0x26);
        }
        break; // unmatched '&a…': both chars skipped, nothing written
      }
      case 'l':
      case 'g': {
        const isLt = startsWithAt(data, sp, 'lt;');
        const isGt = startsWithAt(data, sp, 'gt;');
        if (isLt || isGt) {
          sp += 2;
          while (sp < data.length && data[sp] !== 0x3b) {
            sp += 1;
          }
          out.push(isLt ? 0x3c : 0x3e);
        }
        break;
      }
      case 'n': {
        if (startsWithAt(data, sp, 'nbsp;')) {
          sp += 4;
          out.push(0x20);
        }
        break;
      }
      case 'q': {
        if (startsWithAt(data, sp, 'quot;')) {
          sp += 4;
          out.push(0x22);
        }
        break;
      }
      case '#': {
        const tp = sp + 1;
        while (sp < data.length && data[sp] !== 0x3b) {
          sp += 1;
        }
        const digits = data.subarray(tp, sp).toString('latin1').trim();
        const code = /^\d+$/.test(digits) ? Number(digits) : NaN;
        if (!Number.isFinite(code) || code > 255) {
          return s(Buffer.from(out)); // Pascal Chr(N) range error → Exit
        }
        out.push(code);
        break;
      }
      default:
        return s(Buffer.from(out)); // Pascal `else Exit` truncation
    }
    sp += 1;
  }
  return s(Buffer.from(out));
}

function startsWithAt(data: Buffer, at: number, text: string): boolean {
  if (at + text.length > data.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (data[at + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

// ─── EC + secret stream (sodium / node backends) ─────────────────────────────

/** BaseCrypto.X25519_PublicKey (BaseCrypto.pas:1523–1541). */
export function x25519PublicKey(privKey: string): string {
  const sodium = loadSodium();
  if (sodium === null || privKey.length !== 32) {
    return '';
  }
  const out = Buffer.alloc(32);
  sodium.crypto_scalarmult_base(out, b(privKey));
  return s(out);
}

/** BaseCrypto.X25519_SharedSecret (BaseCrypto.pas:1543–1577). */
export function x25519SharedSecret(privKey: string, pubKey: string): string {
  const sodium = loadSodium();
  if (sodium === null || privKey.length !== 32 || pubKey.length !== 32) {
    return '';
  }
  const out = Buffer.alloc(32);
  try {
    sodium.crypto_scalarmult(out, b(privKey), b(pubKey));
  } catch {
    return '';
  }
  return s(out);
}

/** BaseCrypto.P256_PublicKey (BaseCrypto.pas:1633–1651): raw 32-byte scalar
 * → 65-byte uncompressed point (node ECDH — libsodium has no P-256). */
export function p256PublicKey(privKey: string): string {
  if (privKey.length !== 32) {
    return '';
  }
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(b(privKey));
    const pub = ecdh.getPublicKey();
    return pub.length === 65 ? s(pub) : '';
  } catch {
    return '';
  }
}

/** BaseCrypto.P256_SharedSecret (BaseCrypto.pas:1653–1684): ECDH over the
 * raw 65-byte uncompressed point → 32-byte X coordinate. */
export function p256SharedSecret(privKey: string, pubKey: string): string {
  if (privKey.length !== 32 || pubKey.length !== 65 || pubKey[0] !== '\u0004') {
    return '';
  }
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(b(privKey));
    const secret = ecdh.computeSecret(b(pubKey));
    return secret.length === 32 ? s(secret) : '';
  } catch {
    return '';
  }
}

/** BaseCrypto.P256_GenerateKeyPair (BaseCrypto.pas:1686–1727): raw 32-byte
 * private + 65-byte uncompressed public; `false` mirrors the Pascal false
 * (zero Lua returns). */
export function p256GenerateKeyPair(): [string, string] | false {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const priv = ecdh.getPrivateKey();
    const pub = ecdh.getPublicKey();
    if (priv.length === 32 && pub.length === 65) {
      return [s(priv), s(pub)];
    }
    return false;
  } catch {
    return false;
  }
}

// ─── SecretStream (pull-side only, libsodium format) ─────────────────────────

/**
 * BaseCrypto.SecretStream_InitPull (BaseCrypto.pas:1747–1766): header 24
 * bytes + key 32 bytes; the opaque 76-byte Pascal state (HChaCha20-derived
 * subkey + nonce + pad) is carried as an opaque token string — the Lua
 * caller treats it opaquely in both implementations (COMPAT.md
 * "SecretStream state token"). `null` mirrors the Pascal nil.
 */
export function secretStreamInitPull(header: string, key: string): string | null {
  const sodium = loadSodium();
  if (sodium === null || header.length !== 24 || key.length !== 32) {
    return null;
  }
  const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
  sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, b(header), b(key));
  return state.toString('base64'); // opaque token (ASCII → byte-safe)
}

/** BaseCrypto.SecretStream_Pull (BaseCrypto.pas:1768–1827): `false` mirrors
 * the Pascal False (zero Lua returns); success returns [state, msg, tag]. */
export function secretStreamPull(stateToken: string, chunk: string): [string, string, number] | false {
  const sodium = loadSodium();
  if (sodium === null || chunk.length < 17 || stateToken === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(stateToken)) {
    return false;
  }
  const state = Buffer.from(stateToken, 'base64');
  if (state.length !== sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES) {
    return false;
  }
  const msg = Buffer.alloc(Math.max(0, chunk.length - 17));
  const tag = Buffer.alloc(1);
  try {
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
      state, msg, tag, b(chunk), Buffer.alloc(0),
    );
    if (result < 0) {
      return false;
    }
  } catch {
    return false;
  }
  return [state.toString('base64'), s(msg), tag[0] ?? 0];
}

// ─── sodium loader ───────────────────────────────────────────────────────────

/** Sodium-native module surface used by this shim. */
type SodiumModule = {
  crypto_scalarmult(out: Buffer, n: Buffer, p: Buffer): number;
  crypto_scalarmult_base(out: Buffer, n: Buffer): number;
  crypto_secretstream_xchacha20poly1305_STATEBYTES: number;
  crypto_secretstream_xchacha20poly1305_init_pull(state: Buffer, header: Buffer, k: Buffer): void;
  crypto_secretstream_xchacha20poly1305_pull(
    state: Buffer, m: Buffer, tag: Buffer, c: Buffer, ad: Buffer | null,
  ): number;
};

let sodiumModule: SodiumModule | null | undefined;

/**
 * Lazy sodium-native loader (test-guarded: COMPAT.md "sodium-native").
 * Returns null when the native module cannot load — X25519/SecretStream
 * then behave exactly like the Pascal OpenSSL-failure paths (''/nil/false).
 */
export function loadSodium(): SodiumModule | null {
  if (sodiumModule !== undefined) {
    return sodiumModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require('sodium-native') as unknown as SodiumModule;
    sodiumModule = typeof required.crypto_scalarmult === 'function' &&
      typeof required.crypto_secretstream_xchacha20poly1305_init_pull === 'function'
      ? required
      : null;
  } catch {
    sodiumModule = null;
  }
  return sodiumModule;
}

/** Test/ops probe: whether the sodium backend is available in this runtime. */
export function sodiumAvailable(): boolean {
  return loadSodium() !== null;
}
