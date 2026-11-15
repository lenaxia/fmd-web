# Live smoke harness (DESIGN.md §12 Phase-1 + §13.2)

Two runners behind one CLI (`run.ts`):

1. **Rotating module sample** (the original skeleton): `--live` runs
   GetInfo for a rotation window of seed modules; without `--live` it
   prints the plan only.
2. **Heterogeneous site suite** (`--suite`): the ≥10-site fixed list in
   `sites.ts` — 12 seed-corpus sites spanning nine template/API
   families (JSON-API, Madara template, MangaThemesia, Madara-family,
   protobuf MangaPlus, account-gated EHentai-style, JSON gallery,
   imagepuzzle 18Comic, standalone HTML) — with per-site **1 req/s
   pacing**, a **fixed User-Agent**, per-module pass/fail + latency +
   failure classification, the **D18 undecoded-body detector**, and the
   harness's own **request-log invariants**. Writes the committed
   artifact `docs/live-smoke-report.json`.

## Usage

```bash
# suite PLAN only (offline — no engine session, no sockets)
npx tsx server/tools/smoke/run.ts --suite

# LIVE heterogeneous suite → docs/live-smoke-report.json (opt-in!)
npx tsx server/tools/smoke/run.ts --live --suite

# mock-cluster suite run (loopback fallback; NO external network)
npx tsx server/tools/smoke/run.ts --suite --mock \
    --blocker-note "worker env cannot reach the seed sites"

# rotation sample (original runner; plan / live)
npx tsx server/tools/smoke/run.ts                 # plan only
npx tsx server/tools/smoke/run.ts --live --sample 5 --out /tmp/opencode/smoke.json
```

Flags: `--live` (EXTERNAL network gate — required for live suite
runs; never in CI) · `--suite` (heterogeneous suite) · `--mock`
(loopback mock cluster; requires `--suite`, mutually exclusive with
`--live`) · `--blocker-note TEXT` (mandatory with `--suite --mock`;
lands verbatim in the report) · `--rate-ms N` (per-site pacing
override, default 1000) · plus the rotation flags (`--module`,
`--sample`, `--rotation-index`, `--seed-dir`, `--url`, `--out`).

Suite runs default `--out docs/live-smoke-report.json`.

## Network gate (twice enforced)

- The CLI refuses live suite runs without `--live`, and
  `runLiveSuite` re-checks `{ live: true }` — CI never passes it
  (`scripts/ci.sh` is untouched by design). The vitest zero-network
  guard (corpus/test/setup/no-network.ts) forbids non-loopback sockets
  in tests; the suite tests run against the loopback mock cluster
  only.
- `--mock` is loopback-only by construction (127.0.0.1 worker-thread
  servers) and is refused together with `--live`.

## Mock cluster (network-unavailable fallback)

When the operator environment cannot reach the seed sites, the SAME
code path (PacedResolver → host-mapped live curl resolver → real §5.4
pipeline → real modules → contract dispatcher) is verified against a
loopback mock cluster (worker-thread-hosted node:http servers, one per
site): fixture pages for the default sites, a bodyless-403 login gate
(EHentai → `skip:account-gated`), a bodyless-403 Cloudflare-style
block (18Comic → `fail:http`), and D18 probe routes
(`/undecodable-gzip-claimed`, `/unadvertised-br`, `/clean-gzip`). The
worker thread is REQUIRED because the live fetch is a synchronous
`spawnSync` curl — a same-thread server could never accept() while
that call blocks (every request would stall to the curl max-time).

A committed mock-cluster report MUST carry a `blockerNote` (enforced
by `runLiveSuite`).

## Report schema (docs/live-smoke-report.json, `live-smoke-report/1`)

- `generatedAt` + `environment` (`live` | `mock-cluster`) + optional
  `blockerNote`
- `sites` — the run's site list (name, category, url, moduleId,
  moduleFile, gated, note)
- `results` — per site: `status` (pass/fail/**skip**),
  `classification` (pass · transport · http · dispatch · setup ·
  host-error · skip:account-gated), `resultCode`, `latencyMs`
  (dispatch wall time), `durationMs`, `detail`
- `totals` + `passRate` (pass/(pass+fail) — expected-skips stay out of
  the denominator)
- `d18` — observation count, findings, affected modules, flip rule
- `requestLog` — count, fixed UA, per-host request counts, and the
  `assertRequestLog` violations list (empty = 1 req/s + fixed UA held)

Pass semantics (suite): pass = the dispatcher returned `no_error`, no
host error-level log record fired during the dispatch, and MANGAINFO
read back without throwing; a module/site legitimately returning empty
data is a pass whose `detail` shows the derived title/chapters. Setup
failures surface the last host error record (e.g. a module reading a
sibling asset through the VM io layer). The report is OBSERVABILITY,
not a compatibility gate — the offline corpus runner owns the ≥99%
gate.

## D18 hook (zstd add-on trigger)

Every response is inspected (PacedResolver): the request's EFFECTIVE
Accept-Encoding (the §5.4 shim advertises `gzip, deflate, br` per D13;
requests without an explicit header inherit curl `--compressed`'s own
list incl. zstd — recorded as the wire truth), the response's
Content-Encoding, and body decodability fold into a structured finding
(`d18.ts`):

- `unadvertised-encoding` (info) — server answered with a scheme we
  did not advertise but the body decoded anyway
- `undecodable-body` (**d18-hit**) — the module received garbage (or
  the decode pass died, e.g. curl error 61): the D18 failure shape
- `binary-body-without-encoding` (info) — integrity anomaly

≥2 modules with d18-hit findings within one week flip the decoder on
(docs/runbook.md → "D18 flip procedure"). Unit tests craft all three
signatures; the mock cluster proves the gzip-garbage shape end-to-end
through the real resolver.

## Rotation scheme (original runner, unchanged)

The seed corpus (corpus/fixtures/seed/, ≥50 modules with manifests) is
sorted by name; the sample is the `sampleSize`-wide window starting at
`(rotationIndex * sampleSize) mod total`, wrapping.

## Manual verification log

| Date | Command | Outcome |
|---|---|---|
| 2026-11-13 | `run.ts --sample 3` (no `--live`) | Plan-only JSON printed, exit 0, no network. |
| 2026-11-13 | `run.ts --live --module ManhwaIndo --url …/manga/solo-leveling/` | **PASS** — live fetch → dispatch → parse clean through the full §5.4 shim. |
| 2026-11-15 | `run.ts --live --suite` | **LIVE SUITE RAN**: 12 sites, 10 pass / 2 fail (passRate 0.833) — real parses incl. AsuraScans "Solo Leveling" chapters=201, ComicK chapters=1774, MangaDex live JSON title; honest fails: MangaPlus (proto read via VM io layer — setup), Tapas (404 slug — http); request log clean (44 requests, fixed UA, 0 violations); d18 findings 0. Artifact regenerated at docs/live-smoke-report.json. |
| 2026-11-15 | `run.ts --suite --mock --blocker-note …` | **MOCK FALLBACK RAN end-to-end**: loopback worker-thread cluster through the SAME code path — 7 pass / 4 fail / 1 skip (EHentai skip:account-gated via bodyless-403 gate; 18Comic fail:http; D18 probe routes fired the detector end-to-end). |

## Files

- `rotation.ts` — seed listing + deterministic window sampling (pure).
- `sites.ts` — the heterogeneous suite definition (+ `validateSuite`).
- `live-resolver.ts` — curl argv builder, header-dump parser, the
  `LiveResponseResolver` (single-hop sync curl; salvages headers on
  curl content-decode failures for the D18 inspector).
- `pacing.ts` — fixed UA + per-site 1 req/s pacing (`PacedResolver`,
  sync `Atomics.wait`) + `assertRequestLog` invariants + the D18
  observation capture.
- `d18.ts` — the D18 detector (pure; `detectD18` over observations).
- `smoke.ts` — the run core (session per module, classification,
  `runModuleGetInfo` incl. lua-root CWD parity).
- `live-suite.ts` — the suite runner + report assembly
  (`runLiveSuite`).
- `mock-cluster.ts` — worker-thread loopback servers + host mapping
  (`startMockCluster`, `MockClusterResolver`, `mockEgress`).
- `run.ts` — the CLI (plan / live rotation / live suite / mock suite).

Unit tests: `server/test/tools/smoke.test.ts` (rotation skeleton) and
`server/test/tools/live-suite.test.ts` (detector matrix, pacing
invariants, gates, CLI matrix, loopback mock-cluster integration +
D18 probe end-to-end).
