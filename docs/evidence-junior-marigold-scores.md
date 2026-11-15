# Evidence — tsk-junior-marigold-scores (in_review submission)

Implementer session: junior-marigold-scores · 2026-11-15 · stage in_progress → in_review

## Scope delivered (DESIGN §8.6/D4 — accounts storage + one-shot FMD2 import)

**Accounts core** (`server/src/accounts/`):
- `secret-box.ts` — AES-256-GCM sealing under the deployment `FMD_WEB_SECRET`;
  key derived via HKDF-SHA256 (fixed app salt/info), per-record random 12-byte IV,
  versioned envelope `enc1.<iv>.<ct>.<tag>` (base64url). The derived key is NEVER
  stored; wrong secret/tamper → typed `SecretBoxError` (clean failure, no partial
  plaintext).
- `account-store.ts` — §9 `account` table (SQLite/better-sqlite3, module-scoped
  UNIQUE per FMD2's one-account-per-module, `TWebsiteModuleAccount`
  WebsiteModules.pas:80-99). Schema note: all three sensitive fields are sealed
  columns (`username_enc`/`password_enc`/`cookies_enc`) — the §9 sketch's plaintext
  `username`/`cookies` columns predate criterion 4 (no plaintext secrets at rest);
  a session cookie IS a secret.
- `account-service.ts` — the §10 seam: CRUD + `login()`. Omitted password/cookies
  on upsert KEEP the stored credential (sealed values round-trip internally, never
  through the API). Views never carry the password. Login: decrypt in-memory →
  driver → persist handler-set status (account row) + cookies (account row + §5.3
  `module_state` via the optional `ModuleStatePersistence`, merged so
  ua/options/storage survive).

**Login via event runtime** (`server/src/runtime/account-login.ts`):
- `EngineLoginDriver` mirrors `EngineInfoService` (one wasmoon host per call,
  serialized). Loads the real module (Init pass + shims), seeds `MODULE.Account`
  (enabled/username/password + prior cookies/status — dispatcher shim extended,
  asChecking reset on seed per FMD2 LoadFromFile WebsiteModules.pas:611-613),
  dispatches the §5.2 `Login` row (account-status constants bound), reads the
  handler-set `MODULE.Account.Status/Cookies` back (FMD2 DoLogin flow,
  LuaWebsiteModules.pas:412-431). `AccountSupport=false` / no OnLogin handler →
  typed 409; dispatch failure → 502.

**API surface** (§8.6/D4 CRUD): `GET /api/accounts`, `PUT/DELETE
/api/accounts/:moduleId`, `POST /api/accounts/:moduleId/login` — zod schemas,
typed envelopes, password write-only, 201 upsert / 404 / 409 (disabled) / 502
(driver failure) mapped at the route. OpenAPI regenerated (`API_OPENAPI_SNAPSHOT=write`),
snapshot test green; routes.ts inventory + doc tags updated. `ApiServices.accounts`
optional (in-memory default) so parallel hosts keep compiling; runtime assembly
wires `SqliteAccountService` + `EngineLoginDriver` (assembly.ts, FMD_WEB_SECRET env
provider).

**FMD2-key isolation refactor** (criterion 3):
- The hardcoded key literal (`EncryptKey`, uBaseUnit.pas:1556) now lives in EXACTLY
  ONE module: `server/src/tools/import/fmd2-crypto.ts` (migration-only). It was
  previously embedded in `engine/shims/crypto-core.ts`.
- `crypto-core.ts` exposes the generic DCP composition with an EXPLICIT key
  (SHA512(key)[0..31] → IV = E_K(0¹⁶) → CFB8 → base64 — the COMPAT.md-verified
  derivation). `crypto-shim.ts` injects the key (`CryptoBridgeDeps.encryptKey`);
  `install.ts` wires it (whitelisted importer) so the fmd.crypto Lua surface keeps
  FMD2 parity; unwired shim methods return '' (no seed module or corpus module
  calls EncryptString — verified by scan).
- eslint `no-restricted-imports` boundary (root config): everything under
  `server/src` except [the migration modules themselves, `install.ts`] refuses the
  import → native storage cannot reach the key.

**Import commands** (D4 one-shot, `server/src/tools/import/` + `server/tools/import/fmd2-import.ts`):
- `fmd2-modules` — modules.json (TWebsiteModules.SaveToFile shape,
  WebsiteModules.pas:635-693) → §9 `module_state`: enabled flags, option values
  (combobox INDEX preserved), Settings cookies + persistent cookie objects folded
  into the §5.3 jar text, UA. Upsert touches ONLY the §5.3 runtime columns —
  registry columns survive.
- `fmd2-downloads` — downloadedchapters.db (TDownloadedChaptersDB schema,
  DownloadedChaptersDB.pas:44-50, read-only open) → §9 `downloaded_chapters` via
  the store's SetChapters merge semantics (keys are the identical
  `LowerCase(ModuleID+Link)`).
- `fmd2-accounts` — decrypts FMD2 EncryptString Username/Password/Cookies with the
  hardcoded key (THE only sanctioned use), re-seals under FMD_WEB_SECRET into §9
  `account`; status ordinal clamped + asChecking→asUnknown (LoadFromFile parity);
  empty/missing secret → clean refusal (never plaintext writes).
- All three idempotent (upsert/merge — re-runs never duplicate), fully offline,
  JSON summaries, exit 0/1/2. CLI runnable via tsx or the built dist.

## Verification (all offline)

- Story suites **77/77** across 9 files:
  - `accounts/secret-box.test.ts` 8 — round-trip, envelope shape (iv 12B/tag 16B,
    random-IV nondeterminism), deterministic HKDF keys, wrong-secret clean typed
    failure, malformed/tampered envelopes, **criterion 4**: raw app.db (+WAL) byte
    inspection shows NO plaintext secret bytes while `enc1.` envelopes are present;
    reopen-with-wrong-secret fails cleanly.
  - `accounts/account-service.test.ts` 11 — sealed-at-rest CRUD, credential-keeping
    upsert, secret-misconfig clean failures, login flows (asValid/asInvalid,
    status+cookies persisted to row AND §5.3 module_state with merge), driver-failure
    502, disabled-409/unknown-404.
  - **criterion 1**: `accounts/account-login-engine.test.ts` 5 — a synthetic
    FMD2-format mock module (Init + OnLogin + OnAccountState, account-status
    constants, CapibaraTraductor/DataLife template flow) through the REAL engine
    stack: asValid+cookies / asInvalid / asUnknown(Enabled gate) outcomes; plus
    dispatcher-level proof of the bound constants and the host-side read-back;
    `api/accounts.test.ts` 10 — CRUD + login routes (mock OnLogin returning
    account-status constants; cookies persist).
  - **criterion 2**: `tools/import/fmd2-import.test.ts` 13 — synthetic fixtures
    built to the FMD2 formats (modules.json per SaveToFile; downloadedchapters.db
    created with the exact Pascal schema; **EncryptString ciphertext produced by
    the test's own reimplementation of the derivation — SHA512(key,latin1)[0..31],
    IV=E_K(0¹⁶), CFB8, base64 — with derivation notes**); round-trip asserts; all
    three commands re-run idempotently (module/account row counts stable,
    downloaded dupIgnore merge stable); wrong-secret clean; non-FMD2 source db
    clean error; a REAL tsx spawn runs all three commands green + the wrong-secret
    CLI exit is 1; argv/usage parsing.
  - **criterion 3**: `tools/import/fmd2-key-isolation.test.ts` 5 — source-tree scan:
    the literal appears in exactly ONE non-test module
    (`server/src/tools/import/fmd2-crypto.ts`); server/src importers of the
    migration module are exactly [install.ts, fmd2-accounts.ts]; native-storage
    modules reference neither the key nor the migration module; the eslint rule
    stands; secret-box is AES-256-GCM/FMD_WEB_SECRET only.
  - crypto-composed 13 / crypto-bridge 8 (updated to explicit-key signatures —
    openssl vector still byte-identical) / api/openapi 6 (regenerated snapshot).
- `tsc -b`: story-owned files clean. Remaining errors confined to concurrently
  in-flight stories' files (gzip-shim.ts + its test, pcre2-shim.ts,
  logger-shim.test.ts, runtime.test.ts:51 RuntimeConfig liveScrape*,
  settings.test.ts per-module-proxy WIP in services.ts) — none story-owned.
- `eslint`: exit 0 across every story-owned path (incl. the new boundary rule).
- `npm run contract:check`: OK — 0 mismatches (events + facades vs FMD2 sources).
- Shared-harness repairs made for in-flight contract changes:
  `helpers.ts` makeRegistration/defaultRegistrations gained the now-required
  `live_scrape_fallback: false` (capabilities.ts contract change from the
  live-scrape story) — this unblocked the shared modules/auth API suites; the
  remaining settings.test failure is that story's in-flight proxy projection.

## Acceptance criteria

- [x] Account CRUD + login integration tests (mock module OnLogin returning
      account-status constants; cookies persisted) — account-login-engine.test.ts
      (real mock Lua module through Init pass + shims + dispatcher),
      account-service.test.ts (driver + §5.3 module_state cookie persistence),
      api/accounts.test.ts (routes).
- [x] Three import commands green against synthetic FMD2-format fixtures;
      idempotent re-run (no duplicates) — fmd2-import.test.ts (fixtures built to
      SaveToFile/DownloadedChaptersDB shapes; in-process + real tsx spawn).
- [x] Hardcoded-key isolation: lint/test proves the FMD2 key constant exists ONLY
      in the import module; native storage never uses it — fmd2-key-isolation.test.ts
      + the eslint no-restricted-imports boundary.
- [x] Encryption-at-rest test: db file inspection shows no plaintext secrets —
      secret-box.test.ts raw app.db/WAL byte scan (passwords, usernames, cookies
      all sealed; only module ids plaintext).

## Notes

- Runtime assembly omits the §5.3 `statePersistence` wiring (login cookies always
  persist into the account row; module_state persistence attaches when the db
  story ships its SQLite adapter — the boundary is optional in
  `SqliteAccountServiceOptions`).
- UI: the API + contract deliver the CRUD surface the SPA consumes; no UI panel in
  this pass (the acceptance criteria are API/test-scoped; the Settings-page panel
  can ride the generated client later).
