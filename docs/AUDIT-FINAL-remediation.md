# AUDIT-FINAL remediation — tsk-hilly-wagon-picnics

Remediation of `docs/AUDIT-FINAL.md` findings **F-1, F-2, F-3 + NOTEs N-2/N-4**
(the accepted divergences F-5…F-10 are untouched). Every fix carries its
verifying test with file:line. Fresh gate after the fixes:
`contract:check` 0 mismatches · lint clean · typecheck clean ·
**152 test files / 1623 tests / 0 failed** (was 149/1597) · corpus
**912/912 = 100.00 %** · regenerated COMPAT.md/corpus-report.json byte-stable.

---

## F-1 (MAJOR, availability) — hostile CRLF header value permanently kills the shared HTTP transport worker

All three remediation layers from the audit's pointer, plus the
storage/wire-split documentation:

1. **Boundary validation (fail fast, typed).**
   - `server/src/engine/shims/http-pipeline.ts:336-342` — `attempt()` scans
     the module-written headers AND the cookie jar lines (the `Cookie`
     header's source) via `firstPoisonedHeader()` (`:231-244`); a poisoned
     request is a HARD STOP (`denied: true` — no retry loop even with
     `RetryCount = -1`), `ResultCode = 0` + the typed
     `header "…" contains CR/LF — refused at the wire boundary` reason,
     transport untouched.
   - `server/src/engine/shims/http-transport.ts:594-602` —
     `LoopbackHttpTransport.send()` refuses CR/LF header names/values
     BEFORE the worker is touched (the auditor's repro path).
   - `server/src/engine/shims/http-transport.ts:358-365` — worker-side
     re-check (defense in depth) via the script-local `crlfIndex`
     (`:173-179`).
   - `server/src/engine/shims/http-headers.ts:29-40` — `firstCrlfIndex`
     (the shared scanner). **FMD2 parity holds for STORAGE** (the jar keeps
     raw values verbatim, audit A2 behavior unchanged — the wire boundary
     is what sanitizes); documented in COMPAT.md's HTTP divergences.
2. **Worker resilience.** `http-transport.ts:478-490` — the pump's
   `perform()` call is try/catch-wrapped → `writeResult(ok:false,
   'loopback transport worker fault: …')`; a poisoned request fails
   ITSELF, never the loop.
3. **Lifecycle.** `http-transport.ts:566-578` — `worker.on('exit')` /
   `worker.on('error')` clear `this.worker` (same-instance guard), so the
   next `send()` recreates the transport; the error handler also keeps a
   worker fault from propagating into the parent thread.

**Verifying tests** — `server/test/engine/shims/http-transport-crlf.test.ts`:
- `:123` the auditor's A2b repro as a committed vitest: poisoned
  CRLF Cookie header → immediate typed error (`/CR\/LF.*wire boundary/`,
  < 3 s, not the pre-fix 5 s/120 s hang), zero server captures
  (no header injection, no request at all), subsequent request OK (200);
- `:161` CRLF in a header NAME refused at the same boundary;
- `:174` worker-fault resilience: an invalid header token the boundary
  cannot pre-reject fails typed INSIDE the worker (`/worker fault/`) and
  the transport keeps serving;
- `:203` forced worker exit → `this.worker` cleared → next send
  recreates a NEW worker and succeeds;
- `:260-308` pipeline boundary unit tests: CRLF in header values
  (`:260`), unlimited-retry hard-stop (`:271`), CRLF in cookie
  VALUES (`:279`, raw jar storage untouched), cookie NAMES
  (`:291`), clean request afterwards still carries cookies/headers
  (`:299`).

## F-2 (MAJOR, silent auth breakage) — MODULE cookie methods were silent no-ops

Implemented over the §5.3 per-module shared cookie store
(`module_state.cookies` / `SharedCookieJar`) with FMD2 CookieManager
persistence + request-injection semantics:

- `server/src/engine/lua/module-facade.ts:138-155` — the four methods over
  the backing jar (`AddServerCookies`/`GetServerCookies`/`RemoveCookies`/
  `ClearCookies`); `:459-493` `addModuleServerCookies` (newline-split
  Set-Cookie lines, first pair = the cookie, attributes dropped;
  **note3**: `';'`-joined `MODULE.Account.Cookies` lists accepted too —
  Madokami parity), `:495-516` `removeModuleCookies` (name / list / no-arg
  = clear the per-module store — the SoftKomik.lua:135 logout form),
  `:517-537` `moduleCookieText` (the `GetServerCookies('')` /
  Account.Cookies form). Default backing is a private jar — never a silent
  no-op (module-facade.ts:92-112).
- `server/src/engine/lua/module-facade.ts:322-336` — `MODULE.Account.Cookies`
  setter now coerces like FMD2's `lua_tolstring` (object → `''`, the
  Madokami.lua:74 `= HTTP.Cookies` quirk preserved; numbers/strings pass).
- `server/src/engine/events/dispatcher.ts:53-67,305-310` —
  `DispatcherShims.moduleCookies` threads THE one §5.3 jar into every
  MODULE binding.
- `server/src/engine/state/module-state.ts:561-578` — `persistState`
  merges the jar into the persisted cookies text (settings first, jar
  last-writer, FMD2 settingsText `;`-join); `seedFromPersistence` re-seeds
  the jar on load (restart round-trip).
- **Request injection + runtime wiring**: the same jar flows into
  `installShims({sharedCookies})` so every module HTTP object's outgoing
  `Cookie` header carries the server cookies — wired through
  `EngineInfoService` (engine-info.ts:110-152), `EngineDownloadHooks`
  (download-engine.ts:116-166 + dispose persist),
  `EngineLoginDriver` (account-login.ts:112-159), and
  `EngineDirectoryWalker` (directory-walk.ts:131-177); assembly.ts:302-312
  creates the ONE process-wide `ModuleStateService`. The harness accepts
  `sharedCookies` (test/engine/e2e/harness.ts:53-61,101-119).

**Verifying tests**:
- Unit — `server/test/engine/lua/module-cookies.test.ts:21-56` (parsing
  forms incl. the SoftKomik single-pair `:21`, attribute-dropping
  Set-Cookie lines `:34`, newline-split `:41`), `:62-86` (RemoveCookies
  name/no-arg/list), `:90-104` (the `GetServerCookies('')` text form over
  both jar shapes), `:106-135` (persistState merge + **restart round-trip:
  a NEW state service over the same persistence re-seeds the jar** `:106`,
  and the jar-overrides-settings conflict case `:126`).
- Real-module e2e — `server/test/engine/e2e/module-cookies.e2e.test.ts`:
  `:33` **the REAL SoftKomik.lua flow** (Login → `Storage['Auth']` →
  `MODULE.AddServerCookies('tokkey=' …)` → the outgoing request carries
  `Cookie: tokkey=Bearer TKN123` server-side; disabled →
  `MODULE.RemoveCookies()` clears → unauthenticated), `:88` **the REAL
  Madokami.lua flow** (seeded `Account.Cookies` `';'`-list injected
  server-side), `:107` (Login Set-Cookie harvest — Account.Cookies
  object-assignment `''` quirk — server-side re-injection — disabled →
  `ClearCookies`), `:163` **persistence across a state-service
  restart** (module-added cookies flow into requests under a NEW service
  over the same `module_state` row, no re-add).

## F-3 (MINOR) — dead production export `emptySnapshot`

- Removed: `server/src/engine/state/module-state.ts` (the function after
  `persistState` is gone; the barrel re-export needs no edit).
- `server/test/smoke.test.ts:139-150` — the test now constructs the §9
  projection through the PUBLIC path (`new ModuleStateService().snapshot(id)`),
  asserting the same empty/unknown shape plus `settings.enabled`/
  `bypassBusy`.

## N-2 (NOTE) — TASK.CurrentDownloadChapterPtr/CurrentMaxFileNameLength=0 equivalence made explicit

- `docs/COMPAT.md` "Known behavioral divergences" item 5 (generated):
  the one-chapter-per-job equivalence — FMD2's 0-based `Strings[i]`
  (LuaStrings.pas:88) means readers (MangaFire.lua:324, DataLife.lua:112)
  get the IDENTICAL link; EHentai.lua:156's limit check correctly inert
  with 0 = no limit; host-side D5 truncation owns the filename limit.
  Source: `corpus/scripts/generate-compat.ts` (divergences list), so the
  sentence survives every regeneration.

## N-4 (NOTE) — defensive try/catch around the pluggable antibot check

- `server/src/engine/state/antibot.ts:143-158` — `checkAntiBotActive`
  wraps the injected check; a throwing check reads as "not an antibot
  page" (FMD2 log-and-continue, LuaWebsiteBypass.pas:112-114), the global
  check lock releases, and `intercept` completes the plain request.
- Test — `server/test/engine/state/antibot.test.ts:437-464`: a throwing
  injected check → `{result: false, antibotHit: false, path: 'plain'}`, no
  gate entry, and a SECOND intercept still runs the check (lock healthy).

## COMPAT.md LuaWebsiteModules row (F-2 completion record)

- `corpus/scripts/generate-compat.ts:204-207` unitStatus row updated:
  module cookie methods implemented over the §5.3 shared jar with the
  request-injection + module_state persistence semantics and the
  real-module test pointer; COMPAT.md regenerated
  (`npm run corpus`: 912/912, gate ≥99 % + zero undocumented mismatches,
  artifacts byte-stable). No capability flags changed — SoftKomik and
  Madokami were never flagged known-broken and are now actually healthy.
  The F-1 wire-boundary sanitization note was added to the curated HTTP
  shim divergences (docs/COMPAT.md, "The wire boundary refuses CR/LF…").

## F-5…F-10 — untouched (accepted divergences)

No production behavior of the accepted NOTEs was modified.
