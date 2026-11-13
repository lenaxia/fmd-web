# Evidence — tsk-vibrant-kelp-tramps (Phase-1 gate: seed corpus + COMPAT.md publication)

Phase-1 phase gate: the full seed corpus replays through the live query
engine at ≥99% result-equality (achieved: **100%**), every contract
binding is published as implemented / partial (gap) / deferred (cost),
the local CI script runs the five-step gate, and the nightly live smoke
harness skeleton is in place behind an explicit `--live` network gate.

## Delivered

**1. Corpus at 100% result-equality (912/912)**

- The four standing normalization mismatches (`getinfo-normalization-0004-prefixstrip`,
  `-0011`, `-0021`, `-0025`) were NOT engine divergences — they were a
  runner plumbing bug: the FPC oracle captures record the uData steering
  globals per capture (`corpus/fixtures/capture/*.triples.json` →
  `flags: {removeHostFromChapterLinks, optionRemoveMangaNameFromChapter}`,
  read by `corpus/harness/fmdnormalize.pas:73-79`), but the JS runner
  dropped them and forced the uData defaults. `norm-0021` captured with
  `removeHostFromChapterLinks: false` (expected keeps absolute
  `https://A.example/1`), the prefix-strip cases captured with
  `optionRemoveMangaNameFromChapter: true`.
- Fix (flag-faithful, oracle-semantics):
  - `contract/types.ts` — `NormalizationEngine.normalize(input, flags?)`
    (additive optional param; absent keys keep engine defaults).
  - `corpus/runner/corpus-loader.ts` — `CaptureTriples.flags` parsed
    (boolean-valued keys only) and threaded onto each normalization case.
  - `corpus/runner/replay.ts` — `runCorpus` forwards `c.flags` to the
    engine.
  - adapters (`server/test/engine/shims/corpus-live.test.ts`,
    `corpus/scripts/generate-compat.ts`) map capture flag names →
    `NormalizeFlags` (`isRemoveHostFromChapterLinks`,
    `OptionRemoveMangaNameFromChapter`) onto `normalizeMangaInfo`
    (whose prefix-strip port matches
    `fmdnormalize.pas:238-251` / `uData.pas:185-202` exactly —
    trim, then `- ` slice).
- `server/test/engine/golden/seed-corpus-live-report.golden.json`
  refreshed: `{"cases": 912, "passed": 912, "failed": 0, "passRate": 1}` —
  the committed pass-rate report artifact, byte-stable under the
  corpus-live golden test.

**2. COMPAT.md regenerated in gate vocabulary**

- `corpus/scripts/generate-compat.ts` now emits the Phase-1 gate
  vocabulary — `implemented` · `partial (gap: …)` · `deferred` — with
  every deferral carrying its module-count cost (counts over the 418-file
  FMD2 lua tree and the 67-module seed corpus; e.g. `fmd.imagepuzzle`
  deferred — 7/418 tree modules, 2/67 seed; `fmd.pcre2` deferred — 0
  consumers; `fmd.gzip` deferred — 1/418).
- **Review fix (blocker, binding coverage 22/22):** the tracker table
  initially omitted 5 contract.json bindings whose statuses existed in
  the generator's `bindingStatus` map but had no emitted rows —
  `fmd.env`/LuaFMD, `fmd.logger`/LuaLogger (partial: LuaLogger API,
  1/418), `fmd.mangafoxwatermark`/LuaMangaFox (deferred, 1/418),
  `utils.* / templates.*`, and the MangaInfo facade/LuaMangaInfo. The
  five rows were added to `unitStatus`+`boundaries` and the generator
  now carries a `BINDING_ROWS` map (contract.json binding → tracker
  row) whose `--gate` coverage check FAILS when any requireShims/facades
  binding lacks an emitted row — the 17/22-style omission is now a
  gate error (negative-tested: a partial row set reports every missing
  binding).
- **Review fix (major, per-module pass rates):** the corpus-replay
  section now publishes a `### Per-module pass rates` table — 65 seed
  module rows (module, cases, passed, failed, rate) from the
  `report.modules` rollup plus the uData §5.8 normalization rollup row
  (885 expression + 27 normalization = 912) — so the per-module pass
  rates live in COMPAT.md itself, not only in the golden report
  artifact. Generation is byte-stable (two consecutive runs diff-identical).
- Stale statuses corrected: crypto (story done → implemented), uData
  §5.8 (now oracle-verified at 100% with flag fidelity → implemented),
  HTTP (full §5.4 surface landed by tsk-native-trinket-stencils →
  implemented; its curated compatibility-notes section is preserved by
  the generator below the crypto marker).
- The failure table is empty (no mismatches; the v0 documented-divergence
  notes are retained).
- `--gate` mode: exit 1 when pass rate < 99%, any mismatch lacks a
  curated root cause, or any contract binding lacks a tracker row
  (`scripts/ci.sh` corpus step).

**3. scripts/ci.sh — the five-step local CI gate**

- Order per the criterion: `contract:check` → `lint` → `typecheck` →
  `test` → `corpus`; exits non-zero on the first failing step.
- The corpus step runs the full seed replay through the live engine,
  regenerates COMPAT.md under `--gate`, then fails if the committed
  COMPAT.md differs from the fresh (byte-stable) generation.
- The nightly LIVE smoke harness is deliberately NOT in ci.sh (needs
  `--live`; zero-network CI).

**4. Nightly live smoke harness skeleton (`server/tools/smoke/`)**

- `rotation.ts` — sorted seed listing + deterministic rotating window
  (`(rotationIndex * sampleSize) mod total`, wrap; UTC day number as the
  nightly rotation index; clamped size).
- `live-resolver.ts` — the repo's ONLY network resolver: satisfies the
  §5.4 shim resolver protocol over a synchronous single-hop `curl
  --compressed` subprocess (the Lua facade is synchronous; ONE HOP —
  the landed §5.4 pipeline owns redirect-follow/retry at FMD2 parity
  and calls back per hop); temp-file bodies/header dumps; conservative
  defaults (30 s, 8 MiB); transport failure → the Pascal failure shape
  (status 0, empty body).
- `smoke.ts` — per module: real engine session (Lua host + shims +
  contract dispatcher), live `GetInfo` dispatch, classification
  (dispatcher no_error + zero host error records + MANGAINFO read-back),
  per-module pass-rate JSON report. Gate: refuses without
  `{ live: true, resolver }`.
- `run.ts` — CLI: `--live` (the network gate; without it: plan-only
  JSON, no session, no sockets), `--module A,B`, `--sample N`,
  `--rotation-index N`, `--seed-dir`, `--url` (override), `--out PATH`.
- `README.md` — usage, rotation scheme, pass semantics, report shape,
  manual verification log.
- Unit tests (`server/test/tools/smoke.test.ts`, 16, offline): rotation
  windowing/wrap/clamp, CLI parsing, curl argv matrix, header-dump
  parsing (multi-hop last-block-wins, Set-Cookie, folded lines), the
  network gate itself (`runSmokeModules` rejects without the live
  construction), module-file location against the real tree.

## Manual --live verification

(`server/tools/smoke/README.md` carries the full log; summary:)

- `run.ts --sample 3` (no `--live`) → plan-only JSON, exit 0, zero
  network (the no-network vitest guard stays green in plan mode).
- `run.ts --live --module ManhwaIndo --url https://manhwaindo.id/manga/solo-leveling/`
  → **PASS** (verified twice: on the pre-landing shim and re-verified on
  the landed full-§5.4 shim with the single-hop resolver): live fetch,
  GetInfo dispatched through the contract dispatcher, net status 0,
  MANGAINFO read back (`title=""` chapters=0 is the site's actual parse
  result — the report is observability, not the compatibility gate).
- `run.ts --live --module ManhwaIndo --url http://manhwaindo.id/manga/solo-leveling/`
  → **PASS**: the site answers 301 for non-TLS; the landed §5.4
  pipeline followed the redirect live — redirect-follow verified
  against a real site, not only the mock server.
- Honest fails documented: MangaDex/AsuraScans with their homepage seed
  URLs fail URL parsing before any fetch (GetInfo needs a series URL) —
  the `--url` override exists exactly for this.

## Carry-over corrections committed with this gate

Left uncommitted by the interrupted predecessor of this story, verified
and included: the SecretStream state note fix in `docs/COMPAT.md`
(FMD2 `TSecretStreamState` = k 32 + nonce 12 + pad 20 = 64 bytes,
BaseCrypto.pas:1281-1285 — was misstated as 76), and the crypto-bridge
surface-count correction (60 → 59; `CRYPTO_METHOD_NAMES.length` is 59).

## Verification

- `npx vitest run` — the FULL suite at gate time: 53 files / 671 tests
  green (includes the corpus replay suites, the landed §5.4 HTTP
  mock-server integration suite, and the smoke tool units).
- `npx vitest run server/test/engine/shims/corpus-live.test.ts` —
  3/3 green (≥99% gate + documented-failures cross-check + byte-stable
  golden at 912/912).
- `npx tsc -b tsconfig.json` + `npm run lint` — clean (zero any,
  explicit boundary types).
- `bash scripts/ci.sh` — exits 0 end-to-end (contract:check, lint,
  typecheck, test, corpus gate + COMPAT freshness).
- `npx tsx corpus/scripts/generate-compat.ts --gate` — `912/912 =
  100.00%`, `corpus gate passed: >=99% with zero undocumented
  mismatches`.
- Live smoke: see the manual verification table above.
