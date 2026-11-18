/**
 * FMD2 EncryptString/DecryptString for the import FEATURE (analyze/
 * apply). The hardcoded key literal lives EXACTLY ONCE in the
 * migration module `server/src/tools/import/fmd2-crypto.ts` (D4 key
 * isolation — the isolation test + the eslint boundary pin it); this
 * adapter imports the CONSTANT and owns the FILE-path composition:
 *
 * - FMD2 is FPC with UTF-8 default strings — `EncryptString` seals the
 *   UTF-8 BYTES of the value and DecryptString yields UTF-8 (the
 *   latin1 code-point view the engine shim uses is the LUA boundary
 *   contract, not the file-at-rest one; ASCII values agree under both).
 * - DCP composition (canonical DCPcrypt2 2.0.4): AES-256 key =
 *   SHA-512(EncryptKey)[0..31] (InitStr → min(512, 256) bits), IV =
 *   AES-ECB(zero block) (DCPblockciphers.pas:479-491, DCP1COMPAT off),
 *   CFB8 body, base64. Strict base64 on decrypt — a typo'd ciphertext
 *   surfaces as a per-field failure, never silently as garbage.
 *
 * FMD2 seals proxy credentials (settings.json [connections] User/Pass)
 * and per-site accounts (modules.json Account Username/Password/
 * Cookies) with this scheme. Nothing here ever logs or echoes
 * plaintext.
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { FMD2_ENCRYPT_KEY } from '../../tools/import/fmd2-crypto.js';

/** AES-256 key = first 32 bytes of SHA-512(EncryptKey) (InitStr oracle). */
function fmd2AesKey(): Buffer {
  return createHash('sha512').update(FMD2_ENCRYPT_KEY, 'latin1').digest().subarray(0, 32);
}

/** CFB8 chaining-vector seed = AES-ECB(zero block) under that key. */
function fmd2Cfb8Iv(key: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()]);
}

/** Strict base64 (standard alphabet) — lenient Buffer.from silently
 * decodes garbage; a typo'd ciphertext must surface as a failure. */
function strictBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('not a valid base64 ciphertext');
  }
  return Buffer.from(value, 'base64');
}

/**
 * Decrypt one FMD2-sealed value (base64 AES-256-CFB8, UTF-8 body).
 * Returns '' for empty input (FMD2's own convention). Throws on
 * malformed ciphertext — callers surface that as a per-field import
 * failure, never a 500.
 */
export function decryptFmd2Secret(value: string): string {
  if (value === '') {
    return '';
  }
  const key = fmd2AesKey();
  const decipher = createDecipheriv('aes-256-cfb8', key, fmd2Cfb8Iv(key));
  const plain = Buffer.concat([
    decipher.update(strictBase64(value)),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/**
 * The matching encryptor — fixtures/tests only (so synthetic FMD2 files
 * are byte-compatible with what the desktop app itself writes).
 */
export function encryptFmd2Secret(value: string): string {
  if (value === '') {
    return '';
  }
  const key = fmd2AesKey();
  const cipher = createCipheriv('aes-256-cfb8', key, fmd2Cfb8Iv(key));
  const raw = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
  return raw.toString('base64');
}

/**
 * Redaction for preview/report surfaces: a value that parses as a
 * secret is NEVER echoed in full — first char + length hint only
 * (token-shaped disclosure rule).
 */
export function redactSecret(value: string): string {
  if (value === '') {
    return '';
  }
  return `${value.charAt(0)}${'•'.repeat(Math.min(Math.max(value.length - 1, 2), 8))} (${value.length} chars)`;
}
