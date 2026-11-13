# Evidence — tsk-linear-seasoning-generates (crypto shim verification + COMPAT completion)

Session: outland-welder-puzzles · Task: tsk-linear-seasoning-generates ·
Claim token verified at start (`board_read`, lease d4b42ad9…).

## Context

The implementation slice landed in e5ae19d (session dual-sapling-picnics):
`crypto-core.ts` (byte-level port of BaseCrypto.pas / synacode.pas /
uBaseUnit.pas / canonical DCPcrypt 2.0.4), `crypto-shim.ts` (base64
byte-exact Lua bridge over wasmoon), 4 vector suites, Dockerfile sodium
smoke check. The board criteria were never verified or moved, and the
curated fmd.crypto notes in `docs/COMPAT.md` were **truncated** — the text
promised an OpenSSL/RC4 note ("see the OpenSSL note below") that did not
exist in HEAD (lost before the first commit; a sibling regen preserved only
the first paragraph).

## This session's work

1. **Surface parity check** — machine-diffed the Pascal method tables
   (LuaCrypto.pas:429–494) against `CRYPTO_METHOD_NAMES`: **59/59 methods,
   missing none, extra none, order-identical** (43 cryptomethods + 16
   synacodemethods).
2. **Full verification pass** (acceptance criteria):
   - Criterion 1 (known-answer vectors): `crypto-vectors.test.ts` **34/34
     green** — RFC 1320 MD4 (all 7 published vectors), RFC 1321, RFC 2202
     (HMAC-MD5/SHA1), RFC 4231 (HMAC-SHA256/512 incl. overlong-key 64/128
     block paths), RFC 7914 PBKDF2, CRC32 (`123456789`→`cbf43926`),
     CRC16 bitwise poly-0x8408 cross-check, LongHash repeat-to-length,
     RC4 classic vectors, encoding quirk vectors.
   - Criterion 2 (roundtrip properties): `crypto-ciphers.test.ts` **33/33
     green** — ECB+PKCS7 / CBC / CFB128 / CTR / OFB / GCM±AAD roundtrips
     over key classes {1,8,15,16,17,20,24,25,31,32} × input lengths incl.
     DCP partial-block rules; SP800-38A first-block known answers;
     OpenSSL cross-checks (CFB/CTR/OFB/GCM incl. non-12-byte-IV GHASH J0)
     and aes-js CFB cross-check; tamper/AAD-mismatch → `''`;
     SecretStream pull flow vs libsodium push (multi-chunk, empty msg,
     TAG_FINAL, tamper → zero returns); RFC 7748 §5.2/§6.1 X25519 vectors
     + node DH interop; P256 SEC1/SPKI DER-wrapper ECDH interop
     (`diffieHellman` over KeyObjects — independent of createECDH).
   - Criterion 3 (hand-derived composed vectors): `crypto-composed.test.ts`
     **13/13 green** — every expected value carries a derivation note
     citing the Pascal lines: SHA256-key InitStr + 32-hex-char iv + Pkcs7
     always-1..16 pad + base64; blind pad chop (Pkcs7RemovePad unvalidated);
     MD5-hex-TEXT-as-key (BaseCrypto.pas:362); hex-key/hex-iv zeros-padding;
     EncryptString = SHA512-derived AES-256 key + IV=E_K(0¹⁶) + CFB8 +
     base64 (openssl `aes-256-cfb8` independent composition).
   - Criterion 4 (sodium-native in docker target): live probe
     `require('sodium-native')` + `crypto_scalarmult` → **loads, probe OK**
     in this runtime; `docker/Dockerfile:56–59` build-time smoke check
     fails the image build when it cannot load; test suites guard on
     `sodiumAvailable()` and skip with an explicit reason; degradation
     paths (X25519/SecretStream → Pascal OpenSSL-failure ''/nil/zero
     returns) documented — now in COMPAT.md.
3. **Fixed the COMPAT.md gap** — restored the full curated
   `## fmd.crypto compatibility notes` section (below the regeneration
   marker, so `corpus/scripts/generate-compat.ts` preserves it): RC4
   OpenSSL-legacy-provider note (FMD2's RC4 = DCPrc4 pure Pascal; JS impl
   pure JS textbook RC4, no behavioral difference, deliberately not
   node:crypto), MD4 note, sodium-native/docker story, byte-exact bridge
   rationale + result protocol, SecretStream opaque state-token deviation,
   DCP cipher-semantics list (key classes, nil-IV E_K(0), CBC partial-tail,
   CTR wrap, GCM ct‖tag, EncryptString CFB8), lenient edges (HexToStr
   strictness, garbage-in base64, LongHash divide-by-zero → Lua error —
   verified against synacode.pas:1142–1158 `Len div l`), coverage map.
4. **Repo hygiene** — typecheck green, eslint green (crypto slice files),
   contract drift-check + contract tests 61/61 green, full shims suite
   **140/140 green** (sibling txquery/pb/corpus-live suites unaffected).

## Test evidence (this session)

```
npx vitest run server/test/engine/shims/           → 140 passed (11 files)
  crypto-vectors 34 · crypto-ciphers 33 · crypto-composed 13 · crypto-bridge 8
npx vitest run contract/test/                       → 61 passed
npx tsc -b tsconfig.json                            → exit 0
npx eslint (crypto slice files)                     → exit 0
node sodium probe                                   → loads, scalarmult OK
surface diff vs LuaCrypto.pas:429–494               → 59/59, order-identical
```

## Acceptance criteria — all verified met

1. Known-answer vector tests green (hashes/HMACs/CRCs/MD4/LongHash) ✔
2. Roundtrip property tests green for every encrypt/decrypt pair incl.
   AES-GCM+AAD and SecretStream pull flow ✔
3. Composed FMD2 variants match hand-derived vectors with derivation
   notes committed in `crypto-composed.test.ts` ✔
4. sodium-native loads (live probe + docker build smoke check + explicit
   test guards + COMPAT.md documentation) ✔
