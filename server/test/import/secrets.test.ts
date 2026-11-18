// @vitest-environment node
/**
 * FMD2 EncryptString/DecryptString compatibility (uBaseUnit.pas:1559 +
 * DCPcrypt2.pas/DCPblockciphers.pas oracle): the hardcoded-key AES-256
 * CFB8 scheme every FMD2 credential at rest uses. Round-trip + shape
 * stability + redaction.
 */
import { describe, expect, it } from 'vitest';
import { decryptFmd2Secret, encryptFmd2Secret, redactSecret } from '../../src/import/fmd2/secrets.js';

describe('FMD2 secret sealing (DCPcrypt oracle parity)', (): void => {
  it('round-trips values of every shape FMD2 stores', (): void => {
    for (const value of ['', 'a', 'user@example', 'P@sswörd ✓', 'x'.repeat(512)]) {
      expect(decryptFmd2Secret(encryptFmd2Secret(value))).toBe(value);
    }
  });

  it('empty input is the empty string both ways (FMD2 convention)', (): void => {
    expect(encryptFmd2Secret('')).toBe('');
    expect(decryptFmd2Secret('')).toBe('');
  });

  it('ciphertext shape is base64 with no padding-free surprises', (): void => {
    const sealed = encryptFmd2Secret('hunter2');
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // Same plaintext → same bytes (fixed key + fixed IV derivation).
    expect(encryptFmd2Secret('hunter2')).toBe(sealed);
  });

  it('malformed ciphertext throws (surfaced as a per-field miss, never a 500)', (): void => {
    expect((): string => decryptFmd2Secret('not!valid!base64!!')).toThrow();
  });

  it('redactSecret never echoes the value body', (): void => {
    const redacted = redactSecret('supersecret');
    expect(redacted).not.toContain('upersecre');
    expect(redacted).not.toContain('secret');
    expect(redacted.startsWith('s')).toBe(true);
    expect(redacted).toContain('chars');
  });
});
