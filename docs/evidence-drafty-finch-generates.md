# Evidence — tsk-drafty-finch-generates (Observability: structured logs, metrics, health, runbook)

Stage: in_progress → in_review · Date: 2026-11-14

## Shipped

**Module `server/src/observability/`** (new):

- `structured-log.ts` — JSON-lines logger (`{ts, level, msg, module?, event?, …}`)
  with module-id correlation (`forModule()`, `ModuleScopedLogger`) and the
  run-level `ExpressionFailureDeduper`: max **1 WARN per (module,
  expression-template) per run**, repeats counted as `suppressed`
  (`dedupStats()`), `LogCapture` sink for log-capture tests.
- `metrics.ts` — zero-dependency Prometheus registry (declared families,
  deterministic sorted rendering) + the `FmdMetrics` façade: queue depth per
  lane, jobs by state, enqueue/claim/terminal/failure-kind counters,
  per-module request latency histogram + outcome counters, corpus pass
  rates, engine-pool RSS + GC stats (perf_hooks gc observer), sync
  progress/last-success, and the re-exported dedup counters.
- `instrumented-queue.ts` / `instrumented-sync.ts` — transparent wrappers
  (delegate unchanged, mirror mutations into the registry; depth/state
  gauges snapshot the LIVE queue at scrape).
- `health.ts` — `ReadinessProbe` over three families: app db opens +
  answers, every installed catalog attachable (read-only open + schema
  probe, cached per size+mtime so corruption invalidates), lua tree with
  ≥1 module file; `composeReadiness()` (first not-ready source wins —
  the D20 bootstrap gates first, data faults surface after).
- `backup.ts` — `backupDataDir` (better-sqlite3 `db.backup()` = the
  `sqlite3 .backup` online API, consistent while writers run; plain copy
  for non-DB artifacts; `-wal/-journal/-shm` never copied) +
  `restoreDataDir` (atomic per-file overwrite; validation = the readiness
  checks) + `validateDataDir`.

**Wiring**:

- `api/app.ts`: `GET /api/metrics` (Prometheus text v0.0.4) mounted when a
  registry is bound; `/api/info` feeds per-module latency/outcome series
  (cache hits never reach the engine → not counted).
- `api/routes.ts` + `api/openapi.ts`: route row + documented op
  (`text/plain` content type support added to the generator);
  `openapi.snapshot.json` + web generated client regenerated (`npm run
  api:snapshot`, `web npm run gen:api`) — both drift tests green.
- `runtime/assembly.ts`: one `StructuredLogger` + `FmdMetrics` per run
  (dedup counters bound live, process memory bound), queue wrapped
  (`InstrumentedJobQueue` outside the WS publisher), sync wrapped, readiness
  composed from `bootstrap.readiness()` + the new probe.
- Engine integration (the §5.6 bound is truly RUN-level, across engines):
  `SwallowLogger` accepts a shared deduper (`SwallowSharedDeduper`,
  structural — engine stays independent of observability), plumbed
  `install.ts` → `TxQueryShim` options; `EngineInfoService` /
  `createEngineDownloadHooks` accept it plus a `logSink` tee
  (`TeeMemoryLogger` in `engine/lua/logger.ts`) so engine records land as
  module-correlated JSON lines.

**Runbook `docs/runbook.md`** (placeholder → full): health/metrics/log
semantics, backup/restore procedure (online-backup API + file copy +
restore validation, manual `sqlite3 .backup` recipe, "do NOT copy
sidecars"), pin-bump procedure (D9: staging pin → diff report → CI smoke
on candidate pin → PR; auto-bump refused), sidecar profile enablement
(`--profile browser`), retention tuning (30-day prune, WAL checkpoint
sizing), and a troubleshooting table (worker_stalled / engine_oom / pack
failures / sync rate-limit / readyz faults / queue stalls).

## Acceptance criteria → evidence

1. **Metrics integration test (scripted workload via the endpoint)** —
   `server/test/observability/metrics.integration.test.ts` (PASS): real
   `SqliteJobQueue` behind `InstrumentedJobQueue`, download jobs through
   the API + direct info-lane enqueue, claims/transitions (done + failed
   `net`), 2 ok + 1 error `/api/info`, sync triggers, then `GET
   /api/metrics` asserts exact series: `fmd_queue_depth{lane}`,
   `fmd_jobs_state{lane,state}`, `fmd_jobs_enqueued/claimed_total`,
   `fmd_jobs_terminal_total{lane,state}`,
   `fmd_job_failures_total{kind="net",lane="download"}`,
   `fmd_module_requests_total{module,outcome}`,
   `fmd_module_request_latency_seconds_{bucket,sum,count}`,
   `fmd_sync_operations_total{kind,outcome}`, `fmd_sync_in_progress`,
   `fmd_sync_progress_ratio`, `fmd_sync_last_success_timestamp_seconds`,
   `fmd_engine_pool_rss_bytes` > 0, GC families present, dedup counters
   and `fmd_corpus_pass_rate` re-exported. Content-type asserted.
2. **Log dedup (100 identical → 1 WARN + counters)** —
   `server/test/observability/log-dedup.test.ts` (PASS): 100 identical
   failures → exactly 1 `expression_failure` WARN + `{warned:1,
   suppressed:99}`; distinct templates/modules warn independently (3 WARNs
   / 27 suppressed); the bound holds ACROSS two `SwallowLogger` instances
   sharing the run deduper (with per-instance contrast documented); lines
   are machine-parseable JSON (numbers stay numbers; raw line round-trips).
3. **healthz/readyz semantics (corrupted-catalog fault injection)** —
   `server/test/observability/health-readyz.test.ts` (PASS): corrupting a
   catalog file → `/readyz` 503 with `reason` naming the family + "not a
   database", `/healthz` stays 200 throughout; repair (new db at the path)
   flips readyz back WITHOUT restart (probe cache keyed on size+mtime);
   db-open and lua-tree faults surface per family; corrupted app db fails
   the db family; `composeReadiness` precedence (bootstrap first).
4. **Runbook coverage + backup/restore rehearsal** — runbook sections
   listed above (all procedures from the task body covered); rehearsal in
   `server/test/observability/backup-restore.test.ts` (PASS): live-shaped
   data dir (queue schema app.db + catalog + lua tree + a queued job) →
   `backupDataDir` (db files listed, no `-wal/-journal` copied) → corrupt
   BOTH app.db and catalog (probe red on both families) → `restoreDataDir`
   (validation = readiness checks, all green) → probe `ready: true` and
   the job row + catalog content survived the round trip.

## Verification

- `npx vitest run server/test/observability` → **4 files, 10 tests, all
  green**.
- Neighbor suites over every shared file I touched (txquery shims, events
  dispatcher, api, lua logger) → **22 files, 239 tests, all green**;
  `openapi.test.ts`, web `api-drift.test.ts`, `health.test.ts` → 13 green.
- ESLint clean on all new/edited files; `tsc -p server/tsconfig.json
  --noEmit` reports no errors for any file in this story's diff
  (review round 1 flagged two type-gate errors in this story's test
  files — readonly-array `.sort()` in backup-restore.test.ts and an
  exactOptionalPropertyTypes spread in metrics.integration.test.ts —
  both fixed and re-verified; the remaining repo errors are sibling
  in-flight churn: install.ts, lua-require.ts, http-shim.ts,
  favorites/*, bypass-adapter.ts, http-pipeline.ts).
- NOTE: repo-wide `npm run typecheck` / some `engine/shims` + `runtime`
  tests are transiently red from SIBLING in-flight stories on the shared
  tree (favorites wiring in `assembly.ts`/`main.ts`, the proxies/sidecar
  story's dangling `sidecar/subprocess-stub.js` import in `install.ts` and
  `proxyProvider` churn in `http-shim`) — none of it is this story's diff;
  the metrics test was deliberately decoupled from that graph (inline
  queue-backed `JobService` instead of `RuntimeJobService`).
