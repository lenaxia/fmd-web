# Evidence — tsk-ethereal-flatboat-waits (in_review verification)

Reviewer session: teal-dune-scores · 2026-11-13 · stage in_review, verdict **approve**

## Prior review blockers (quixotic-windmill-remembers, fail) — all resolved

1. `supervisor.test.ts` :119/:255 TS2339 (`outcome.failureKind` after non-narrowing `expect()`)
   → typed narrowing helper `assertFailed()` at :13-20; used at :129 and :264. `tsc` clean.
2. `bindings-golden.test.ts` :92 TS2322 (`{ ...row, ...patch }` under exactOptionalPropertyTypes)
   → `mutate()` now builds the row field-by-field with a `RowPatch` type whose keys cannot carry
   `undefined` (:88-114). `tsc` clean.
3. `bindings-golden.test.ts` :104 TS2322 (`{ ...rows[0] }` under noUncheckedIndexedAccess)
   → guarded extraction `const src = rows[0]; if (src === undefined) throw …` (:124-128). `tsc` clean.
4. Story-owned `tsc -b` errors blocking the CI gate → the four test-file errors above are gone;
   additionally the one remaining story-owned error `dispatcher.ts(36,49) TS2304 'FacadeSpec'`
   was fixed this review (missing type import: `import type { FacadeBridge, FacadeSpec } from
   '../lua/facade.js'`).

## Post-fix verification (this review)

- `tsc -b tsconfig.json`: **zero** errors under `server/src/engine/events`,
  `server/test/engine/events`, `server/src/engine/pipeline`, `server/test/engine/pipeline`,
  `server/tools`. All 60 remaining errors are confined to concurrently in-flight stories'
  files (state/antibot*, state/module-state*, state/persistence*, shims/duktape-shim*,
  shims/lua-require.ts, lua/storage.test.ts, shims/ixqvalue.test.ts) — matching the prior
  reviewer's attribution; none are story-owned.
- `npm run contract:check` → **OK — 0 mismatches** (events + facades vs FMD2 sources).
- vitest story suites: **77/77 passed**
  - `bindings-golden.test.ts` 11/11 — deep-equal vs contract.json (15 rows), byte-identical
    regenerated render, dispatcher table IS the generated table, sanity assertions,
    read-back/PAGENUMBER-only + URL-push-only rows, global-name union.
  - `supervisor.test.ts` 10/10 — hang→deadline→HTTP-abort→fail (no strike); wedged miss →
    strike; double-hang → recycle + `worker_stalled` + strikes reset; LUA_ERRMEM → quarantine
    + rebuild + retry-once → done, and retry-OOM → `engine_oom` (D6); RSS recycle at >25 %
    over the 2 GiB budget (threshold + exact-at edge cases); strike-ledger reset.
  - `dispatcher.test.ts` 32/32 — MODULE everywhere + per-row exact globals, net-status vs
    account-status constants, return-kind coercion per `lua_to*` semantics (code/boolean/
    string incl. wrong-return-type cases), PAGENUMBER read-back, URL push-only.
  - `chapter-pipeline.test.ts` 24/24 — 'W'/'D' PageLinks marker semantics (uDownloadsManager
    .pas:350-407): W/D skip, recount, resume reconciliation (file-exists→D, lost-file demote),
    chapter-level resume, full restart-resume scenario.
- `eslint` on all story-owned paths: clean (exit 0).

## Acceptance criteria

- [x] Generated binding table equals contract.json — generator `server/tools/generate-bindings.ts`
      (SHA-256 header + `assertGeneratedBindingsSanity` in `bindings.generated.ts`), golden test
      byte-identical + deep-equal; CI contract:check green (0 mismatches).
- [x] Fault-injection: hang→deadline→abort→fail; double-hang→recycle (`worker_stalled`);
      LUA_ERRMEM→quarantine+retry-once→`engine_oom` — supervisor.test.ts 10/10.
- [x] 'W'/'D' marker semantics on ChapterPipeline/ImageWorker — skip/resume/recount — 24/24.
- [x] Wrong-return-type coercion per `lua_toboolean`/`lua_tonumber`/`lua_tostring` semantics — 32/32.

## Note

Full `npm run ci` stays red at `tsc -b` solely due to the four concurrently in-flight
stories' files listed above; story-scoped typecheck, lint, contract drift, and all 77
story tests are green.
