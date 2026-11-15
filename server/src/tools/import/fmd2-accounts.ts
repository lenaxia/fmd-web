import type { ModuleId } from '@fmd/contract';
import { sealSecret, SecretBoxError } from '../../accounts/secret-box.js';
import type { AccountStatusOrdinal } from '../../accounts/account-store.js';
import { fmd2DecryptString } from './fmd2-crypto.js';
import type { Fmd2ModuleEntry } from './fmd2-modules.js';

/**
 * fmd2-accounts — the FMD2 modules.json `Account` objects → §9 `account`
 * rows (D4, one-shot migration). This is the ONLY consumer of the FMD2
 * hardcoded-key decryption (`fmd2-crypto.ts`): each FMD2 EncryptString
 * field (Username/Password/Cookies, uBaseUnit.pas:1557–1572) is
 * decrypted, then re-sealed under the DEPLOYMENT secret
 * (`accounts/secret-box.ts`, FMD_WEB_SECRET + AES-256-GCM). The FMD2 key
 * never touches the stored value; native storage sees only sealed
 * envelopes.
 *
 * Status parity: FMD2's LoadFromFile resets `asChecking` → `asUnknown`
 * (WebsiteModules.pas:611-613) — the import mirrors that; other ordinals
 * clamp into the 0..3 set. Idempotent: upsert per module id (a re-run
 * replaces the same sealed values; IVs differ per seal, contents match).
 */

/** The write seam — `SqliteAccountStore.upsert` satisfies it structurally. */
export interface AccountImportTarget {
  upsert(row: {
    moduleId: string;
    usernameEnc: string;
    passwordEnc: string;
    cookiesEnc: string;
    status: AccountStatusOrdinal;
    enabled: boolean;
  }): unknown;
}

export interface ImportAccountsSummary {
  /** Entries with an Account object in the source file. */
  readonly total: number;
  /** Account rows written. */
  readonly imported: number;
  /** Accounts whose FMD2 ciphertext failed to decrypt meaningfully. */
  readonly undecryptable: number;
}

/** FMD2 LoadFromFile parity: asChecking does not survive a reload. */
function importStatus(status: number): AccountStatusOrdinal {
  const clamped = (status === 1 || status === 2 || status === 3 ? status : 0) as AccountStatusOrdinal;
  return clamped === 1 ? 0 : clamped;
}

/**
 * Import parsed `Account` entries. Throws {@link SecretBoxError} when the
 * deployment secret is empty (the CLI turns that into a clean nonzero
 * exit — a migration must never silently store plaintext).
 */
export function importFmd2Accounts(
  entries: readonly Fmd2ModuleEntry[],
  secret: string,
  target: AccountImportTarget,
): ImportAccountsSummary {
  if (secret === '') {
    throw new SecretBoxError('FMD_WEB_SECRET is required for the accounts import (refusing to store plaintext)');
  }
  let total = 0;
  let imported = 0;
  let undecryptable = 0;
  for (const entry of entries) {
    const account = entry.account;
    if (account === undefined) {
      continue;
    }
    total += 1;
    const username = fmd2DecryptString(account.usernameCipher);
    const password = fmd2DecryptString(account.passwordCipher);
    const cookies = fmd2DecryptString(account.cookiesCipher);
    // FMD2's EncryptString('') = '' — but a NON-empty ciphertext that
    // decrypts to '' means the value is not FMD2-EncryptString data
    // (wrong file, corrupted row): counted, kept as empty, reported.
    const undecrypted =
      (account.usernameCipher !== '' && username === '') ||
      (account.passwordCipher !== '' && password === '') ||
      (account.cookiesCipher !== '' && cookies === '');
    if (undecrypted) {
      undecryptable += 1;
    }
    target.upsert({
      moduleId: entry.id as ModuleId,
      usernameEnc: sealSecret(username, secret),
      passwordEnc: sealSecret(password, secret),
      cookiesEnc: sealSecret(cookies, secret),
      status: importStatus(account.status),
      enabled: account.enabled,
    });
    imported += 1;
  }
  return { total, imported, undecryptable };
}
