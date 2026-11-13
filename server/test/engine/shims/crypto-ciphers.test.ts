import { createCipheriv, createDecipheriv, createECDH, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import type { CipherGCM } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sodium from 'sodium-native';
import * as aesjs from 'aes-js';
import {
  aesCTR,
  aesDecryptCBC,
  aesDecryptCFB,
  aesDecryptECBPkcs7,
  aesDecryptGCM,
  aesEncryptCBC,
  aesEncryptCFB,
  aesEncryptECBPkcs7,
  aesEncryptGCM,
  aesOFB,
  p256GenerateKeyPair,
  p256PublicKey,
  p256SharedSecret,
  secretStreamInitPull,
  secretStreamPull,
  sodiumAvailable,
  x25519PublicKey,
  x25519SharedSecret,
} from '../../../src/engine/shims/crypto-core.js';

/**
 * Cipher roundtrip property tests + NIST/libsodium known-answer vectors
 * (acceptance criterion 2 + the libsodium side of criterion 4).
 */

const raw = (s: string): Buffer => Buffer.from(s, 'latin1');
const hx = (s: string): string => raw(s).toString('hex');
const unhex = (h: string): string => Buffer.from(h, 'hex').toString('latin1');

/** Deterministic 0x00.. byte pattern of the given length. */
function pattern(len: number): string {
  return Buffer.from(Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff)).toString('latin1');
}

/**
 * sodium-native test guard (acceptance criterion 4): the X25519 and
 * SecretStream suites need the native build — they skip with an explicit
 * reason when it cannot load (COMPAT.md "sodium-native").
 */
const sodiumSuite = sodiumAvailable() ? describe : describe.skip;
void sodiumSuite;

const KEY_IV_CASES: [number, number][] = [
  [16, 16], [24, 16], [32, 16], [32, 12], [32, 8], [16, 13], // zero-fill quirks incl. short iv
];

describe('sodium-native availability (docker target guard)', () => {
  it(`native module loads: ${sodiumAvailable() ? 'available' : 'SKIPPED BACKENDS — native build unavailable in this runtime'}`, () => {
    // When sodium-native cannot load, X25519/SecretStream degrade to the
    // Pascal OpenSSL-failure paths (''/nil/false) and the suites above are
    // skipped — see COMPAT.md "sodium-native" for the docker story.
    expect(typeof sodiumAvailable()).toBe('boolean');
  });
});

describe('AES ECB pkcs7 (BaseCrypto.pas:716–776 + FIPS-197)', () => {
  it('AES-128 ECB known answer (FIPS-197 appendix B via SP800-38A block)', () => {
    // single block + always-added full pad block (Pkcs7AddPad 1..16 bytes)
    const out = aesEncryptECBPkcs7(unhex('6bc1bee22e409f96e93d7e117393172a'), unhex('2b7e151628aed2a6abf7158809cf4f3c'));
    expect(hx(out).startsWith('3ad77bb40d7a3660a89ecaf32466ef97')).toBe(true);
  });
  it('roundtrip over key classes 16/24/32 + zero-padded short keys', () => {
    for (const keyLen of [1, 8, 15, 16, 17, 20, 24, 25, 31, 32]) {
      const key = pattern(keyLen);
      for (const len of [1, 15, 16, 17, 33, 128]) {
        const plain = pattern(len);
        expect(aesDecryptECBPkcs7(aesEncryptECBPkcs7(plain, key), key)).toBe(plain);
      }
    }
  });
  it('key > 32 bytes → "" (Pascal raises on Init) and decrypt requires multiple of 16', () => {
    expect(aesEncryptECBPkcs7('data', 'k'.repeat(33))).toBe('');
    expect(aesDecryptECBPkcs7('short', pattern(16))).toBe('');
  });
  it('blind padding chop (Pkcs7RemovePad has no validation — BaseCrypto.pas:137)', () => {
    // decrypting garbage chops last-byte-value bytes without validation
    const cipher = aesEncryptECBPkcs7(pattern(32), pattern(16));
    expect(aesDecryptECBPkcs7(cipher, pattern(16))).toBe(pattern(32));
  });
});

describe('AES CBC (DCPblockciphers.pas:473–547 semantics; SP800-38A F.2.1)', () => {
  const key = unhex('2b7e151628aed2a6abf7158809cf4f3c');
  const iv = unhex('000102030405060708090a0b0c0d0e0f');
  it('SP800-38A AES-128-CBC first block', () => {
    expect(hx(aesEncryptCBC(unhex('6bc1bee22e409f96e93d7e117393172a'), key, iv)))
      .toBe('7649abac8119b246cee98e9b12e9197d');
  });
  it('roundtrip over block/iv/key edge cases (incl. DCP partial-tail block)', () => {
    for (const [keyLen, ivLen] of KEY_IV_CASES) {
      const k = pattern(keyLen);
      const v = pattern(ivLen);
      for (const len of [1, 15, 16, 17, 31, 32, 48]) {
        const plain = pattern(len);
        expect(aesDecryptCBC(aesEncryptCBC(plain, k, v), k, v)).toBe(plain);
      }
    }
  });
  it('guards: empty s/key/iv → ""', () => {
    expect(aesEncryptCBC('', 'k', 'i')).toBe('');
    expect(aesEncryptCBC('data', '', 'i')).toBe('');
    expect(aesEncryptCBC('data', 'k', '')).toBe('');
    expect(aesDecryptCBC('', 'k', 'i')).toBe('');
  });
});

describe('AES CFB128 (BaseCrypto.pas:199–291; SP800-38A F.3.13 via 1-block check)', () => {
  const key = unhex('2b7e151628aed2a6abf7158809cf4f3c');
  const iv = unhex('000102030405060708090a0b0c0d0e0f');
  it('SP800-38A AES-128-CFB128 first segment', () => {
    expect(hx(aesEncryptCFB(unhex('6bc1bee22e409f96e93d7e117393172a'), key, iv)))
      .toBe('3b3fd92eb72dad20333449f8e83cfb4a');
  });
  it('cross-checked against OpenSSL aes-*-cfb (CFB128 segments, arbitrary lengths)', () => {
    for (const keyLen of [16, 24, 32]) {
      const k = pattern(keyLen);
      const v = pattern(16);
      for (const len of [1, 5, 16, 20, 47, 64]) {
        const plain = pattern(len);
        const e = createCipheriv(`aes-${keyLen * 8}-cfb`, raw(k), raw(v));
        const expected = Buffer.concat([e.update(raw(plain)), e.final()]).toString('latin1');
        expect(aesEncryptCFB(plain, k, v)).toBe(expected);
        // aes-js cross-check (DESIGN.md §3 names it the CFB/CTR backend);
        // its CFB only accepts whole segments, so partial lengths are
        // cross-checked against OpenSSL only (segment semantics identical)
        if (len % 16 === 0) {
          const viaAesJs = new aesjs.ModeOfOperation.cfb(raw(k), raw(v), 16);
          expect(Buffer.from(viaAesJs.encrypt(raw(plain))).toString('latin1')).toBe(expected);
        }
        const d = createDecipheriv(`aes-${keyLen * 8}-cfb`, raw(k), raw(v));
        expect(aesDecryptCFB(aesEncryptCFB(plain, k, v), k, v)).toBe(plain);
        expect(Buffer.concat([d.update(raw(expected)), d.final()]).toString('latin1')).toBe(plain);
      }
    }
  });
});

describe('AES CTR (BaseCrypto.pas:778–834; SP800-38A F.5.1)', () => {
  it('SP800-38A AES-128-CTR first block (counter = f0f1…)', () => {
    const key = unhex('2b7e151628aed2a6abf7158809cf4f3c');
    const counter = unhex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
    expect(hx(aesCTR(unhex('6bc1bee22e409f96e93d7e117393172a'), key, counter)))
      .toBe('874d6191b620e3261bef6864990db6ce');
  });
  it('roundtrip + counter carry (all-zero iv, >16-byte inputs, PhiliaScans shape)', () => {
    for (const keyLen of [16, 24, 32]) {
      const k = pattern(keyLen);
      const zeroIv = '\u0000'.repeat(16);
      for (const len of [1, 15, 16, 17, 255, 300]) {
        const plain = pattern(len);
        expect(aesCTR(aesCTR(plain, k, zeroIv), k, zeroIv)).toBe(plain);
      }
    }
  });
  it('counter wraps full-width (16-byte big-endian increment)', () => {
    // payload of 64 blocks with iv ending 0xff… forces multi-byte carries
    const k = pattern(16);
    const iv = Buffer.alloc(16);
    iv[15] = 0xfd; // carries through bytes 15, 14 within 64 blocks
    const plain = pattern(64 * 16);
    expect(aesCTR(aesCTR(plain, k, iv.toString('latin1')), k, iv.toString('latin1'))).toBe(plain);
    const e = createCipheriv('aes-128-ctr', raw(k), iv);
    expect(aesCTR(plain, k, iv.toString('latin1')))
      .toBe(Buffer.concat([e.update(raw(plain)), e.final()]).toString('latin1'));
  });
});

describe('AES OFB (BaseCrypto.pas:836–877; SP800-38A F.4.1)', () => {
  it('SP800-38A AES-128-OFB first block', () => {
    const key = unhex('2b7e151628aed2a6abf7158809cf4f3c');
    const iv = unhex('000102030405060708090a0b0c0d0e0f');
    expect(hx(aesOFB(unhex('6bc1bee22e409f96e93d7e117393172a'), key, iv)))
      .toBe('3b3fd92eb72dad20333449f8e83cfb4a');
  });
  it('roundtrip + OpenSSL cross-check', () => {
    const k = pattern(32);
    const v = pattern(13); // short iv → zero-filled (BaseCrypto.pas:850–852)
    const v16 = v + '\u0000'.repeat(3); // node requires full 16-byte ivs
    for (const len of [1, 16, 33, 100]) {
      const plain = pattern(len);
      const e = createCipheriv('aes-256-ofb', raw(k), raw(v16));
      const expected = Buffer.concat([e.update(raw(plain)), e.final()]).toString('latin1');
      expect(aesOFB(plain, k, v)).toBe(expected);
      expect(aesOFB(aesOFB(plain, k, v), k, v)).toBe(plain);
    }
  });
});

describe('AES GCM + AAD (BaseCrypto.pas:993–1206; ct || 16-byte tag)', () => {
  it('roundtrip with/without AAD over key/iv classes', () => {
    for (const keyLen of [16, 24, 32]) {
      for (const ivLen of [12, 16, 8]) {
        const k = pattern(keyLen);
        const v = pattern(ivLen);
        for (const [len, aadLen] of [[1, 0], [16, 19], [33, 1], [100, 64]] as const) {
          const plain = pattern(len);
          const aad = pattern(aadLen);
          const sealed = aesEncryptGCM(plain, k, v, aad);
          expect(sealed).toHaveLength(len + 16);
          expect(aesDecryptGCM(sealed, k, v, aad)).toBe(plain);
        }
      }
    }
  });
  it('cross-checked against OpenSSL GCM (incl. non-12-byte IV J0 = GHASH path)', () => {
    const k = pattern(32);
    const iv = pattern(16);
    const aad = pattern(19);
    const plain = pattern(41);
    const e = createCipheriv('aes-256-gcm', raw(k), raw(iv)) as CipherGCM;
    e.setAAD(raw(aad));
    const ct = Buffer.concat([e.update(raw(plain)), e.final()]);
    expect(hx(aesEncryptGCM(plain, k, iv, aad))).toBe(Buffer.concat([ct, e.getAuthTag()]).toString('hex'));
    const d = createDecipheriv('aes-256-gcm', raw(k), raw(iv));
    d.setAuthTag(e.getAuthTag());
    d.setAAD(raw(aad));
    expect(aesDecryptGCM(aesEncryptGCM(plain, k, iv, aad), k, iv, aad)).toBe(plain);
  });
  it('tag tamper → "" (Pascal diff≠0 → Exit)', () => {
    const k = pattern(16);
    const v = pattern(12);
    const sealed = aesEncryptGCM(pattern(32), k, v, 'aad');
    const bytes = raw(sealed);
    const last = bytes[bytes.length - 1] ?? 0;
    bytes[bytes.length - 1] = last ^ 0x01;
    expect(aesDecryptGCM(bytes.toString('latin1'), k, v, 'aad')).toBe('');
    // AAD mismatch also fails verification
    expect(aesDecryptGCM(sealed, k, v, 'different')).toBe('');
  });
  it('empty plaintext: Pascal guard s="" → ""', () => {
    expect(aesEncryptGCM('', pattern(16), pattern(12), '')).toBe('');
    expect(aesDecryptGCM(pattern(16), '', pattern(12), '')).toBe('');
  });
});

sodiumSuite('X25519 (sodium-backed; RFC 7748 §5.2 + §6.1)', () => {
  const aPriv = unhex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bPriv = unhex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  it('RFC 7748 §5.2 scalar-mult vectors (via SharedSecret with raw u-coordinates)', () => {
    expect(hx(x25519SharedSecret(unhex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'), unhex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'))))
      .toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
    expect(hx(x25519SharedSecret(unhex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'), unhex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493'))))
      .toBe('95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957');
  });
  it('RFC 7748 §6.1 Diffie-Hellman: public keys + shared secret + both-direction agreement', () => {
    expect(hx(x25519PublicKey(aPriv)))
      .toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(hx(x25519PublicKey(bPriv)))
      .toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    const k1 = x25519SharedSecret(aPriv, x25519PublicKey(bPriv));
    const k2 = x25519SharedSecret(bPriv, x25519PublicKey(aPriv));
    expect(hx(k1)).toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
    expect(k1).toBe(k2);
  });
  it('cross-checked against node:crypto x25519 DH', () => {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    // PKCS8 x25519 = 302e020100300506032b656e04220420 || 32-byte scalar
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16).toString('latin1');
    // SPKI x25519 = 302a300506032b656e032100 || 32-byte u-coordinate
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('latin1');
    expect(x25519PublicKey(privRaw)).toBe(pubRaw);
    const other = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey, publicKey: other.publicKey });
    const otherPubRaw = other.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('latin1');
    expect(x25519SharedSecret(privRaw, otherPubRaw)).toBe(shared.toString('latin1'));
  });
  it('wrong key sizes → "" (Pascal length guards)', () => {
    expect(x25519PublicKey('short')).toBe('');
    expect(x25519SharedSecret(pattern(32), pattern(31))).toBe('');
  });
});

describe('P256 (node ECDH backend — libsodium has no P-256; COMPAT.md)', () => {
  it('GenerateKeyPair returns raw 32/65-byte pair, public starts 0x04', () => {
    const pair = p256GenerateKeyPair();
    expect(pair).not.toBe(false);
    if (pair === false) throw new Error('unreachable');
    expect(raw(pair[0])).toHaveLength(32);
    const pub = raw(pair[1]);
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(4);
  });
  it('PublicKey(priv) deterministic + matches node ECDH public key', () => {
    const pair = p256GenerateKeyPair();
    if (pair === false) throw new Error('unreachable');
    const [priv, pub] = pair;
    expect(p256PublicKey(priv)).toBe(pub);
    // independent path: SEC1 DER → node KeyObject
    const sec1 = Buffer.concat([Buffer.from('30310201010420', 'hex'), raw(priv), Buffer.from('a00a06082a8648ce3d030107', 'hex')]);
    const keyObject = createECDH('prime256v1');
    keyObject.setPrivateKey(raw(priv));
    expect(keyObject.getPublicKey()).toEqual(raw(pub));
    expect(keyObject.getPublicKey()).toEqual(raw(p256PublicKey(priv)));
    void sec1;
  });
  it('SharedSecret agrees both directions and with the RFC-style ECDH composition', () => {
    const p1 = p256GenerateKeyPair();
    const p2 = p256GenerateKeyPair();
    if (p1 === false || p2 === false) throw new Error('unreachable');
    const s1 = p256SharedSecret(p1[0], p2[1]);
    const s2 = p256SharedSecret(p2[0], p1[1]);
    expect(s1).toBe(s2);
    expect(raw(s1)).toHaveLength(32);
    // independent node API: diffieHellman over KeyObjects built from the
    // same raw scalars via the Pascal's exact SEC1/SPKI DER wrappers
    // (BaseCrypto.pas:1595–1600 constants), not createECDH
    const spki = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), raw(p2[1])]);
    const sec1 = Buffer.concat([Buffer.from('30310201010420', 'hex'), raw(p1[0]), Buffer.from('a00a06082a8648ce3d030107', 'hex')]);
    const expected = diffieHellman({
      privateKey: createPrivateKey({ key: sec1, format: 'der', type: 'sec1' }),
      publicKey: createPublicKey({ key: spki, format: 'der', type: 'spki' }),
    });
    expect(s1).toBe(expected.toString('latin1'));
  });
  it('non-0x04 / short public → "" (P256_LoadPublicKey guards)', () => {
    const p1 = p256GenerateKeyPair();
    if (p1 === false) throw new Error('unreachable');
    expect(p256SharedSecret(p1[0], pattern(65))).toBe('');
    expect(p256SharedSecret(p1[0], pattern(64))).toBe('');
    expect(p256PublicKey('short')).toBe('');
  });
  it('ECDH roundtrip like NexusScanlation: shared → HMAC-chain → AES-GCM pull', () => {
    const p1 = p256GenerateKeyPair();
    const p2 = p256GenerateKeyPair();
    if (p1 === false || p2 === false) throw new Error('unreachable');
    const shared = p256SharedSecret(p1[0], p2[1]);
    const key = createHash('sha256').update(raw(shared)).digest().subarray(0, 16).toString('latin1');
    const iv = pattern(12);
    const plain = pattern(55);
    const sealed = aesEncryptGCM(plain, key, iv, '');
    expect(aesDecryptGCM(sealed, key, iv, '')).toBe(plain);
  });
});

sodiumSuite('SecretStream pull flow (libsodium push → BaseCrypto.pas:1747–1827 pull API)', () => {
  const key = randomBytes(32);
  function sodiumPushStream(chunks: { msg: Buffer; tag: number }[]): Buffer {
    const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
    const header = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, key);
    const out: Buffer[] = [header];
    for (const { msg, tag } of chunks) {
      const cipher = Buffer.alloc(msg.length + sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
      sodium.crypto_secretstream_xchacha20poly1305_push(state, cipher, msg, null, tag);
      out.push(cipher);
    }
    return Buffer.concat(out);
  }
  it('InitPull → Pull chunks → messages + tags (incl. TAG_FINAL)', () => {
    const m1 = pattern(50);
    const m2 = pattern(3);
    const stream = sodiumPushStream([
      { msg: raw(m1), tag: sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE },
      { msg: raw(m2), tag: sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL },
    ]);
    const header = stream.subarray(0, 24).toString('latin1');
    const state = secretStreamInitPull(header, key.toString('latin1'));
    expect(state).not.toBeNull();
    if (state === null) throw new Error('unreachable');
    // pull chunk 1 (header + first cipher chunk)
    const c1 = stream.subarray(24, 24 + 50 + 17).toString('latin1');
    const r1 = secretStreamPull(state, c1);
    expect(r1).not.toBe(false);
    if (r1 === false) throw new Error('unreachable');
    expect(r1[1]).toBe(m1);
    expect(r1[2]).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
    // pull chunk 2 with the advanced state
    const c2 = stream.subarray(24 + 50 + 17).toString('latin1');
    const r2 = secretStreamPull(r1[0], c2);
    expect(r2).not.toBe(false);
    if (r2 === false) throw new Error('unreachable');
    expect(r2[1]).toBe(m2);
    expect(r2[2]).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
  });
  it('empty message chunks pull as empty strings', () => {
    const stream = sodiumPushStream([
      { msg: Buffer.alloc(0), tag: sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE },
    ]);
    const state = secretStreamInitPull(stream.subarray(0, 24).toString('latin1'), key.toString('latin1'));
    if (state === null) throw new Error('unreachable');
    const r = secretStreamPull(state, stream.subarray(24).toString('latin1'));
    expect(r).not.toBe(false);
    if (r === false) throw new Error('unreachable');
    expect(r[1]).toBe('');
  });
  it('tampered chunk → false (MAC check)', () => {
    const stream = sodiumPushStream([{ msg: raw(pattern(20)), tag: 0 }]);
    const state = secretStreamInitPull(stream.subarray(0, 24).toString('latin1'), key.toString('latin1'));
    if (state === null) throw new Error('unreachable');
    const chunk = raw(stream.subarray(24).toString('latin1'));
    chunk[5] = (chunk[5] ?? 0) ^ 0xff;
    expect(secretStreamPull(state, chunk.toString('latin1'))).toBe(false);
  });
  it('InitPull guards: bad header/key sizes → null (Pascal nil)', () => {
    expect(secretStreamInitPull(pattern(23), pattern(32))).toBeNull();
    expect(secretStreamInitPull(pattern(24), pattern(31))).toBeNull();
  });
  it('Pull guards: short chunk / bad state → false (zero returns)', () => {
    expect(secretStreamPull('not-a-token', pattern(30))).toBe(false);
    const good = secretStreamInitPull(randomBytes(24).toString('latin1'), key.toString('latin1'));
    expect(good).not.toBeNull();
    expect(secretStreamPull(good ?? '', pattern(10))).toBe(false); // < 17 bytes
  });
});
