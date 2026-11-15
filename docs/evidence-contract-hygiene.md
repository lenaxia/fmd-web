# Evidence — tsk-vanilla-canal-kicks (audit bucket C: contract hygiene)

Audit bucket C — three lies/fragilities in the contract-tooling surface,
all closed. No engine behavior changed (the §5.7 loader registers the
exact same libs; proven by the full engine test suites).

## 1. `requireShims[].status` is now DERIVED, not hand-edited

**Chain of trust:** loader runtime → `REQUIRE_SHIM_REGISTRY`
(`server/src/engine/shims/require-registry.ts`) → drift-check gate →
contract.json.

- The registry is consumed BY the loader itself: `installRequireShim`
  (`server/src/engine/shims/lua-require.ts`) iterates the registry table
  to register host libs (`fmd.env`, `fmd.duktape`, `fmd.fileutil`,
  `fmd.subprocess`) — registration cannot drift from the registry by
  construction. `pb` and `fmd.crypto` install through their own
  engine-bound `package.preload` bridges (`installPbShim` /
  `installCryptoShim`), matching their `package-preload` registry rows.
  A host-lib registry row without a loader factory fails loud at
  install time.
- Runtime agreement is proven, not assumed:
  `server/test/engine/shims/require-registry.test.ts` installs the shim
  on a real wasmoon engine and requires EVERY registry row — every
  non-planned row resolves (host libs, both preloads, and both
  file-chunk trees `utils.*`/`templates.*`), every planned row fails.
  The `subprocess` row serves its real loader key `fmd.subprocess`
  (that is what FMD2's own lua tree requires — `utils/nodejs.lua:41`)
  with denied-stub semantics intact.
- The drift-check
  (`contract/tools/drift-check.ts`, `diffRequireShims`) cross-checks
  contract.json `requireShims[].status` against the registry as the
  single source of truth and fails on ANY divergence, in both
  directions, plus structural invariants (partial ⇔ gap note,
  non-planned ⇔ actually served, planned ⇔ unserved, row-set equality).
- The sanctioned CLI is now `scripts/contract-drift-check.ts` (run
  under tsx by `npm run contract:check`): it imports the REAL registry
  from the server sources and always attaches it. There is
  deliberately no registry-less CLI path — the old
  `node dist/tools/drift-check.js` entry (which silently skipped
  status checks) is gone. Cross-package direction stays clean
  (contract ← server; the wrapper is the only bridge).

**Mutation proofs (a lying status fails the gate):**

| Mutation | Level | Result |
|---|---|---|
| `fmd.duktape`: implemented → planned (claims LESS) | vitest, real registry (`require-registry.test.ts`) | exit 1, `requireShims["fmd.duktape"].status: contract=planned registry=implemented` |
| `subprocess`: stub → implemented (claims MORE) | vitest, real registry | exit 1, `requireShims["subprocess"].status: contract=implemented registry=stub` |
| `fmd.env`: implemented → planned | vitest, contract-side (`drift-check.test.ts`) | exit 1, `requireShims["fmd.env"].status: contract=planned registry=implemented` |
| `fmd.gzip`: planned → implemented | vitest, contract-side | exit 1, `requireShims["fmd.gzip"].status: contract=implemented registry=planned` |
| `pb`: implemented → planned (hand-edited temp contract) | CLI (`npx tsx scripts/contract-drift-check.ts --contract /tmp/…/lying-contract.json`) | `contract drift: requireShims["pb"].status: contract=planned registry=implemented`, exit 1 |

**All 13 entries corrected** (status vocabulary extended with
`implemented` in `contract/types.ts` + `contract/schema/contract.schema.json`;
previously nothing could say "implemented" — that WAS the lie enabler):

| require | was | now (registry-derived) |
|---|---|---|
| fmd.env | planned | implemented |
| fmd.crypto | partial | implemented |
| fmd.duktape | planned | implemented |
| fmd.gzip | planned | planned (unserved) |
| fmd.fileutil | planned | partial (gap: SerializeAndMaintainNames — only 2/3 helpers exist; implementation note made truthful) |
| fmd.imagepuzzle | planned | planned (unserved) |
| fmd.logger | planned | planned (unserved — print routing is not a require-able lib) |
| fmd.mangafoxwatermark | planned | planned (unserved) |
| fmd.pcre2 | planned | planned (unserved) |
| fmd.strings | planned | planned (TStrings facade exists, but `require 'fmd.strings'` is not served; note made truthful) |
| pb | planned | implemented |
| subprocess | stub | stub (denied stub §5.11) |
| utils.* / templates.* | planned | implemented (file-package loader) |

Gate green: `npm run contract:check` →
`contract drift-check: OK — 0 mismatches (events + TXQuery/Storage/ImagePuzzle/Duktape/Crypto facades + requireShims statuses vs FMD2/baseunits/lua + shim loader registry)`.
The drift-check mutation suite: 27 tests green
(`contract/test/drift-check.test.ts`), registry suite 7 green.

## 2. `tsx` declared; clean-checkout reproducibility

- `"tsx": "4.23.15"` (EXACT pin) in root devDependencies; lockfile
  updated (`package-lock.json` root devDependency + `node_modules/tsx`
  entry). `npx tsx` previously resolved only through the npx download
  cache — now `tsx` is a local bin (`node_modules/.bin/tsx`), so both
  `npx tsx` and the new `npm run corpus` resolve offline.
- Root npm script added: `"corpus": "tsx corpus/scripts/generate-compat.ts --gate"`
  (the gate command previously reachable only via scripts/ci.sh).
- `scripts/ci.sh` now calls `npm run corpus` (single-sourced).

**Clean-checkout offline proof (documented CI run):**

1. Working tree copied WITHOUT `node_modules` (clean checkout state) to
   `/tmp/opencode/clean-checkout`.
2. npx cache REMOVED (`mv ~/.npm/_npx ~/.npm/_npx.bak.tsxproof`) — the
   resolution shortcut the audit flagged is gone.
3. Network blackholed (`HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:9`).
4. `npm ci --offline` → exit 0 (lockfile fully satisfied from cache;
   tsx 4.23.15 installed).
5. `npm_config_offline=true npm run corpus` →
   `corpus gate passed: >=99% with zero undocumented mismatches`, exit 0,
   with the npx cache still absent.

## 3. Machine corpus report committed + staleness-gated

- The corpus gate now also writes `docs/corpus-report.json` — the
  versioned replay report (per-module and per-expression pass rates:
  summary, 65 module rollups with per-case status, 27 normalization
  cases). Committed (staged) alongside docs/COMPAT.md.
- Serializer: `serializeCorpusReport` (`corpus/runner/replay.ts`) —
  deterministic bytes AND machine-independent: engine error values can
  embed stack traces with absolute checkout paths (fontoxpath JSON
  parse errors), so the serializer strips the repo root from the
  payload. This fixes a latent byte-stability bug (the pre-existing
  golden would only match at one absolute path). Both goldens were
  regenerated accordingly
  (`server/test/engine/golden/seed-corpus-live-report.golden.json`,
  `docs/corpus-report.json`).
- Golden test (byte-stability on replay):
  `server/test/engine/shims/corpus-live.test.ts` — new test pins the
  committed `docs/corpus-report.json` against a fresh replay
  (`UPDATE_GOLDEN=1` regenerates), plus the existing report golden now
  serialized through the same function.
- `scripts/ci.sh` staleness diff extended to BOTH artifacts:
  `git diff --exit-code -- docs/COMPAT.md docs/corpus-report.json`
  (same pattern as COMPAT.md; a stale committed report gate-fails the
  corpus step). Verified: mutating the report → diff exit 1; restoring
  → exit 0.
- Byte-stability proven across TREES: fresh `npm ci` clean checkout at
  `/tmp/opencode/clean-checkout` replays to `docs/corpus-report.json`
  byte-identical (`cmp`) to the shared-tree artifact — different
  checkout paths, offline, same bytes. The committed report is also
  byte-identical to the engine golden.

## Gate results (this workspace, at delivery)

- `npm run contract:check` — GREEN (registry-attached drift check).
- `npm run lint` — GREEN (all new/modified files).
- `npm run typecheck` — GREEN (strict, all projects).
- `npm run corpus` — GREEN (`912/912 = 100.00%`, zero undocumented).
- `npm test` — my scope fully green (drift-check 27, require-registry 7
  incl. wasmoon runtime proofs, corpus-live 4 incl. report parity,
  contract 88, shims suites 112 passed in the focused sweep). The full
  suite currently carries 3 failures owned by an IN-FLIGHT parallel
  task actively editing those exact files in this shared tree
  (`openapi.test.ts` snapshot, `settings.test.ts` proxy override,
  `crypto-composed.test.ts` EncryptString vector — all inside the
  parallel pb-shim/crypto-shim refactor's diff; zero overlap with this
  task's files).

## Pre-existing blocker fixed (out-of-scope one-liner, disclosed)

`server/src/accounts/secret-box.ts:59` called the nonexistent
`cipher.getTag()` (node API: `getAuthTag()` — the decode side already
used `setAuthTag`). It failed `tsc -b` (TS2339) at HEAD and would
throw at runtime in `sealSecret`, blocking the typecheck gate for the
whole repo. Fixed with the one-token correction; no other account
files touched.

## Files touched (this task)

- contract: `types.ts` (ShimStatus + registry types),
  `schema/contract.schema.json` (enum + implemented), `contract.json`
  (13 statuses + truthful notes + groundTruth), `tools/drift-check.ts`
  (requireRegistry cross-check, exported parseArgs +
  reportDriftCheckResult, no registry-less CLI), `test/drift-check.test.ts`
  (status mutation suite), `package.json` (contract:check via tsx
  wrapper; `./tools/drift-check` export).
- server: `src/engine/shims/require-registry.ts` (NEW — single source
  of truth), `src/engine/shims/lua-require.ts` (registry-driven
  registration; re-export), `test/engine/shims/require-registry.test.ts`
  (NEW — gate parity + mutations + wasmoon runtime proofs),
  `test/engine/shims/corpus-live.test.ts` (report golden), and the
  disclosed `src/accounts/secret-box.ts` one-liner.
- corpus: `runner/replay.ts` (serializeCorpusReport),
  `scripts/generate-compat.ts` (report write + CLI guard).
- root: `package.json` (tsx exact pin + `corpus` script),
  `package-lock.json`, `scripts/contract-drift-check.ts` (NEW),
  `scripts/ci.sh` (`npm run corpus` + report staleness),
  `vitest.config.ts` (drift-check alias), `docs/corpus-report.json`
  (NEW committed artifact), this evidence file.
