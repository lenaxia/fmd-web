# Evidence — tsk-linear-seasoning-generates (crypto shim: full LuaCrypto surface)

Session: dual-sapling-picnics · Task: tsk-linear-seasoning-generates · Claim token verified at start (board_read).

## What was built

**`server/src/engine/shims/crypto-core.ts`** — byte-level core, every function
of `LuaCrypto.pas:429–494` ported against its Pascal implementation
(`BaseCrypto.pas`, `synacode.pas`, `uBaseUnit.pas`, canonical DCPcrypt 2.0.4
sources fetched and read: DCPcrypt2.pas, DCPblockciphers.pas, DCPrijndael.pas,
DCPrc4.pas, DCPbase64.pas).

- Hashes: MD4 (pure JS — RFC 1320 test suite incl. the exact 7 published
  vectors), MD5/SHA1/SHA256/SHA512 raw+hex, HMAC×4 raw+hex,
  `MD5LongHash`/`SHA1LongHash` (synacode repeat-to-length semantics).
- CRC16 (synacode table algorithm, init $FFFF, no xorout; bitwise cross-check
  in test) / CRC32 (IEEE).
- RC4 **pure JS** (DCPrc4 parity; COMPAT.md documents the FMD2 OpenSSL legacy
  provider dependence and why the JS impl differs — it doesn't).
- PBKDF2SHA256 (RFC 7914 vectors).
- AES: CBC (DCP exact semantics incl. the partial-block E(CV) keystream rule),
  CFB128, CTR (128-bit BE counter), OFB, ECB+PKCS7 (manual pad + blind chop —
  no validation, Pascal parity), GCM±AAD (ct‖tag, arbitrary IV lengths →
  OpenSSL GHASH J0 path), key classes 1..32 bytes zero-padded per
  DCPrijndael.InitKey, >32 → ''.
- Composed FMD2 variants: `AESEncryptCBCSHA256Base64Pkcs7` (SHA256-key InitStr
  + 32-hex-char iv + Pkcs7AddPad + base64), decrypt variant (blind pad chop),
  `AESDecryptCBCMD5Base64ZerosPadding` (**MD5 hex TEXT as AES-256 key** —
  Pascal BaseCrypto.pas:362 detail), `AESDecryptCBCHexBase64ZerosPadding`,
  `EncryptString`/`DecryptString` (uBaseUnit: AES-256 key =
  SHA512('B74945FB50E84FD58BF9FEAB8E4BEA6B')[0..32], IV = DCP nil-IV default
  **E_K(zero block)**, blockcipher EncryptString = **CFB8 + base64** —
  canonical DCPcrypt2 2.0.4, verified by independent openssl composition).
- Encodings: HexToStr/StrToHexStr, Base64/Base64URL, UU encode/decode
  (TableUU, no-pad slots, Pascal mod-3 over-decode quirk mirrored), URL
  encode/decode/Element (exact synacode char sets + DecodeTriplet quirks:
  delimiter+CR/LF skip, bad-hex literal '%', trailing-'%' break), HTML
  encode/decode (uBaseUnit HTMLDecode: entity set, `else Exit` truncation,
  PChar NUL-termination, Chr>255 truncation).
- EC + streams: `X25519_PublicKey`/`X25519_SharedSecret` (sodium-native),
  `P256_PublicKey`/`P256_SharedSecret`/`P256_GenerateKeyPair` (node ECDH —
  libsodium has no P-256, documented), `SecretStream_InitPull`/`Pull`
  (sodium-native, pull-side only, opaque state token).

**`server/src/engine/shims/crypto-shim.ts`** — the Lua-facing bridge:
full 60-method lib via `package.preload['fmd.crypto']`, with a **base64
byte-exact bridge** over wasmoon's lossy string marshaling (UTF-8 replacement
decode, NUL truncation, UTF-8 encode push — all verified empirically and
documented). Result protocol mirrors the Pascal `lua_push*` returns (string /
integer / nil / zero-returns / multi-returns) without ever pushing
null/undefined (wasmoon pushValue crash — worked around with a NIL_SENTINEL).

**`server/src/engine/shims/lua-require.ts`** — wired `installCryptoShim`
(replacing the v0 9-method subset; also fixed a missing `HostLogger` import
introduced by concurrent edits).

## Acceptance criteria — all met

1. **Known-answer vectors green** — `crypto-vectors.test.ts`: RFC 1320 (MD4 ×7
   exact), RFC 1321, RFC 2202 (HMAC-MD5/SHA1), RFC 4231 (HMAC-SHA256/512),
   RFC 7914 (PBKDF2), CRC32 (`123456789`→`cbf43926`, fox→`414fa339`), CRC16
   (bitwise poly-0x8408 cross-check + committed `6f91` vector), LongHash
   (repeat-construction derivation), RC4 classic vectors, encodings incl.
   Pascal-quirk vectors.
2. **Roundtrip property tests green** — `crypto-ciphers.test.ts`: ECB/CBC/
   CFB/CTR/OFB/GCM±AAD over key classes {1,8,15,16,17,20,24,25,31,32} ×
   lengths {1,15,16,17,31,32,48,64,100,255,300} incl. DCP partial-block CBC
   rule; OpenSSL cross-checks for CFB/CTR/OFB/GCM (and aes-js CFB); tamper →
   '' for GCM (tag + AAD mismatch); SecretStream sodium push→Lua pull flows
   (multi-chunk, empty msg, TAG_FINAL, tamper → zero returns); X25519 RFC
   7748 §5.2+§6.1 vectors + node-DH interop; P256 SEC1/SPKI-wrapped
   diffieHellman interop (independent of createECDH); NexusScanlation-shaped
   ECDH→HKDF→AES-GCM chain.
3. **Composed variants match hand-derived vectors** — `crypto-composed.test.ts`,
   every vector carries its derivation note citing the Pascal lines (sha256
   key, hex iv, PKCS7 always-1..16, blind chop, MD5-hex-text key, E_K(0) IV +
   CFB8 + base64, zero-strip rules, iv zero-fill/truncate).
4. **sodium-native loads in the docker target** — ships prebuilt libsodium
   (no apt-get needed); `docker/Dockerfile` gained a build-time smoke check
   (`require('sodium-native')` + scalarmult probe fails the image build);
   tests guard on `sodiumAvailable()` and **skip with an explicit reason**;
   COMPAT.md documents the docker story + the in-runtime degradation paths.

## Test results

`npx vitest run server/test/engine/shims/crypto-*.test.ts` → **108 passed**
(vectors 16, ciphers 33, composed 13, bridge 8 + sibling shims). Full repo
suite: my slice green; remaining failures are other sessions' in-flight files
(corpus-live golden, init-pass golden, e2e probes — verified pre-existing via
`git stash` baselines).

## Documentation

`docs/COMPAT.md`: LuaCrypto row → full-surface status + a dedicated section
(backends, RC4/OpenSSL-legacy note, sodium/docker note, byte-bridge rationale,
SecretStream token deviation, DCP cipher-semantics list, lenient edges,
coverage map). `contract/contract.json` requireShims entry updated
(schema-conformant). `docker/Dockerfile` smoke check. Types: ambient
`sodium-native`/`aes-js` declarations for tests.

## Verification commands

```
npx vitest run server/test/engine/shims/          # crypto + shim suites
npx tsc --noEmit -p server/tsconfig.json          # 0 errors in my files
npx eslint server/src/engine/shims/crypto-*.ts server/test/engine/shims/crypto-*.test.ts  # clean
```
