import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (DESIGN.md §8.6 item 6 / D4): account fields
 * (username/password/cookies) are sealed with a deployment-provided
 * `FMD_WEB_SECRET` under AES-256-GCM. The AES key is DERIVED from the
 * secret (HKDF-SHA256, fixed application salt/info) and is NEVER stored —
 * the envelope carries only a per-record random 12-byte IV plus the GCM
 * tag. A wrong secret (or tampered/foreign envelope) fails GCM
 * authentication and surfaces as a typed {@link SecretBoxError} — the
 * import command treats that as a clean failure, never a garbled value.
 *
 * Envelope format: `enc1.<iv_b64url>.<ct_b64url>.<tag_b64url>` — the
 * `enc1` prefix versions the format and makes sealed values
 * distinguishable from any legacy plaintext in a column.
 */

const HKDF_SALT = 'fmd-web/accounts/v1';
const HKDF_INFO = 'account-field-encryption';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_PREFIX = 'enc1';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** AES-256 key = HKDF-SHA256(secret) — deterministic per secret+labels. */
export function deriveAccountKey(secret: string): Buffer {
  if (secret === '') {
    throw new SecretBoxError('FMD_WEB_SECRET must not be empty');
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), KEY_BYTES));
}

/** true when `value` looks like a sealed envelope (prefix check only). */
export function isSealedEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}.`);
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Seal one field value under the deployment secret. */
export function sealSecret(plaintext: string, secret: string): string {
  const key = deriveAccountKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return [ENVELOPE_PREFIX, b64urlEncode(iv), b64urlEncode(ct), b64urlEncode(cipher.getAuthTag())].join('.');
}

/** Open one sealed envelope; ANY failure (format, wrong secret, tamper)
 * raises the typed {@link SecretBoxError} — never a partial plaintext. */
export function openSecret(envelope: string, secret: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    throw new SecretBoxError(`not a sealed envelope: ${JSON.stringify(envelope.slice(0, 24))}…`);
  }
  const [, ivPart, ctPart, tagPart] = parts;
  let iv: Buffer;
  let ct: Buffer;
  let tag: Buffer;
  try {
    iv = b64urlDecode(ivPart as string);
    ct = b64urlDecode(ctPart as string);
    tag = b64urlDecode(tagPart as string);
  } catch {
    throw new SecretBoxError('sealed envelope carries invalid base64url data');
  }
  if (iv.length !== IV_BYTES) {
    throw new SecretBoxError(`sealed envelope IV must be ${String(IV_BYTES)} bytes`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new SecretBoxError(`sealed envelope tag must be ${String(TAG_BYTES)} bytes`);
  }
  let key: Buffer;
  try {
    key = deriveAccountKey(secret);
  } catch (err: unknown) {
    throw err instanceof SecretBoxError ? err : new SecretBoxError('secret derivation failed');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('sealed envelope failed AES-256-GCM authentication (wrong FMD_WEB_SECRET or tampered data)');
  }
}
