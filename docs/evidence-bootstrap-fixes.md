# Evidence: bootstrap launch-defect fixes (tsk-scenic-beacon-speeds)

Three launch-blocking defects found by actually running the dev-preview
launch in this workspace, plus one transport fallback. Every repro below
was re-run after the fix — each launch failure fails to reproduce.

## Defect (a): zero-tolerance staged validation could never pass a real tree

**Repro (before):** D20 bootstrap on an empty data dir against the real
FMD2 pin — staged validation refused with a failure list. TWO layered
causes, both fixed:

1. `validate.ts` ran the Init pass WITHOUT the §5.7 require shim (the
   registry sweep installs it) — every module that requires a
   template/util failed Lua's native `package.path` lookup
   (`no file './templates/Madara.so'`), so the failure count was dozens,
   not the ~5 upstream-broken files.
2. The gate itself was zero-tolerance (`validate.ts:15` "a broken module
   refuses the whole sync") — even with correct wiring, the real tree's
   5 permanently-broken files (the D3 published set) refused the sync.

**Fix:**
- `server/src/sync/modules/validate.ts` now runs the SAME shim wiring as
  the sweep (offline `RecordedResponseResolver`, deadline cells,
  `luaRoot: stagedDir`) and gates through the shared
  `TolerancePolicy.decide` from `contract/tolerance.ts` (≤5 files AND
  ≤1% of module files — whole-file `ceil` rounding; 417 × 1% = 4.17 → 5
  — AND none previously registered).
- Regression guard: a failing file that appears in the previous sync's
  inventory refuses the sync (`toleranceReason: 'regression'`).
- `ModuleSyncReport.failures[]` (file + firstError) lands in
  `sync-state.json`, is returned by `POST /api/sync/modules`, rendered
  in Settings (`web/src/pages/SettingsPage.tsx`), and logged as
  warnings by the bootstrap (`bootstrap: WARNING — module sync
  tolerated N upstream-broken file(s)`).
- The sweep summary annotates `withinTolerance` from the SAME contract
  constants (single source, no second opinion).

**Fail-to-reproduce commands (after):**

```
$ npx vitest run server/test/sync/modules/staged-tolerance.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
# — real 417-module-file tree (the whole 486-file lua/ dir packed as a
# — zipball): sync PROCEEDS, failures[] == exactly the 5 known-broken
# — files, 454 modules register, re-sync re-admits, one regressed
# — previously-registered file refuses as regression.

$ npx vitest run server/test/sync/modules/ server/test/engine/registry/sweep.test.ts
 Test Files  7 passed (7)      Tests  52 passed (52)
# — sweep summary.withinTolerance === true at 5/417 (shared constant).
```

Unit matrices for the policy itself: `contract/test/tolerance.test.ts`
(13 tests: boundary 417→5, cap, ratio, regression precedence).

## Defect (b): default FMD_DB_URL carried a phantom `/db` segment

**Repro (before):**

```
$ curl -sI https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/db/7z/010777f53bf2414fad039b9567c8a9ce.7z
HTTP/2 404                          ← every default catalog fetch 404'd
$ curl -sI https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/7z/010777f53bf2414fad039b9567c8a9ce.7z
HTTP/2 200                          ← the real layout (FMD2 dist config.json db_url)
```

**Fix:** `server/src/sync/db/sync-service.ts` — `DEFAULT_FMD2_DB_URL`
composes to `https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master`
(no `/db`); every blob URL flows through the one `catalogBlobUrl()`
composition point. Path audit: all call sites are override-driven
(`FMD_DB_URL` env / `CatalogSyncOptions.dbUrl`); the loopback mock trees
(runtime fixtures, `e2e/prep.mjs`, `scripts/e2e.sh`, compose e2e env)
were re-based to mirror the LIVE layout (`/FMD2-DB/master/7z/…`) so the
mock can never again bless a phantom path.

**Fail-to-reproduce commands (after):**

```
$ npx vitest run server/test/sync/db/db-url-default.test.ts
 Test Files  1 passed (1)      Tests  5 passed (5)
# — offline: default constant, composition to .../master/7z/<id>.7z,
# — trailing-slash trim, and one loopback fetch asserting the requested
# — path is /7z/<id>.7z and NOT /db/...

$ FMD_LIVE=1 npx vitest run server/test/live   # (npm run test:live)
 ✓ HEAD-verifies every default catalog id against live FMD2-DB (200)
# — the default URL 200s against live FMD2-DB in the gated test.
```

## Defect (c): default catalog IDs rot upstream unnoticed

The four FMD2 dist-config `default_selected_websites` IDs were observed
dead (404) during the launch attempt (FMD2-DB periodically purges
retired sites; at evidence time they served again — upstream rot is
dynamic, which is exactly why defaults need gating, not hoping). They
are replaced by a curated, verified-live set living in SERVER CONFIG
(`server/src/runtime/catalog-defaults.ts`), cross-referenced against
BOTH the pinned tree (each registers — KLManga.lua:7, InManga.lua:66,
MangaPark.lua `09d49c77…` = the mangapark.me registration,
Hentai2Read.lua:97) AND live FMD2-DB (HEAD 200):

| name | id | tree | live HEAD |
|---|---|---|---|
| KLManga | `010777f53bf2414fad039b9567c8a9ce` | registered | 200 |
| InManga | `03ae42ac9141443fa0711bd401c0203d` | registered | 200 |
| MangaPark (mangapark.me) | `09d49c7760904bc2817dbc80757de44a` | registered | 200 |
| Hentai2Read | `053da85062184626a0a1ff6d57c3c955` | registered | 200 |

`FMD_BOOTSTRAP_CATALOGS` (csv) still overrides entirely (compose/e2e/
dev stay override-driven). The network-gated CI check
(`server/test/live/defaults-live.test.ts`, opt-in `npm run test:live` /
`scripts/ci.sh --live`, skipped by default — the zero-network guard
honors `FMD_LIVE=1` for exactly that run) HEAD-verifies every default
ID so rot is caught, not discovered by users.

**Fail-to-reproduce command (after):**

```
$ npx vitest run server/test/runtime/runtime.test.ts
 Test Files  1 passed (1)      Tests  9 passed (9)
# — 'defaults only': empty data dir + loadRuntimeConfig with ONLY
# — network overrides → bootstrap installs ALL 4 curated catalogs
# — (mock log shows /FMD2-DB/master/7z/<id>.7z for each) → /readyz 200.
```

## Defect (d): codeload zipball HTTP 500 — tarball fallback

**Repro (before, live):**

```
$ curl -sI https://codeload.githubusercontent.com/dazedcat19/FMD2/zip/97c903b340d2b0fd82871dba1b0aa5f04a1790e8
HTTP/2 500                                    ← the launch blocker
$ curl -sL https://api.github.com/repos/dazedcat19/FMD2/tarball/97c903b340d2b0fd82871dba1b0aa5f04a1790e8 -o fmd2.tar.gz
http=200 bytes=13731414 type=application/x-gzip
$ tar -tzf fmd2.tar.gz | head -1
dazedcat19-FMD2-97c903b/                      ← root convention: <owner>-<Repo>-<sha7>
```

**Fix:** `server/src/sync/modules/fetch.ts` — `CodeloadArchiveFetcher`
tries zipball, falls back ONCE to
`<tarballApiBaseUrl>/repos/<repo>/tarball/<sha>` (default
`https://api.github.com`, env `FMD2_TARBALL_API_BASE`) when the zipball
leg is unreachable or 5xx; 4xx fails fast (wrong pin ≠ transport).
`tarball.ts` is a minimal gzip+ustar reader (pax `path=`, GNU longname,
ustar prefix; validated byte-exact against the REAL GitHub tarball:
879 entries, single root, 486-file lua/ subtree, binaries intact).
Root verification per format: zip `<Repo>-<sha10>`, tar
`<owner>-<Repo>-<sha7>` (both case-insensitive). Typed
`ModuleSyncFetchError` carries `{kind, attempts[]}` into the refusal
details. `FMD_LUA_DIR` remains the manual escape hatch (fetch never runs
under it — asserted in module-sync.integration).

**Fail-to-reproduce commands (after):**

```
$ npx vitest run server/test/sync/modules/fetch-fallback.test.ts
 Test Files  1 passed (1)      Tests  7 passed (7)
# — canned 500 zipball → tarball serves → tree installs (both legs hit);
# — both legs dead → typed 'unreachable'; 500+503 → typed 'http-error'
# — with the full attempts chain; zipball 404 → tarball NEVER fires;
# — tarball root naming another commit → sha-mismatch refusal.
```

## Full gate

```
$ npm test
 Test Files  157 passed (157)
      Tests  1658 passed | 3 skipped (1661)     # 3 = the live-gated checks

$ npx eslint <every file this story touched>    # exit 0
$ npx tsc -b server contract                    # exit 0
```

Repo-wide `npm run lint` / `npm run typecheck` currently also flag
`scripts/capture-design-evidence.mjs` and `web/e2e/perf.spec.ts` —
those belong to the concurrent design-system worker's uncommitted
in-flight files (untouched by this story except one syntax unblock in
`web/src/components/patterns/ListPanel.tsx` so the shared parse could
proceed); everything this story added or modified is clean.

Bootstrap = module sync (tolerant) → registry sweep (unchanged model) →
catalog installs (correct URL, live defaults). Every failure is typed
and surfaced; none is silent.
