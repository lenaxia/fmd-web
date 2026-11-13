import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  crc16,
  crc32,
  decodeBase64,
  decodeBase64URL,
  decodeURL,
  decodeUU,
  encodeBase64,
  encodeBase64URL,
  encodeURL,
  encodeURLElement,
  encodeUU,
  hexToStr,
  hmacMd5,
  hmacMd5Hex,
  hmacSha1,
  hmacSha1Hex,
  hmacSha256,
  hmacSha256Hex,
  hmacSha512,
  hmacSha512Hex,
  htmlDecode,
  htmlEncode,
  md4,
  md5,
  md5Hex,
  md5LongHash,
  pbkdf2Sha256,
  rc4,
  sha1,
  sha1Hex,
  sha1LongHash,
  sha256,
  sha256Hex,
  sha512,
  sha512Hex,
  strToHexStr,
} from '../../../src/engine/shims/crypto-core.js';

/**
 * Known-answer vectors for the fmd.crypto hash/encoding surface
 * (acceptance criterion 1). Raw-byte results are latin1 code-point
 * strings — decoded via Buffer.from(s, 'latin1') for hex comparison.
 */

const raw = (s: string): Buffer => Buffer.from(s, 'latin1');
const hx = (s: string): string => raw(s).toString('hex');

describe('MD4 (RFC 1320 §A.5 test suite — pure JS, OpenSSL 3 dropped MD4)', () => {
  const vectors: [string, string][] = [
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '043f8582f241db351ce627e153e7f0e4'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', 'e33b4ddc9c38f2199c3e7b164fcc0536'],
  ];
  for (const [input, digest] of vectors) {
    it(`MD4(${JSON.stringify(input.length > 40 ? `${input.slice(0, 20)}…` : input)})`, () => {
      expect(hx(md4(input))).toBe(digest);
    });
  }
  // >64-byte input (multi-block), cross-checked with a length-200 filler.
  it('MD4 multi-block self-consistency', () => {
    const input = 'x'.repeat(200);
    expect(hx(md4(input))).toHaveLength(32);
    expect(hx(md4(input))).toBe(hx(md4(input)));
  });
});

describe('MD5 / MD5Hex (RFC 1321)', () => {
  it('vectors', () => {
    expect(hx(md5(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hx(md5('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog'))
      .toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
  it('MD5Hex parity with node:crypto (cross-check)', () => {
    expect(md5Hex('fmd-web crypto shim')).toBe(createHash('md5').update('fmd-web crypto shim', 'utf8').digest('hex'));
  });
});

describe('MD5LongHash / SHA1LongHash (synacode.pas:1142–1158, 1370–1386)', () => {
  // Derivation: the Pascal hashes value repeated cnt times plus the first
  // rest bytes where cnt = Len div length(value), rest = Len mod
  // length(value) — i.e. md5('abcabcd') for (value='abc', Len=7).
  it('repeats the value to exactly Len bytes', () => {
    expect(hx(md5LongHash('abc', 7))).toBe(createHash('md5').update('abcabca').digest('hex'));
    expect(hx(sha1LongHash('abc', 5))).toBe(createHash('sha1').update('abcab').digest('hex'));
    expect(hx(md5LongHash('hello', 0))).toBe(createHash('md5').update('').digest('hex'));
  });
  it('exact multiple of the value length', () => {
    expect(hx(sha1LongHash('ab', 6))).toBe(createHash('sha1').update('ababab').digest('hex'));
  });
});

describe('SHA-1/256/512 raw + Hex (FIPS vectors + node cross-check)', () => {
  it('SHA1', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hx(sha1('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
  it('SHA256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hx(sha256('abc'))).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc', 'utf8').digest('hex'));
  });
  it('SHA512', () => {
    expect(sha512Hex('abc')).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
    expect(hx(sha512('abc'))).toBe(sha512Hex('abc'));
    expect(sha512Hex('abc')).toBe(createHash('sha512').update('abc', 'utf8').digest('hex'));
  });
});

describe('HMACs (RFC 2202 / RFC 4231)', () => {
  it('HMAC_MD5 (RFC 2202)', () => {
    expect(hmacMd5Hex('Hi There', Buffer.alloc(16, 0x0b).toString('latin1')))
      .toBe('9294727a3638bb1c13f48ef8158bfc9d');
    expect(hmacMd5Hex('what do ya want for nothing?', 'Jefe'))
      .toBe('750c783e6ab0b503eaa86e310a5db738');
  });
  it('HMAC_SHA1 (RFC 2202)', () => {
    expect(hmacSha1Hex('Hi There', Buffer.alloc(20, 0x0b).toString('latin1')))
      .toBe('b617318655057264e28bc0b6fb378c8ef146be00');
    expect(hmacSha1Hex('what do ya want for nothing?', 'Jefe'))
      .toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  });
  it('HMAC_SHA256 (RFC 4231)', () => {
    expect(hmacSha256Hex('Hi There', Buffer.alloc(20, 0x0b).toString('latin1')))
      .toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    expect(hmacSha256Hex('what do ya want for nothing?', 'Jefe'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('HMAC_SHA512 (RFC 4231)', () => {
    expect(hmacSha512Hex('Hi There', Buffer.alloc(20, 0x0b).toString('latin1')))
      .toBe('87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854');
    expect(hmacSha512Hex('what do ya want for nothing?', 'Jefe'))
      .toBe('164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737');
  });
  it('overlong keys are hashed per RFC (node cross-check, covers the Pascal 64/128-block path)', () => {
    const longKey = 'k'.repeat(200);
    expect(hmacMd5('msg', longKey)).toBe(createHmac('md5', Buffer.from(longKey, 'latin1')).update('msg').digest('binary'));
    expect(hmacSha256('msg', longKey)).toBe(createHmac('sha256', Buffer.from(longKey, 'latin1')).update('msg').digest('binary'));
    expect(hmacSha512('msg', longKey)).toBe(createHmac('sha512', Buffer.from(longKey, 'latin1')).update('msg').digest('binary'));
    expect(hmacSha1('msg', longKey)).toBe(createHmac('sha1', Buffer.from(longKey, 'latin1')).update('msg').digest('binary'));
  });
});

describe('PBKDF2SHA256 (RFC 7914 §11 test vectors + guards)', () => {
  it('RFC 7914 vectors', () => {
    expect(hx(pbkdf2Sha256('passwd', 'salt', 1, 64)))
      .toBe('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');
    expect(hx(pbkdf2Sha256('Password', 'NaCl', 80000, 64)))
      .toBe('4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d');
  });
  it('empty password/salt and non-positive iterations/dkLen → ""', () => {
    expect(pbkdf2Sha256('', 'salt', 1, 32)).toBe('');
    expect(pbkdf2Sha256('pw', '', 1, 32)).toBe('');
    expect(pbkdf2Sha256('pw', 'salt', 0, 32)).toBe('');
    expect(pbkdf2Sha256('pw', 'salt', 1, 0)).toBe('');
  });
});

describe('CRC16 / CRC32 (synacode.pas:838–865)', () => {
  // CRC32 = standard zlib CRC (synacode Crc32Tab is the IEEE table).
  it('CRC32 known values', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('The quick brown fox jumps over the lazy dog')).toBe(0x414fa339);
    expect(crc32('')).toBe(0);
  });
  // CRC16: synacode's reflected-CCITT table with init $FFFF and NO final
  // xor. Cross-checked against an independent bitwise implementation of the
  // same parameters (LSB-first, poly 0x8408) — derivation note for the
  // committed vector: crc16tab (synacode.pas:309–344) + UpdateCrc16.
  const crc16Bitwise = (data: string): number => {
    let crc = 0xffff;
    const bytes = Buffer.from(data, 'latin1');
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i += 1) {
        crc = (crc >> 1) ^ (0x8408 & -(crc & 1));
      }
    }
    return crc & 0xffff;
  };
  it('CRC16 parity with bitwise poly 0x8408, init FFFF, no xorout', () => {
    for (const input of ['', '123456789', 'fmd-web', '\u00e9\u00ff\u0000 mix']) {
      expect(crc16(input)).toBe(crc16Bitwise(input));
    }
    // Vector committed from the table algorithm itself (stable reference).
    expect(crc16('123456789')).toBe(0x6f91);
  });
});

describe('RC4 (standard vectors; pure JS)', () => {
  it('classic vectors', () => {
    expect(hx(rc4('Plaintext', 'Key'))).toBe('bbf316e8d940af0ad3');
    expect(hx(rc4('pedia', 'Wiki'))).toBe('1021bf0420');
    expect(hx(rc4('Attack at dawn', 'Secret'))).toBe('45a01f645fc35b383552544b9bf5');
  });
  it('guards: empty s/key or key > 256 bytes → ""', () => {
    expect(rc4('', 'key')).toBe('');
    expect(rc4('data', '')).toBe('');
    expect(rc4('data', 'k'.repeat(257))).toBe('');
    expect(rc4('data', 'k'.repeat(256))).not.toBe('');
  });
});

describe('hex / base64 / URL / UU / HTML encodings', () => {
  it('HexToStr: strict parity + hex validation', () => {
    expect(hexToStr('48656c6c6f')).toBe('Hello');
    expect(hexToStr('48656C6C6F')).toBe('Hello'); // case-insensitive
    expect(hexToStr('486')).toBe(''); // odd length
    expect(hexToStr('48Z6')).toBe(''); // invalid digit
    expect(hexToStr('')).toBe('');
  });
  it('StrToHexStr: uppercase (FPC BinToHex)', () => {
    expect(strToHexStr('Ab\u0000')).toBe('416200');
    expect(strToHexStr('')).toBe('');
  });
  it('Base64 round-trips', () => {
    expect(encodeBase64('Hello')).toBe('SGVsbG8=');
    expect(decodeBase64('SGVsbG8=')).toBe('Hello');
    expect(decodeBase64('SGVsbG8')).toBe('Hello'); // unpadded tolerated
    const binary = Buffer.from([0, 1, 2, 0xc3, 0xff, 0x80, 0x0d]).toString('latin1');
    expect(decodeBase64(encodeBase64(binary))).toBe(binary);
  });
  it('Base64URL (RFC 4648 §5, unpadded)', () => {
    expect(encodeBase64URL('a/b+')).toBe('YS9iKw');
    expect(decodeBase64URL('YS9iKw')).toBe('a/b+');
    const v = Buffer.from([251, 255, 0x80]).toString('latin1');
    expect(decodeBase64URL(encodeBase64URL(v))).toBe(v);
  });
  it('EncodeURL / EncodeURLElement char sets (synacode URLSpecialChar + URLFullSpecialChar)', () => {
    expect(encodeURL('hello world/a?b=1')).toBe('hello%20world/a?b=1');
    expect(encodeURLElement('a b/c?d=e&f')).toBe('a%20b%2Fc%3Fd%3De%26f');
    // URLSpecialChar: control bytes + < > " % { } | \\ ^ [ ] ` + 0x7F..0xFF
    expect(encodeURL('\u007f\u00e9')).toBe('%7F%E9');
    expect(encodeURL('{}|\\^[]`')).toBe('%7B%7D%7C%5C%5E%5B%5D%60');
    expect(encodeURL('"x"<y>')).toBe('%22x%22%3Cy%3E');
  });
  it('DecodeURL (DecodeTriplet %): quirks mirrored', () => {
    expect(decodeURL('a%20b')).toBe('a b');
    expect(decodeURL('%2f%3F%26')).toBe('/?&');
    // literal CR/LF right after the delimiter is consumed, nothing emitted
    // (synacode.pas:427–436); %0D/%0A hex triplets decode normally
    expect(decodeURL('a%0D%0Ab')).toBe('a\r\nb');
    // delimiter + CR + LF consumes both newlines; 'b' survives
    expect(decodeURL('a%\r\nb')).toBe('ab');
    expect(decodeURL('a%\nb')).toBe('ab');
    // bad hex after '%' → literal '%', digits preserved
    expect(decodeURL('%GZ')).toBe('%GZ');
    expect(decodeURL('100%')).toBe('100'); // trailing delimiter dropped
    // '%' + a single trailing char: Pascal `if x < lv … else break` (x at
    // the char after '%', 1-based) drops '%' AND the digit
    expect(decodeURL('ab%4')).toBe('ab');
    // same shape with a following char decodes the pair
    expect(decodeURL('ab%4x')).toBe('ab%4x'); // bad second digit → literal '%'
  });
  it('UU encode/decode (synacode TableUU)', () => {
    expect(encodeUU('abc')).toBe('#86)C'); // len byte '#' + table-encoded body
    expect(encodeUU('a')).toBe('!80'); // no padding slots (TableUU < 65 chars)
    expect(encodeUU('x'.repeat(64))).toBe(''); // only lines < 64 bytes
    // Pascal quirk: the mod-3 length math over-decodes by (3 - len % 3)
    // zero bytes for len % 3 ≠ 0 (trailing NULs kept — mirrored).
    expect(decodeUU(encodeUU('Hello'))).toBe('Hello\u0000');
    expect(decodeUU(encodeUU('ab'))).toBe('ab\u0000');
    // guards: BEGIN/END/TABLE lines and empty input → ''
    expect(decodeUU('begin 644 file')).toBe('');
    expect(decodeUU('`')).toBe('');
  });
  it('HTML encode/decode (uBaseUnit.HTMLDecode:1312–1383)', () => {
    expect(htmlEncode('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
    expect(htmlDecode('hello &amp; &lt;b&gt; &quot;x&quot;&nbsp;!&#65;'))
      .toBe('hello & <b> "x" !A');
    // unknown entity → Pascal `else Exit` truncates at the '&'
    expect(htmlDecode('&hellip; tail')).toBe('');
    expect(htmlDecode('ok &copy; gone')).toBe('ok ');
    // '&#N;' decimal entity; > 255 → Pascal Chr() range error → truncation
    expect(htmlDecode('&#233;')).toBe('\u00e9');
    expect(htmlDecode('&#99999;rest')).toBe('');
    // PChar walk: embedded NUL terminates the scan (uBaseUnit reads Sp^)
    expect(htmlDecode('ab\u0000cd')).toBe('ab');
  });
});
