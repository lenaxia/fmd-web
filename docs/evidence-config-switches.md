# Evidence — tsk-rested-tanker-pricks (config switches: D5 `--normalize-paths` opt-out + D20 `FMD_BOOTSTRAP_DISABLE`)

Date: 2026-11-15T05:35Z (rev. 2 — review-fix bounce 1, 05:50Z: the DESIGN.md §14 D20 row edit had been clobbered by a concurrent writer in the shared tree and the evidence table cited that stale state; the row is re-applied and re-verified — see Verification log) · Environment: node v24, TypeScript 5.9 project references, vitest 3 (offline) · Scope: bucket-C audit findings — the two decision-log switches that were documented but unimplemented.

## Scope

Two config switches promised by the DESIGN.md §14 decision table were missing:

1. **D5** — filename/path semantics default to Windows-desktop parity
   (tail truncation over `CurrentMaxFileNameLength`), but the promised
   `--normalize-paths` opt-out did not exist
   (`server/src/jobs/library/filenames.ts`,
   `server/src/jobs/download/filenames.ts`).
2. **D20** — the first-run auto-bootstrap (module + catalog sync on an
   empty data dir, `server/src/runtime/assembly.ts` +
   `bootstrap.ts`) had pacing/catalog knobs but no explicit disable
   switch.

## Delivered

- **`contract/types.ts` — the shared D5 policy (single choke point)**:
  `FileNamePolicyMode` (`windows-parity` | `linux-normalized`),
  `FMD_NORMALIZE_PATHS_ENV` / `FMD_NORMALIZE_PATHS_FLAG`,
  `normalizePathsRequested(env, argv)` (exactly `FMD_NORMALIZE_PATHS=1`
  enables; the CLI alias `--normalize-paths` anywhere on argv enables),
  `fileNamePolicyMode(...)`, `linuxNormalizeFileName` (deletes C0 +
  DEL only — C1/Unicode kept), and **`applyFileNamePolicy(name,
  request)`** — parity = exact uDownloadsManager.pas:543-550 tail
  survival; normalize = control-unit deletion and `maxLength` IGNORED.
  No mode logic exists anywhere else.
- **`server/src/jobs/download/filenames.ts`**: the previously INLINE
  (duplicated) truncation in `composeFileName` is replaced by the
  shared policy (new trailing optional `mode` param; default resolves
  from env/argv inside the choke point).
- **`server/src/jobs/library/filenames.ts`**: `resolveChapterFileName`
  routes every winning candidate through the same policy (new
  `mode?` on `ChapterFileNameParts`); parity sanitization
  (RemoveSymbols/Trim) is unchanged and stays here. The §7.1
  fixed-depth LAYOUT caps (finalize/download-lane) are not D5 page-name
  semantics and remain parity-only — documented in the module doc.
- **D20 disable switch**: `FMD_BOOTSTRAP_DISABLE=1` →
  `loadRuntimeConfig` sets `bootstrapDisabled` (exactly `'1'`;
  `RuntimeConfig.bootstrapDisabled`); `buildRuntime` passes
  `disabled: true` to `BootstrapRunner` (whose `run()` short-circuits
  to `done` with the disable log line — module sync, registry sweep
  and catalog syncs never fire) and pairs it with
  `ReadinessProbe({ requireLuaTree: false })` (new additive option,
  default true) so `/readyz` is green on an empty data dir. The live
  info 503 reason names the flag when the registry is unprovisioned.
- **Tests** (offline, all green):
  - `server/test/jobs/filename-policy.test.ts` (NEW, 41 tests): the
    mode resolver (env exact-`1`, CLI alias, precedence, choke-point
    env/argv resolution), `applyFileNamePolicy` both-modes table,
    `linuxNormalizeFileName` boundary table, and the SAME fixture sets
    run through BOTH modes — the committed `filename-cases.json`
    golden set re-verified in explicit parity mode + normalized
    (oracle = parity-without-maxLength + control strip), plus
    hand-written literal rows for both modes through
    `resolveChapterFileName` and `composeFileName`
    (truncation-only-in-parity, control-unit deletion/fall-through,
    DEL-only candidate falls to the next resolution candidate).
  - `server/test/runtime/runtime.test.ts`: NEW D20-disable integration
    test — empty data dir + `bootstrapDisabled: true` → disable log
    line present, NO `empty data dir — running module sync` /
    `registry ready` / `syncing catalog` log lines, `services.jobs`
    list empty (zero sync jobs enqueued), mock-upstream request log
    byte-identical before/after (zero upstream traffic incl. the §6.1
    commits check), `data/lua/modules` + `data/catalogs` absent,
    `/readyz` 200 `{ready:true}`, and live info 503s with the
    `FMD_BOOTSTRAP_DISABLE=1` reason. `loadRuntimeConfig` env test
    extended (`'1'` → true; `'0'`/`''`/unset → false).
  - Golden tests UNCHANGED and passing:
    `filenames.golden.test.ts` (flag unset = byte-identical) +
    `download/filenames.test.ts`.
- **Docs**: README gains an "Environment variables (runtime)" table
  (both switches + the documented runtime surface); runbook gains
  "First-run bootstrap (D20) — the three knobs" (`FMD_BOOTSTRAP_CATALOGS`,
  `FMD_BOOTSTRAP_DELAY_MS`, `FMD_BOOTSTRAP_DISABLE`) + a disabled-
  deployment procedure + a "Filename parity vs Linux-normalized (D5)"
  section; DESIGN.md §14 rows **D5** and **D20** moved to
  **implemented**.

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Normalize-paths mode: table-driven tests cover both modes over the shared policy function; parity goldens unchanged with flag unset | `server/test/jobs/filename-policy.test.ts` — the committed `filename-cases.json` resolve set run in explicit parity (=== committed expected) AND normalize mode (=== parity-minus-truncation oracle) per case, plus literal both-modes tables over `applyFileNamePolicy`, `resolveChapterFileName`, `composeFileName`; `npx vitest run server/test/jobs/filename-policy.test.ts server/test/jobs/library/filenames.golden.test.ts server/test/jobs/download/filenames.test.ts` → 3 files / 112 tests passed (goldens untouched) | met |
| Bootstrap disable: test proves zero sync jobs enqueued when flag set; readyz green; runbook section added | runtime.test.ts `FMD_BOOTSTRAP_DISABLE=1: empty data dir → zero sync work, /readyz green`: `services.jobs.list({limit:1000})` → 0 jobs (zero sync jobs enqueued), mock-upstream request log path-list byte-identical before/after (zero upstream traffic — the §6.1 commits check never fires), disable log line asserted, `data/lua` + `data/catalogs` absent, `/readyz` → 200 `{ready:true}` (bootstrap done + probe with `requireLuaTree:false`); runbook "First-run bootstrap (D20) — the three knobs" documents all three knobs + the disabled-deployment procedure; DESIGN.md §14 D20 row updated to **implemented** with the switch name | met |
| Both switches documented in README env table; D5/D20 rows updated in the release-notes decision table | README "Environment variables (runtime)" table rows `FMD_NORMALIZE_PATHS` (+ CLI alias) and `FMD_BOOTSTRAP_DISABLE`; the repository's decision table is DESIGN.md §14 (no separate release-notes file exists) — D5 row (§14, line 780) and D20 row (§14, line 795) both say **implemented** with the exact switch names (D20 row re-applied in rev. 2 after the concurrent-writer clobber) | met |
| Flags unset = byte-identical (existing golden tests pass unchanged) | both golden test files are unmodified in this change and pass; parity mode reproduces the exact pre-switch code path (`applyFileNamePolicy` parity branch = the former `truncateKeepTail` semantics; `composeFileName` inline truncation removed, delegated to the same branch) | met |

## Verification log (offline)

- `npx vitest run server/test/jobs server/test/runtime server/test/observability` → **33 files / 373 tests passed** (incl. the new policy file, both untouched golden files, the new D20-disable runtime test, extended config test, and the observability suite over the additive `requireLuaTree` option)
- `npx vitest run contract/test` → 72 passed (contract package with the new policy exports)
- `npx eslint .` → clean
- `npx tsc -b tsconfig.json` → the ONLY error is pre-existing and outside this change: `server/src/accounts/secret-box.ts(59)` `getTag` (file unmodified from HEAD; the installed `@types/node` exposes `getAuthTag` only — dependency drift from parallel in-flight work in this shared tree, e.g. the modified `package-lock.json`). No error in any file this story touched.
- Full-suite run additionally shows 4 failures in `api/settings`, `api/openapi` (snapshot byte-diff) and `engine/shims/crypto-*` — none of these test files import anything this change modifies; they exercise `server/src/api/routes.ts` / `engine/shims/crypto-*.ts`, both carrying uncommitted diffs from parallel stories in this shared working tree (verified by import inspection; `server/src/runtime/` itself is untracked at HEAD, so a git A/B is not meaningful here).

## Rev. 2 (review-fix bounce 1)

- Finding: DESIGN.md §14 D20 row (line 795) was back to its pre-change text — the edit had been clobbered by a concurrent writer in the shared tree between implementation and review; the evidence table consequently cited a stale state (flagged lines 80–81).
- Fix: D20 row re-applied verbatim (`FMD_BOOTSTRAP_DISABLE=1` … **implemented**); D5 row (line 780) confirmed intact; implementation files re-verified intact by grep sweep (`bootstrapDisabled` ×5 in assembly.ts, `disabled` ×4 in bootstrap.ts, `requireLuaTree` ×4 in health.ts, policy refs in both filenames.ts modules + contract, README/runbook rows).
- Re-verified: scoped suites re-run green (see below).
