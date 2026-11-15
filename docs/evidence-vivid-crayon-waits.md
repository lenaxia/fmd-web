# Evidence — tsk-vivid-crayon-waits (server/jobs/queue per DESIGN §4/§9: interface JobQueue + typed payloads, 4 lanes, SQLite discipline, coalescing, retention, state machine + the five drill suites)

Date: 2026-11-14T09:15Z · Environment: node v24, better-sqlite3 12.4.1 (SQLite RETURNING/WAL), vitest 3.2.7, esbuild (worker bundling), linux · Offline (tmp-dir SQLite files + worker_threads only; no sockets — the repo no-network guard is active for every test)

## Scope

`server/src/jobs/queue/` — the production SQLite-backed job queue behind the
four §4 lanes (info/download/update/sync):

- **`payloads.ts`** — the discriminated union `JobPayload`
  (`DownloadChapterJob | InfoJob | UpdateFavoriteJob | SyncJob`,
  discriminant `type` ≡ SQLite `job.type` ≡ lane id). zod schemas are the
  source of truth (`z.infer` types, same convention as the §10 API
  schemas); every persisted row is re-validated on read
  (`parseJobPayload` → `InvalidJobPayloadError` on foreign/corrupt bytes —
  no stringly-typed payloads anywhere). §10 idempotency fingerprint =
  canonical JSON of the typed payload.
- **`state-machine.ts`** — the typed §7.1 enforcer
  `assertJobTransition(from, to, detail)`: shares the transition table
  with `../lanes.ts` (single source of truth, now exported), THROWS
  `InvalidJobTransitionError` on any illegal edge and
  `MissingJobFailureKindError` unless `→ failed` carries a typed
  `JobFailureKind` (worker_stalled | engine_oom | net | pack).
- **`connection.ts`** — §4 SQLite discipline: `openQueueDb` (one
  connection per thread — nothing crosses a worker_threads boundary),
  `busy_timeout = 5000` (pinned `BUSY_TIMEOUT_MS`), WAL +
  `synchronous = NORMAL`, `wal_autocheckpoint` default **1000 pages,
  tunable** (`WAL_AUTOCHECKPOINT_DEFAULT_PAGES`); `ensureJobSchema`
  creates the §9 `job` table verbatim + documented queue-runtime columns
  (attempts / claimed_by / claimed_at for the §4 watchdogs) + CHECK
  constraints mirroring the state machine; `CheckpointMonitor` times
  explicit checkpoints and classifies stalls.
- **`coalesce.ts`** — `ProgressCoalescer`: in-memory buffer per job,
  latest snapshot wins, durable flush ≤ **1/sec/job**
  (`PROGRESS_FLUSH_INTERVAL_MS = 1000`), driven by the injected
  `SyncClock` (production `systemClock`, tests `FakeClock` — zero sleeps).
- **`queue.ts`** — the `JobQueue` interface + `SqliteJobQueue`:
  `enqueue` (idempotent per §10: same key + same fingerprint ⇒ original
  job replayed; differing fingerprint ⇒ `IdempotencyConflictError`),
  `claim(lane)` as a **single-writer transaction** (`BEGIN IMMEDIATE` +
  `UPDATE … WHERE id = (SELECT … state IN ('queued','retry') ORDER BY
  priority DESC, id ASC LIMIT 1) RETURNING …` — losers wait on
  busy_timeout, then re-evaluate against committed state), `transition`
  (current state re-read, typed assert, optimistic
  `WHERE id AND state=from` guard → raced writes throw), `cancel`
  (cooperative — a cancelled running job makes its stale worker outcome
  throw), `updateProgress`/`progressOf` (coalesced write / instant
  in-memory read), `counts`/`list`/`get`, `pruneRetention` (terminal-only,
  30 d, injectable clock), `recoverOrphans` (§7.1 "resumable across
  restarts": orphaned `running` → `retry`, claim bookkeeping cleared,
  progress preserved; `recoverOnOpen` runs it at boot), `staleRunningJobs`
  (watchdog input). Plus `LaneRunner`: per-lane `concurrency` slots ×
  claim loop — **four lanes with independent concurrency** — with typed
  handler outcomes (`done | retry | failed{kind}`), retry-exhaustion →
  `failed{kind}` (default `net`), unhandled handler throw →
  `worker_stalled`, and `stop()` that drains in-flight handlers.

`server/src/jobs/lanes.ts` — placeholder comment updated; `TRANSITIONS`
table now exported (the queue's enforcer consumes it unchanged).
`server/src/index.ts` — `export * from './jobs/queue/index.js'` added.

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Stress: 16 claimants × 500 jobs, 10× — zero double-claims / zero lost jobs (deterministic) | `server/test/jobs/stress.test.ts`: **real `worker_threads` × 16, each holding its OWN better-sqlite3 connection** (the §4 one-connection-per-thread rule for real), racing the IMMEDIATE-transaction claim on the same db file. The worker source (`helpers/stress-worker.ts`) is esbuild-bundled at test time **from the shipped TS sources** (not a stale dist) and posts a claim ledger with `PRIMARY KEY (rep_id, job_id)` — a double-claim CRASHES the claimant via UNIQUE violation. Coordinator-side verification per rep: all 500 rows `done` (`GROUP BY state` == `[{done:500}]`), exactly one ledger row per job (`HAVING COUNT(*)>1` == 0 re-checked), ledger job-id set ≡ enqueued id set, `Σ attempts == 500`, claimant-side reported sum == 500. Repeated **10×, all digests identical** (`new Set(digests).size === 1`) — deterministic under repetition. `npx vitest run server/test/jobs/stress.test.ts` → 1/1 green in ~8 s. | met |
| Coalescing: write count bounded (≤1/sec/job) while update visibility ≤1 s (test-asserted) | `server/test/jobs/coalescing.test.ts` (7 tests, FakeClock — virtual time, no sleeps): 1000 updates pushed across a 1000 ms virtual job → **exactly 1 durable write** (`coalescerStats().flushes === 1`, `coalescedAway === 999`) carrying the newest snapshot; 5 s further idle → still 1 write; in-memory `progressOf` reflects update #1000 **instantly** while the persisted row is asserted still empty at t=999 ms and populated at exactly t=1000 ms (**visibility latency ≤1 s asserted on the persisted row**); staggered two-job cadence proves per-job budgets are independent (each flushes once, 1 s apart); steady 3 s stream → writes at t=1000/2000/3000 only (3 writes / 6 updates); a terminal transition carries the coalesced snapshot **atomically** (`progress = COALESCE(…)` inside the state UPDATE — `take()` counted as the one write); `close()` flushes (graceful §4 shutdown) and a reopened instance reads the snapshot. | met |
| State machine: invalid transition throws; all legal paths enumerated | `server/test/jobs/state-machine.test.ts` (46 tests): the legal-edge set is **enumerated FROM the exported table** (`LEGAL_EDGES = flatMap(TRANSITIONS)`) — every edge tested to pass (including the full `queued→running→retry→running→done` lifecycle); the illegal set is the **complete 6×6 grid minus legal edges** — every pair asserted to throw `InvalidJobTransitionError` with the from/to in the message; self-transitions always throw; terminal states closed; `→ failed` without (or with an unknown) `failureKind` throws `MissingJobFailureKindError`; exactly the four §4 kinds recognized. Queue-level enforcement mirrored in `queue.test.ts` (skipped chain `queued→done` throws, `running→queued` throws, cancel-beats-claim: unclaimable after cancel + stale worker `done`-write throws, unknown id throws, retry rows reclaimable with `attempts` accumulating). | met |
| Crash-recovery: fault-injected kill mid-download → restart → resumes from persisted progress | `server/test/jobs/crash-recovery.test.ts` (5 tests): "kill" = abandoning the instance with NO close/flush/transition (process-kill semantics). (1) Download killed after chapter 5/30 flushed (`advance(1000)` past the coalescing boundary) → reopened instance with `recoverOnOpen` shows `running→retry`, **progress `{chapterIndex:5}` survived**, next claimant reads the persisted progress and resumes 6→30 → `done`, attempts 2. (2) Kill before any progress → resumes from scratch. (3) `retry` rows survive restart untouched; recovery re-pools ONLY `running`. (4) `recoverOrphans` callable explicitly, idempotent (1 then 0). (5) Repeated kill/resume across 3 lives → claim history accumulates (attempts 2,3,4), final state `done`, recovery idempotent. | met |
| Retention prunes >30 d jobs (fake-clock) | `server/test/jobs/retention.test.ts` (4 tests, `FakeClock`): t=0 batch (done + failed + cancelled + an ancient QUEUED row) survives at `30d − 1 ms` (prune == 0), is pruned exactly past the boundary (== 3), the ancient **queued row survives regardless of age** (retention is terminal-only); a job completed AT 30 d prunes only 30 d after its own completion (updated_at-driven); an explicit `now` argument controls the cutoff (smaller now ⇒ nothing pruned); `running`/`retry` rows never pruned even at 60 d. `RETENTION_MS` pinned == 30 days (also asserted in `queue.test.ts`). | met |

## Implementation notes

- **Claim discipline under contention**: `claim()` wraps the
  subquery+UPDATE in a better-sqlite3 `transaction(...).immediate()` —
  the write lock is taken up front, so the SELECT inside evaluates
  against committed state and a losing thread waits on
  `busy_timeout=5000` then re-evaluates (never double-claims). The
  stress drill exercises exactly this with 16 live threads.
- **Checkpoint monitor vs real SQLite** (measured, then encoded): PASSIVE
  checkpoints never block and never report `busy=1` when frames are left
  behind a reader — the observable of a stall is `checkpointed < log`.
  `CheckpointMonitor` classifies stalled = `busy || checkpointed < log ||
  duration > threshold`; the drill (`checkpoint.test.ts`) pins a reader
  mid-transaction, shows 65 commits still succeed while the checkpoint
  leaves frames behind (stall OBSERVED, never fatal), then drains the WAL
  to **0 bytes** with a TRUNCATE checkpoint after release. Sizing is
  proven differentially: autocheckpoint=8 keeps the WAL bounded (~6
  pending frames after 200 writes) vs autocheckpoint=0 (~601 frames).
- **Testing the real sources in threads**: the stress worker is
  esbuild-bundled per test run into a node_modules cache dir (bare
  `better-sqlite3` import resolves by walk-up) and removed in `afterAll`
  — no dependency on a prior `tsc -b` for threaded coverage.
- **Coexistence**: the packers story (`server/src/jobs/packers/`,
  `server/test/jobs/packers/`) landed concurrently in the same trees;
  its mid-write state twice transiently blocked a full `tsc -b` and one
  cleanup pass briefly removed two of this task's test files (recreated
  byte-identical, re-verified). Final gates below ran with the completed
  packers code in place — full tree green.
- `lanes.ts` change is additive only (placeholder doc updated +
  `TRANSITIONS` exported); `server/src/index.ts` gains one barrel export
  (`canonicalJson`/`payloadFingerprint` intentionally NOT re-exported on
  the barrel — the §10 API store exports the same names).

## Verification

- `npx vitest run server/test/jobs/` → **10 files, 115 tests, all green**
  (97 this task: state-machine 46, queue 28, coalescing 7, retention 4,
  crash-recovery 5, checkpoint 6, stress 1 × the 10-rep drill; the other
  18 are the concurrent packers suite).
- `npx vitest run` (full repo) → **96 files, 1002 tests, all green**.
- `npx tsc -b tsconfig.json` → clean (zero errors repo-wide).
- `npx eslint server/src/jobs/ server/test/jobs/` → clean (boundary rules:
  `no-explicit-any`, `explicit-module-boundary-types`).
- `npx vitest run --coverage` → `server/src/jobs` **100%** stmts/branches;
  `server/src/jobs/queue` **94.22% stmts / 85.47% branches / 94.28%
  funcs** (thresholds 75/75/65/80) — repo coverage gate passes.

## Boundary notes

- The §10 API `JobService` port is deliberately left on the in-memory
  store — wiring `SqliteJobQueue` behind it (and the WS progress hub) is
  the API/runtime integration story; the queue's surface
  (`enqueue/claim/transition/progressOf/counts/list`) was shaped for
  that adapter.
- `staleRunningJobs` is the §4 watchdog's input; the recycle policy
  (deadline miss ⇒ `worker_stalled` + engine recycle) belongs to the
  engine supervisor story and can be driven from it directly.
