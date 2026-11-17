import { decryptString, encryptString } from '../../engine/facade.js';

/**
 * FMD2 EncryptString/DecryptString — the MIGRATION-ONLY key holder (D4,
 * DESIGN.md §8.6 item 6).
 *
 * FMD2 stores module account credentials with uBaseUnit's EncryptString
 * (uBaseUnit.pas:1557–1572) under a HARDCODED key
 * (`EncryptKey`, uBaseUnit.pas:1556). That constant exists ONLY here —
 * the one-shot FMD2 import path. `enforce-fmd2-key-isolation.test.ts`
 * greps the source tree and fails when the literal leaks into any other
 * module, and the root eslint config forbids importing this module
 * outside the import path + the engine-shim wiring (the fmd.crypto Lua
 * surface parity, `install.ts`) + tests. Native storage (accounts,
 * module_state, downloads) encrypts exclusively under `FMD_WEB_SECRET`
 * (`accounts/secret-box.ts`) and can never reach this module.
 *
 * The DCP composition itself (AES-256 key = SHA512(key)[0..31], IV =
 * E_K(0¹⁶), CFB8, base64 — canonical DCPcrypt2 2.0.4) lives in
 * `crypto-core.ts` as an explicit-key helper; this module only supplies
 * the constant (COMPAT.md "DCP cipher semantics").
 */

/** FMD2 `EncryptKey` (uBaseUnit.pas:1556) — migration-only, see module doc. */
/** FMD2 `EncryptKey` (uBaseUnit.pas:1556) — migration-only, see module doc. */
export const FMD2_ENCRYPT_KEY = 'B74945FB50E84FD58BF9FEAB8E4BEA6B';

/** uBaseUnit.EncryptString (uBaseUnit.pas:1559–1573): '' for '' input. */
export function fmd2EncryptString(v: string): string {
  return encryptString(v, FMD2_ENCRYPT_KEY);
}

/** uBaseUnit.DecryptString (uBaseUnit.pas:1575–1589): '' for '' input. */
export function fmd2DecryptString(v: string): string {
  return decryptString(v, FMD2_ENCRYPT_KEY);
}
