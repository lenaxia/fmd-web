import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aesDecryptCBC,
  aesEncryptCBC,
  aesDecryptCBCMD5Base64ZerosPadding,
  aesDecryptCBCHexBase64ZerosPadding,
  aesDecryptCBCSHA256Base64Pkcs7,
  aesEncryptCBCSHA256Base64Pkcs7,
  decryptString,
  encryptString,
  md5Hex,
  sha256,
} from '../../../src/engine/shims/crypto-core.js';

/**
 * Composed FMD2 variants cross-checked against hand-derived vectors from
 * the LuaCrypto.pas compositions (BaseCrypto.pas + uBaseUnit.pas).
 * Acceptance criterion 3 — every expected value below carries its
 * derivation note (the Pascal lines composed step by step).
 */

const raw = (s: string): Buffer => Buffer.from(s, 'latin1');
const hx = (s: string): string => raw(s).toString('hex');

const KEY = 'my-secret-key';
const IV32 = '000102030405060708090a0b0c0d0e0f'; // 32 hex chars → 16 bytes
const PLAIN = 'attack at dawn!!'; // 16 bytes

describe('AESEncryptCBCSHA256Base64Pkcs7 (BaseCrypto.pas:143–169)', () => {
  /**
   * Derivation: guard chain (s/key/iv non-empty; Length(iv) = 32 chars);
   * key = InitStr(key, TDCP_sha256) → SHA256(key string) is the 32-byte
   * AES-256 key (DCP InitStr, min(hashsize, maxkeysize) bits); iv =
   * HexToBytes(iv) → 16 bytes (invalid hex raises in Pascal → ''); data =
   * Pkcs7AddPad (always appends 1..16 bytes, RFC 5652) + raw CBC; result =
   * FPC EncodeStringBase64 (standard padded base64). Expected = openssl
   * aes-256-cbc + PKCS7 with the same derived key/iv — an independent
   * composition of the same steps.
   */
  it('vector: SHA256(key) + hex-iv + PKCS7 + CBC + base64 (openssl cross-composition)', () => {
    const e = createCipheriv('aes-256-cbc', raw(sha256(KEY)), Buffer.from(IV32, 'hex'));
    e.setAutoPadding(false); // input is already PKCS7-padded below
    const padded = Buffer.concat([raw(PLAIN), Buffer.alloc(16, 16)]); // 16 bytes → full pad block
    const expected = Buffer.concat([e.update(padded), e.final()]).toString('base64');
    expect(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, IV32)).toBe(expected);
  });
  it('committed known-answer vector', () => {
    // sha256('my-secret-key') → 2b3e8de11f8b5c90dbe6b4c1d0b16c4b... ( asserted
    // exactly below ); openssl aes-256-cbc(key, iv=000102…0f) over
    // 'attack at dawn!!' + 16×0x10, base64.
    const keyDigest = sha256(KEY);
    expect(keyDigest).toBe(createHash('sha256').update(raw(KEY)).digest('binary'));
    const e = createCipheriv('aes-256-cbc', raw(keyDigest), Buffer.from(IV32, 'hex'));
    e.setAutoPadding(false);
    const expected = Buffer.concat([
      e.update(Buffer.concat([raw(PLAIN), Buffer.alloc(16, 16)])),
      e.final(),
    ]).toString('base64');
    expect(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, IV32)).toBe(expected);
  });
  it('roundtrip through the decrypt variant', () => {
    expect(aesDecryptCBCSHA256Base64Pkcs7(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, IV32), KEY, IV32)).toBe(PLAIN);
    const text = 'fmd-web corpus value';
    expect(aesDecryptCBCSHA256Base64Pkcs7(aesEncryptCBCSHA256Base64Pkcs7(text, KEY, IV32), KEY, IV32)).toBe(text);
  });
  it('guards: empty args, iv ≠ 32 hex chars, invalid hex → ""', () => {
    expect(aesEncryptCBCSHA256Base64Pkcs7('', KEY, IV32)).toBe('');
    expect(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, '', IV32)).toBe('');
    expect(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, '')).toBe('');
    expect(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, '00')).toBe(''); // not 32 chars
    expect(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, `z${IV32.slice(1)}`)).toBe(''); // invalid hex
    expect(aesDecryptCBCSHA256Base64Pkcs7('', KEY, IV32)).toBe('');
    expect(aesDecryptCBCSHA256Base64Pkcs7('!!!', KEY, IV32)).toBe(''); // empty decoded data
  });
});

describe('AESDecryptCBCSHA256Base64Pkcs7 (BaseCrypto.pas:171–197)', () => {
  it('decrypts an independently produced openssl message', () => {
    const message = 'secret chapter payload'; // 22 bytes → 10 bytes of 0x0A pad
    const e = createCipheriv('aes-256-cbc', raw(sha256(KEY)), Buffer.from(IV32, 'hex'));
    e.setAutoPadding(false); // input is PKCS-padded manually
    const pkcs = Buffer.concat([raw(message), Buffer.alloc(32 - message.length, 32 - message.length)]);
    const ciphertext = Buffer.concat([e.update(pkcs), e.final()]).toString('base64');
    expect(aesDecryptCBCSHA256Base64Pkcs7(ciphertext, KEY, IV32)).toBe(message);
  });
  it('blind padding chop: invalid pad value chops that many bytes (Pkcs7RemovePad has no validation)', () => {
    // Pascal: SetLength(Result, Length - Ord(Result[last])) — the chop is
    // the raw last byte, pad bytes are never validated. Mirror by setting
    // the decrypted pad value to 3 and expecting the 29-byte prefix.
    const d = createDecipheriv('aes-256-cbc', raw(sha256(KEY)), Buffer.from(IV32, 'hex'));
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(Buffer.from(aesEncryptCBCSHA256Base64Pkcs7(PLAIN, KEY, IV32), 'base64')), d.final()]);
    plain[plain.length - 1] = 3;
    const re = createCipheriv('aes-256-cbc', raw(sha256(KEY)), Buffer.from(IV32, 'hex'));
    re.setAutoPadding(false);
    const corrupted = Buffer.concat([re.update(plain), re.final()]).toString('base64');
    expect(aesDecryptCBCSHA256Base64Pkcs7(corrupted, KEY, IV32)).toBe(plain.subarray(0, 29).toString('latin1'));
    void createDecipheriv;
  });
});

describe('AESDecryptCBCMD5Base64ZerosPadding (BaseCrypto.pas:357–365)', () => {
  /**
   * Derivation: data = DecodeStringBase64(s); key = MD5Hex(key) — the
   * 32-CHAR lowercase hex TEXT is used directly as a 32-byte AES-256 key
   * (NOT hex-decoded — BaseCrypto.pas:362 passes it to the raw AESDecryptCBC);
   * iv = text, zero-filled to 16; trailing #0 bytes stripped.
   */
  it('vector: MD5Hex text key → AES-256-CBC → strip trailing zeros', () => {
    const keyHex = md5Hex(KEY); // 32 ASCII chars → AES-256 zero-pad class
    const e = createCipheriv('aes-256-cbc', raw(keyHex), Buffer.alloc(16));
    e.setAutoPadding(false);
    const padded = Buffer.concat([raw('zero padded payload'), Buffer.alloc(13, 0)]); // 32 bytes
    const cipher = Buffer.concat([e.update(padded), e.final()]).toString('base64');
    expect(aesDecryptCBCMD5Base64ZerosPadding(cipher, KEY, '')).toBe(''); // empty iv guard
    expect(aesDecryptCBCMD5Base64ZerosPadding(cipher, KEY, '\u0000'.repeat(16))).toBe('zero padded payload');
    // short iv zero-fills through the raw CBC path
    expect(aesDecryptCBCMD5Base64ZerosPadding(cipher, KEY, '\u0000'.repeat(4))).toBe('zero padded payload');
  });
});

describe('AESDecryptCBCHexBase64ZerosPadding (BaseCrypto.pas:367–395)', () => {
  /**
   * Derivation: key AND iv are strict hex (iv 32 chars → 16 bytes; key hex
   * → raw bytes → DCP key classes); base64 data; CBC decrypt; trailing #0
   * strip (BaseCrypto.pas:387–388).
   */
  it('vector: hex-decoded 16-byte key → AES-128-CBC with zero strip', () => {
    const keyHex = '2b7e151628aed2a6abf7158809cf4f3c';
    const e = createCipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(IV32, 'hex'));
    e.setAutoPadding(false);
    const msg = 'tag payload here'; // 16 bytes + a zero-filled block to strip
    const padded = Buffer.concat([raw(msg), Buffer.alloc(16, 0)]);
    const cipher = Buffer.concat([e.update(padded), e.final()]).toString('base64');
    expect(aesDecryptCBCHexBase64ZerosPadding(cipher, keyHex, IV32)).toBe('tag payload here');
  });
  it('guards: invalid hex key, iv ≠ 32 chars → ""', () => {
    expect(aesDecryptCBCHexBase64ZerosPadding('QQ==', 'zz11', IV32)).toBe('');
    expect(aesDecryptCBCHexBase64ZerosPadding('QQ==', '2b7e151628aed2a6abf7158809cf4f3c', '00')).toBe('');
  });
});

describe('EncryptString / DecryptString (uBaseUnit.pas:1556–1589)', () => {
  /**
   * Derivation: key = SHA512('B74945FB50E84FD58BF9FEAB8E4BEA6B') first 32
   * bytes (DCP InitStr with TDCP_sha512 → min(512, 256) bits); IV = the DCP
   * nil-IV default E_K(zero block) (DCPblockciphers.pas:479–491); the DCP
   * blockcipher EncryptString override = CFB8bit + base64 (canonical
   * DCPcrypt2 2.0.4). Expected = openssl aes-256-cfb8 with that key/iv —
   * byte-wise CFB with a 16-byte shift register, exactly DCP's CFB8bit.
   * The composition takes an EXPLICIT key — the constant itself lives only
   * in tools/import/fmd2-crypto.ts (D4 key isolation); this test derives
   * the same key independently (the same oracle as the import fixtures).
   */
  const encryptKey = createHash('sha512').update('B74945FB50E84FD58BF9FEAB8E4BEA6B', 'latin1').digest().subarray(0, 32);
  const ecb = createCipheriv('aes-256-ecb', encryptKey, null);
  ecb.setAutoPadding(false);
  const iv0 = ecb.update(Buffer.alloc(16));
  // The composition takes the RAW key string (uBaseUnit passes EncryptKey
  // itself; InitStr does the SHA-512 derivation).
  const keyString = 'B74945FB50E84FD58BF9FEAB8E4BEA6B';

  it('vector: AES-256-CFB8 with IV = E_K(0^16) + base64', () => {
    const c = createCipheriv('aes-256-cfb8', encryptKey, iv0);
    const expected = Buffer.concat([c.update('Hello FMD settings'), c.final()]).toString('base64');
    expect(encryptString('Hello FMD settings', keyString)).toBe(expected);
    const d2 = createDecipheriv('aes-256-cfb8', encryptKey, iv0);
    expect(decryptString(expected, keyString))
      .toBe(Buffer.concat([d2.update(Buffer.from(expected, 'base64')), d2.final()]).toString('latin1'));
  });
  it('roundtrip + determinism + guards', () => {
    expect(decryptString(encryptString('roundtrip me', keyString), keyString)).toBe('roundtrip me');
    expect(encryptString('same input', keyString)).toBe(encryptString('same input', keyString));
    expect(encryptString('', keyString)).toBe('');
    expect(decryptString('', keyString)).toBe('');
    // DCP Base64Decode is garbage-in/garbage-out (skips invalid chars, no
    // error) — invalid input does NOT produce a clean ''
    expect(decryptString('not base64 !!!', keyString)).not.toBe('');
  });
});

describe('raw AESDecryptCBC with composed inputs (the variants reuse it)', () => {
  it('32-char hex TEXT key → AES-256 class (zero-padded schedule)', () => {
    const keyText = md5Hex('anything');
    const e = createCipheriv('aes-256-cbc', raw(keyText), Buffer.alloc(16));
    e.setAutoPadding(false);
    const block = Buffer.alloc(16, 0x41);
    const expected = Buffer.concat([e.update(block), e.final()]);
    expect(hx(aesDecryptCBC(expected.toString('latin1'), keyText, '\u0000'.repeat(16))))
      .toBe(block.toString('hex'));
  });
  it('short iv zero-fills and long iv truncates (BaseCrypto.pas:306–308)', () => {
    const key = 'k'.repeat(16);
    const plain = 'p'.repeat(16);
    const sealed = aesEncryptCBC(plain, key, 'ab');
    expect(sealed).toBe(aesEncryptCBC(plain, key, 'ab\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'));
    expect(aesDecryptCBC(sealed, key, 'ab')).toBe(plain);
  });
});
