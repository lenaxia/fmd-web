# Evidence — live smoke v1: ≥10-site GetInfo pass-rate report + D18 hook (tsk-marble-deckhand-refrains)

Task: `tsk-marble-deckhand-refrains` (gap-closure / live-evidence bucket B).

Audit finding: DESIGN §12 Phase-1's "live GetInfo correct on 10
heterogeneous sites" and §13.2's nightly live smoke existed only as a
`--live`-gated skeleton that had never run; the 100% corpus number is
offline-oracle evidence, not live evidence. D18 had no detection logic.
This task completed the harness, RAN it against live sites, added the
D18 hook, and wired report staleness into the board monitor.

## What landed

| Piece | File(s) | Contract |
|---|---|---|
| Heterogeneous suite (12 sites / 9 families) | `server/tools/smoke/sites.ts` | ≥10 sites, ≥5 families, all names in corpus/fixtures/seed with real module files (R-LS1) |
| Suite runner + report | `server/tools/smoke/live-suite.ts` | report schema `live-smoke-report/1`: generatedAt, environment, site list, per-module status/classification/latency, d18, requestLog |
| Rate limiting + fixed UA | `server/tools/smoke/pacing.ts` | ≥1s per host (sync `Atomics.wait` pacing), `SMOKE_USER_AGENT` forced on EVERY request; `assertRequestLog` re-checks both over the harness's own log |
| D18 detector | `server/tools/smoke/d18.ts` | pure `detectD18` over observations: advertised vs `Content-Encoding` vs decodability |
| Mock-cluster fallback | `server/tools/smoke/mock-cluster.ts` | worker-thread loopback servers + host mapping; SAME code path (PacedResolver → curl resolver → §5.4 pipeline → real modules) |
| CLI | `server/tools/smoke/run.ts` | `--suite`, `--mock`, `--blocker-note`, `--rate-ms`; live suite gated on `--live`; defaults `--out docs/live-smoke-report.json` |
| Core upgrades | `server/tools/smoke/smoke.ts`, `live-resolver.ts` | exported `runModuleGetInfo` (egress hook, lua-root CWD parity), classification taxonomy + latencyMs + resultCode; header salvage on curl content-decode failure |
| Tests | `server/test/tools/live-suite.test.ts` | 25 tests: detector matrix, pacing invariants, gates, CLI matrix, loopback mock-cluster integration + D18 probe end-to-end |

## Acceptance criteria → evidence

### 1. Smoke harness runs ≥10 heterogeneous sites and commits docs/live-smoke-report.json with per-module pass rates — DONE (live run; fallback also built + proven)

The worker environment REACHED the seed sites, so the committed
artifact is a real LIVE run. The mock fallback was still built,
tested, and demonstrated end-to-end (see below).

- Command: `npx tsx server/tools/smoke/run.ts --live --suite --out docs/live-smoke-report.json`
- Committed artifact: `docs/live-smoke-report.json`
  (`generatedAt: 2026-11-15T21:05:41.763Z`, `environment: "live"`)
- 12 sites / 9 families: **10 pass / 2 fail, passRate 0.833**, each
  row with status + classification + resultCode + `latencyMs` +
  detail. Highlights: MangaDex live JSON-API title parsed ("I Met the
  Male Lead in Prison"); KlikManga (Madara template) and AsuraScans
  parsed "Solo Leveling" live (AsuraScans chapters=201); ComicK parsed
  chapters=1774; EHentai served a public gallery (title parsed);
  18Comic (imagepuzzle family) completed GetInfo through the
  `fmd.imagepuzzle` require registration; HitomiLa / ManhwaIndo /
  NineManga / MangaKatana passed.
- Honest fails: MangaPlus — `setup`, detail carries the surfaced host
  error (`… modules/MangaPlus.lua:99: modules/MangaPlus.proto: No such
  file or directory` — the module reads its proto through the Lua VM's
  io layer, which cannot see the host filesystem even with the process
  CWD at the lua tree; a protobuf-family boundary, not a site failure)
  — and Tapas — `http` (net_problem on the chosen 404 slug).
- Latency + failure classification are per-module in the report;
  `d18.observations` = 44 response inspections.

### 2. Rate limiting + UA asserted by the harness's own request log; no live calls in default CI — DONE

- Pacing: `PacedResolver` enforces ≥1000 ms between same-host requests
  (sync `Atomics.wait`; default `--rate-ms 1000`), keyed per SITE host.
- Fixed UA: `SMOKE_USER_AGENT` (`fmd-web-live-smoke/1.0 (opt-in
  nightly suite; DESIGN.md §13.2; not a browser)`) REPLACES whatever
  the pipeline/module set — a documented suite-only divergence (the
  suite is observability, not a compat gate).
- The harness's own request log is the evidence: the live run's log
  holds 44 entries, every entry carries the fixed UA, per-host gaps
  held ≥1000 ms, and `requestLog.violations` = `[]` (both invariants
  re-checked by `assertRequestLog` at report assembly). The test
  suite proves violations are CAUGHT: a tightened 2000 ms threshold
  over the probe log's real same-host entries flags exactly the 2
  under-paced requests; a synthetic UA mismatch is flagged (R-LS3).
- `scripts/ci.sh` is UNTOUCHED (`git status` lists no ci.sh entry; its
  header still documents that the nightly LIVE smoke is "NOT part of
  CI by design"). Default CI (lint/typecheck/vitest/corpus) never
  constructs the live resolver; the vitest zero-network guard
  (corpus/test/setup/no-network.ts) forbids non-loopback sockets in
  tests and the suite tests use the loopback mock cluster only.

### 3. D18 detector unit-tested against crafted undecodable responses; flip procedure documented in runbook — DONE

- Detector matrix (R-LS2): crafted observations cover clean/no-claim,
  unadvertised-but-decoded (info), the exact zstd-garbage undecodable
  shape (d18-hit), advertised-gzip-with-garbage (d18-hit),
  binary-body-without-encoding (info), identity/empty-body edges, and
  the text-vs-binary heuristic (NUL bytes, printable ratio).
- END-TO-END through the REAL resolver (R-LS7): the mock cluster's
  `/undecodable-gzip-claimed` route (advertised gzip + garbage body →
  curl error 61 mid-decode → resolver salvages headers → observation =
  2xx + claimed gzip + undecodable body) fires `d18-hit`;
  `/unadvertised-br` (valid brotli while advertising only
  gzip,deflate) fires the informational probe; `/clean-gzip` stays
  silent. The gzip-garbage route is the same observation shape a curl
  build WITHOUT zstd produces on real zstd responses.
- Wire-truth nuance (documented in `pacing.ts`): requests without an
  explicit Accept-Encoding inherit curl `--compressed`'s own list
  (incl. zstd for this build) — recorded as the effective
  advertisement, so the live run's gzip answers are not phantom
  findings. The D18-relevant scenario (app advertises gzip,deflate,br
  per D13; server answers zstd) rides the pipeline's explicit header
  and stays fully detectable.
- Flip procedure: `docs/runbook.md` → "D18 flip procedure (zstd add-on
  trigger; DESIGN D13/D18)" — ≥2 modules with d18-hit findings within
  one week → enable the decoder add-on + change
  `ACCEPT_ENCODING_NO_ZSTD` to `gzip, deflate, br, zstd` + one clean
  re-run week + record.
- Live baseline: 0 findings on this run (clean signal).

### 4. Monitor logs report staleness (>7 days) — observed in real monitor runs — DONE

The existing cron monitor ("fmd-web board monitor", `*/15 * * * *`,
trigger `047a7284-2958-4b75-8564-c27aa798371e`) prompt gained step 6:
every run parses `docs/live-smoke-report.json`'s top-level
`generatedAt`, computes the age in days against UTC now, and appends
ONE staleness line to `.monitor/status.log` — `STALE` when the file is
missing or older than 7 days, `OK (age N d)` otherwise. Log line only;
no ALERT write, no other file touched.

Observed verbatim in `.monitor/status.log` (two real monitor runs):

```
2026-11-15T20:31:06Z | smoke-report: STALE (age unknown d, threshold 7 d) — rerun: npx tsx server/tools/smoke/run.ts --live --suite
2026-11-15T20:45:50Z | smoke-report: OK (age 0 d) — live-smoke evidence fresh (<7 d)
```

- The STALE line was produced with the freshly-written report
  deliberately moved aside for one 15-minute cycle — a transparent
  demonstration of the missing/stale branch; the report was restored
  immediately after and remains the committed artifact (the numeric
  >7d case is the same prompt branch with age > 7).
- The OK line fired with the committed report in place (age 0 d).
- Platform-side note (pre-existing, unrelated to this change): the
  routine's fires are recorded with `script_failed: opencode returned
  500` in `trigger_fires` — every historical fire of this monitor
  shows the same exit-code quirk while still appending its log lines;
  the staleness work lands regardless, as the verbatim lines show.

## The network-unavailable fallback (requirement 2 — built + proven, though not needed here)

The environment reached the seed sites, so the committed report is
live; the fallback was still implemented, tested, and demonstrated
end-to-end via the CLI:

```bash
npx tsx server/tools/smoke/run.ts --suite --mock \
  --blocker-note "FALLBACK-DEMO: network reachable in this environment —
  docs/live-smoke-report.json is the LIVE run; this artifact demonstrates
  the verified mock-cluster fallback (same code path, loopback
  worker-thread servers)"
```

- Result (`environment: "mock-cluster"`, blockerNote mandatory): 7
  pass / 4 fail / 1 skip. EHentai → `skip:account-gated` (bodyless-403
  login gate → net_problem → gated override); 18Comic → `fail:http`
  (Cloudflare-style block); ComicK → honest parse fail on the
  list-shape fixture; MangaDex/AsuraScans parse real content from
  their corpus fixtures; request log clean.
- Worker-thread architecture note: the live fetch is a synchronous
  `spawnSync` curl on the caller's thread — a same-thread node:http
  server could never accept() while that call blocks (every request
  would stall to the curl max-time). The mock servers therefore run in
  a worker thread whose independent event loop serves connections
  during the blocking calls.

## Test/gate status at delivery

- `npx vitest run` (full, offline): **149 files / 1597 tests passed**,
  re-verified after the final code edits (includes the 25 new
  live-suite tests + the pre-existing smoke skeleton tests).
- `npx tsc -b tsconfig.json`: clean for all server/corpus/tool files
  (0 non-web diagnostics); `web/*` capability-type churn on the shared
  tree belongs to another task's in-flight files, not this task's.
- `npx eslint server/tools/smoke/ server/test/tools/`: clean.
- `scripts/ci.sh`: byte-identical (absent from `git status`).

## Honest limitations

- MangaPlus (protobuf family) fails at Init inside the smoke harness:
  its `io.open` proto read resolves through the Lua VM's io layer,
  which does not see the host filesystem (verified directly: the host
  log carries the lua error even with the process CWD at the lua
  tree). The failure is classified `setup` with the host error
  surfaced in `detail`; the module's offline expression coverage is
  unaffected (the corpus replays its expressions against fixtures
  without full Init). A future fix would bridge the VM io layer to the
  host fs for sibling asset reads — out of scope here.
- The fixed-UA override means suite runs are not per-module-UA-parity
  runs; operators comparing upstream behavior for UA-sensitive modules
  should use the rotation runner with explicit `--module` pins.
- D18 decodability is a heuristic (text-vs-binary over the decoded
  body + claimed encoding), documented in `d18.ts`; the crafted
  signatures are unit-pinned.
- Live pass rates move between runs (ComicK's first run hit a 62s
  event deadline; the second parsed chapters=1774) — the report is a
  per-run observability snapshot, by design.
