/**
 * Secrets-at-rest tests (DESIGN.md §8.6 item 6 / D4 acceptance criterion
 * 4): AES-256-GCM sealing under FMD_WEB_SECRET with the derived key
 * NEVER stored, wrong-secret failure clean (typed, no partial plaintext),
 * and a raw app.db file inspection proving no plaintext secret bytes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  deriveAccountKey,
  isSealedEnvelope,
  openSecret,
  sealSecret,
  SecretBoxError,
} from '../../src/accounts/secret-box.js';
import { ensureAccountsSchema, SqliteAccountStore } from '../../src/accounts/account-store.js';

const SECRET_A = 'deployment-secret-alpha';
const SECRET_B = 'deployment-secret-beta';

describe('secret-box: AES-256-GCM under FMD_WEB_SECRET', (): void => {
  it('round-trips a plaintext through seal/open', (): void => {
    const envelope = sealSecret('hunter2', SECRET_A);
    expect(isSealedEnvelope(envelope)).toBe(true);
    expect(openSecret(envelope, SECRET_A)).toBe('hunter2');
  });

  it('envelope format: enc1.<iv 12B>.<ct>.<tag 16B> (base64url), random IV per seal', (): void => {
    const e1 = sealSecret('same-input', SECRET_A);
    const e2 = sealSecret('same-input', SECRET_A);
    // Same plaintext seals differently (random IV)…
    expect(e1).not.toBe(e2);
    // …yet opens identically.
    expect(openSecret(e1, SECRET_A)).toBe('same-input');
    expect(openSecret(e2, SECRET_A)).toBe('same-input');
    const [, iv, ct, tag] = e1.split('.');
    expect(Buffer.from(iv as string, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag as string, 'base64url')).toHaveLength(16);
    expect(Buffer.from(ct as string, 'base64url').length).toBe('same-input'.length);
  });

  it('key derivation is deterministic per secret and differs across secrets', (): void => {
    expect(Buffer.from(deriveAccountKey(SECRET_A)).equals(deriveAccountKey(SECRET_A))).toBe(true);
    expect(Buffer.from(deriveAccountKey(SECRET_A)).equals(deriveAccountKey(SECRET_B))).toBe(false);
    expect(deriveAccountKey(SECRET_A)).toHaveLength(32);
  });

  it('wrong secret: typed SecretBoxError, no partial plaintext (clean failure)', (): void => {
    const envelope = sealSecret('sensitive-cookies', SECRET_A);
    expect(() => openSecret(envelope, SECRET_B)).toThrow(SecretBoxError);
    try {
      openSecret(envelope, SECRET_B);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SecretBoxError);
      expect((err as Error).message).toContain('AES-256-GCM authentication');
      expect((err as Error).message).not.toContain('sensitive-cookies');
    }
  });

  it('malformed/tampered envelopes fail cleanly (not a plaintext leak)', (): void => {
    const envelope = sealSecret('value', SECRET_A);
    const parts = envelope.split('.');
    // Tampered ciphertext → auth failure.
    const tampered = [parts[0], parts[1], Buffer.from('corrupt!').toString('base64url'), parts[3]].join('.');
    expect(() => openSecret(tampered, SECRET_A)).toThrow(SecretBoxError);
    // Not an envelope at all.
    expect(() => openSecret('plaintext-garbage', SECRET_A)).toThrow(SecretBoxError);
    // Wrong prefix (foreign version).
    expect(() => openSecret(envelope.replace(/^enc1\./, 'enc2.'), SECRET_A)).toThrow(SecretBoxError);
  });

  it('empty plaintext and empty secret guards', (): void => {
    const empty = sealSecret('', SECRET_A);
    expect(openSecret(empty, SECRET_A)).toBe('');
    expect(() => sealSecret('x', '')).toThrow(SecretBoxError);
    expect(() => deriveAccountKey('')).toThrow(SecretBoxError);
  });
});

describe('encryption-at-rest: raw db file inspection (criterion 4)', (): void => {
  it('a sealed app.db carries NO plaintext secret bytes anywhere', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'fmd-accounts-at-rest-'));
    const dbPath = join(dir, 'app.db');
    const db = new Database(dbPath);
    ensureAccountsSchema(db);
    const store = new SqliteAccountStore(db);
    store.upsert({
      moduleId: 'a'.repeat(32),
      usernameEnc: sealSecret('secret-username', SECRET_A),
      passwordEnc: sealSecret('secret-password', SECRET_A),
      cookiesEnc: sealSecret('sid=secret-cookie; session=abc', SECRET_A),
      status: 2,
      enabled: true,
    });
    db.close();

    // Inspect the RAW file bytes (WAL sidecars included): none of the
    // plaintext secrets may appear, while sealed values do.
    const raw = [
      readFileSync(dbPath),
      (() => {
        try {
          return readFileSync(`${dbPath}-wal`);
        } catch {
          return Buffer.alloc(0);
        }
      })(),
    ];
    const bytes = Buffer.concat(raw).toString('latin1');
    expect(bytes).not.toContain('secret-username');
    expect(bytes).not.toContain('secret-password');
    expect(bytes).not.toContain('secret-cookie');
    expect(bytes).toContain('enc1.');
    expect(bytes).toContain('a'.repeat(32)); // the module id is plaintext (an identifier)
  });

  it('reopening the db with the WRONG secret fails cleanly, never garbled', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'fmd-accounts-wrongsecret-'));
    const dbPath = join(dir, 'app.db');
    const db = new Database(dbPath);
    const store = new SqliteAccountStore(db);
    store.upsert({
      moduleId: 'b'.repeat(32),
      usernameEnc: sealSecret('user', SECRET_A),
      passwordEnc: sealSecret('pw', SECRET_A),
      cookiesEnc: sealSecret('c=1', SECRET_A),
      status: 0,
      enabled: true,
    });
    db.close();

    const reopened = new SqliteAccountStore(new Database(dbPath, { readonly: true }));
    const row = reopened.get('b'.repeat(32));
    expect(row).toBeDefined();
    expect(() => openSecret(row?.usernameEnc as string, SECRET_B)).toThrow(SecretBoxError);
    expect(() => openSecret(row?.passwordEnc as string, SECRET_B)).toThrow(SecretBoxError);
    expect(() => openSecret(row?.cookiesEnc as string, SECRET_B)).toThrow(SecretBoxError);
  });
});
