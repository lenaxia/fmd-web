# Runbook

Operational procedures and troubleshooting for the fmd-web container
(DESIGN.md §9–§11, §4 observability, §5.11 sidecar). Ops-relevant env
surface first, then the procedures.

- Data dir: `FMD_WEB_DATA_DIR` (default `/app/data`, volume `app-data`).
  Layout: `app.db` (queue + library, WAL), `lua/` (synced module tree),
  `catalogs/<ID>.db` + `catalogs/<ID>.meta.json` (install receipts),
  `fts/<ID>.db` (FTS sidecars), `library/` (packed chapter artifacts),
  `sync/` (batch state), `tmp/` (scratch, self-cleaning).

## Health: /healthz vs /readyz (§10)

- `GET /healthz` — LIVENESS. Process up, version reported, always 200
  while the process answers. It never inspects data: restart cannot
  heal a corrupt catalog, so liveness must not flap on data faults.
  Docker healthcheck + process supervisors key on this.
- `GET /readyz` — READINESS. 200 only when ALL of:
  1. `app.db` opens and answers (`SELECT 1`) — the queue/library db;
  2. every `catalogs/*.db` is ATTACHABLE (read-only open + schema
     probe; per-file probe results are cached by size+mtime, so any
     byte-level change — including corruption — re-probes on the next
     scrape);
  3. the lua tree exists with ≥1 `.lua`/`.luac`.
  503 + a human `reason` otherwise: the D20 first-run bootstrap stage
  while booting (`bootstrap: modules…`), bootstrap failure detail, or
  the failing probe family (`catalogs (…/X.db): file is not a
  database`). The SPA bootstrap banner polls /readyz and renders the
  reason.
- `GET /api/metrics` — Prometheus text exposition (v0.0.4). Series:
  `fmd_queue_depth{lane}` / `fmd_jobs_state{lane,state}` (live gauges),
  `fmd_jobs_enqueued_total` / `fmd_jobs_claimed_total` /
  `fmd_jobs_terminal_total{lane,state}` / `fmd_job_failures_total{lane,kind}`,
  `fmd_module_requests_total{module,outcome}` +
  `fmd_module_request_latency_seconds` (histogram, §15),
  `fmd_corpus_pass_rate{module}` (§15),
  `fmd_engine_pool_rss_bytes` + `fmd_gc_pause_{count,seconds}_total{kind}`,
  `fmd_sync_operations_total{kind,outcome}` / `fmd_sync_in_progress{kind}` /
  `fmd_sync_progress_ratio{kind}` / `fmd_sync_last_success_timestamp_seconds{kind}`,
  `fmd_log_expression_{warns,suppressed}_total`.
  Scrape with any Prometheus; alert on queue-depth-per-lane growth and
  `fmd_job_failures_total{kind="worker_stalled"}` deltas.

## Logs (§4, structured JSON)

- One JSON object per line on stdout:
  `{ "ts": RFC3339, "level": debug|info|warn|error, "msg", "module"?,
  "event"?, … }`. `module` is the 32-hex module id — filter/group by it
  to correlate a site module's engine calls (`jq 'select(.module=="…")'`).
- The legacy `fmd: …` plain lines (bootstrap stages, SIGTERM drain)
  remain for compose log assertions; everything new is structured.
- **Expression-failure WARN dedup (§5.6 review bound)**: modules fail
  XPath/JSON expressions by design (swallowed, FMD2 Eval semantics).
  Each `(module, expression-template)` pair emits AT MOST ONE WARN per
  run (`event: "expression_failure"`); repeats only raise the
  suppressed counter (`fmd_log_expression_suppressed_total`). The dedup
  set is process-wide — it survives engine/worker recycling. Expect a
  healthy deployment to log few distinct expression WARNs per run; a
  growing `warns` counter after a pin bump is the §15 regression signal.

## Backup / restore (§9)

Backup = SQLite online backup (`sqlite3 .backup` / better-sqlite3
`db.backup()`) for every `*.db` + plain file copy for everything else.
Catalogs and app.db are NEVER mutated after install/write other than by
the queue, so a mid-run backup is consistent (the backup API folds WAL
and journal state into the snapshot).

In-code (the rehearsed path — `server/test/observability/backup-restore.test.ts`):

```ts
// server/src/observability/backup.ts (re-exported by server/src/observability/index.ts)
import { backupDataDir, restoreDataDir } from '../observability/index.js';
const report = await backupDataDir({ dataDir: '/app/data', backupDir: '/backups/2026-11-14' });
const restore = restoreDataDir({ backupDir: '/backups/2026-11-14', dataDir: '/app/data' });
// restore.valid === true  ⇔ §9 restore validation (app db answers,
// catalogs attachable, lua tree present) — the same checks /readyz runs.
```

Manual equivalent (while the server is STOPPED — simplest safe window):

```sh
mkdir -p /backups/2026-11-14
sqlite3 /app/data/app.db ".backup '/backups/2026-11-14/app.db'"
cp -a /app/data/catalogs /app/data/lua /app/data/library \
      /app/data/sync /app/data/fts /backups/2026-11-14/
# NEVER copy -wal/-journal/-shm sidecars: after a clean stop they are
# folded back into the db; live, the online-backup API is the safe path.
```

Restore procedure (used by the rehearsal test):

1. Stop intake (compose: `docker compose stop app`); keep the volume.
2. Copy the snapshot back over `<dataDir>` (overwrite matching paths).
3. Validate BEFORE resuming traffic: start the container and poll
   `/readyz` — 200 proves app db opens, catalogs attachable, lua tree
   present. The in-code rehearsal runs the same checks without a
   socket (`restoreDataDir(...).valid`).
4. If /readyz reports a specific catalog file, re-sync just that
   catalog (`POST /api/sync/catalog/<ID>`) instead of a full restore.

## Pin bump (D9) — a deployment act, never automatic

The FMD2 lua/ pin (`FMD2_LUA_SHA`, default in
`server/src/sync/modules/config.ts`) is the commit the corpus, Init-pass
goldens and pass rates were captured against. `FMD_SYNC_AUTO_BUMP` is
REFUSED at config load by design.

Procedure:

1. Pick the candidate commit; set `FMD2_LUA_SHA=<sha>` on a staging
   deployment (or `FMD2_REPO` for a fork).
2. Generate the module diff report: the syncer diffs the previous
   pin's Init inventory by module ID and reports added/removed/changed
   (ID is the stable join key; entries sorted by ID) — the report is in
   the sync outcome and log lines; keep it verbatim in the bump PR.
3. CI smoke on the candidate pin: run the local gate against the
   candidate tree (`FMD_LUA_DIR=<candidate tree> npm run ci`) — the
   Init sweep re-registers, corpus replay and per-module pass rates
   re-run offline, and §15 deltas surface as the known-broken list
   diff. A pass-rate drop or a new known-broken module = stop and
   review the upstream commit.
4. Land the PR (pin + diff report), redeploy; the runtime syncs only
   the new pin (SHA-gated: unchanged trees skip the sweep).

## Browser sidecar profile (§5.11, D2)

Modules flagged `requires_browser` (e.g. the ≤76 Madara-family sites
using `run_html_load`) plus `fmd.subprocess` consumers and
`webdriver.bypass` sites need FlareSolverr (bundled headless Chromium).
Opt in — set the sidecar URL AND start the profile:

```sh
FMD_WEB_BROWSER_SIDECAR_URL=http://flaresolverr:8191 \
  docker compose --profile browser up -d
# verify: curl -s http://localhost:8191/health   → {"status":"ok"}
```

- The compose default for `FMD_WEB_BROWSER_SIDECAR_URL` is EMPTY, so a
  plain `up` runs without the sidecar and the §5.10 known-broken
  capability flags STAND. The flags flip only when the URL is set
  (config-driven: `/api/modules` drops `fmd.subprocess`,
  `madara.run_html_load`, `webdriver.bypass` from `known_broken_flags`;
  the `requires_*` booleans stay truthful). The flip state is visible in
  Settings → Proxy as the "browser sidecar: enabled/off" badge, and the
  per-module "needs browser" badges stay listed regardless.
- Adapter budgets (enforced by the BypassExecutor sidecar adapter):
  max 2 concurrent sidecar executions (queued), 60 s per call, and a
  health gate — `/health` is polled (5 s TTL) and a dead sidecar makes
  `fmd.subprocess.RunCommandHide` return false instead of silently
  degrading a module run.
- The subprocess stub (`fmd.subprocess`) routes `RunCommandHide` to the
  adapter only while the profile is enabled; without it the denied stub
  returns nil (§5.7 contract row).
- The flaresolverr image is digest-pinned (`docs/docker-pinning.md`);
  `scripts/compose-check.sh` validates the profile render (service
  present only with `--profile browser`, pin, healthcheck) on hosts
  with the docker CLI.

## Proxy settings (§9/§10, SetProxy parity)

Settings → Proxy (and `GET/PUT /api/settings`, `PUT
/api/settings/proxy`) expose the GLOBAL proxy: exactly the FMD2
`SetProxy` five strings — `type` HTTP|SOCKS4|SOCKS5 (empty type = no
proxy), host, port (string), user, pass. The engine seeds every module
HTTP object with the effective config before its first request; a
module's own `SetProxy` call still overrides at runtime (FMD2 parity,
`httpsendthread.pas:838-874`).

- Per-module overrides: Settings → Modules → Configure → "Module proxy
  override" (or `PUT /api/modules/:id` with `proxy`). Explicit `null`
  clears the override back to "inherit the global proxy". The module
  summary carries the resolved override (`"proxy": null` = inherit).
- Precedence: module override → global → direct.
- Transport notes: the loopback-only transport rule (DESIGN §13) applies
  to the proxy host too — local mock proxies must listen on loopback or
  a `FMD_HTTP_ALLOW_HOSTS` entry. HTTP proxies receive the
  absolute-form request line + `Proxy-Authorization` (basic); SOCKS5
  gets RFC 1929 auth subnegotiation; SOCKS4 uses the 4a hostname form.

## Retention tuning (§9)

- Job history: terminal jobs (done/failed/cancelled) are pruned after
  30 days (`RETENTION_MS`, §9). The default needs no action; to change
  the window, adjust `RETENTION_MS` in `server/src/jobs/queue/queue.ts`
  and redeploy (pruning runs with the queue's normal writes — no
  separate job).
- WAL growth: auto-checkpoint is 1000 pages (tunable via
  `SqliteJobQueueOptions.walAutocheckpointPages`). If the `-wal`
  sidecar grows unbounded (watch `ls -la <dataDir>/app.db-wal` in the
  metrics-adjacent host monitoring), lower the page count or increase
  checkpoint headroom; a >100 MB WAL with a busy write path is the
  usual threshold to act at.
- WS event ring (D19): last 1000 events per job, 15 min max age —
  fixed bounds, no tuning knob by design.

## Troubleshooting

| Symptom | Meaning | First actions |
|---|---|---|
| `worker_stalled` failures (`fmd_job_failures_total{kind="worker_stalled"}`) | A Lua worker missed its event deadline twice (§4 watchdog) — non-HTTP hang in a module | Check `fmd_module_request_latency_seconds` for the module; re-run the chapter (resume markers make it cheap); if one module stalls repeatedly, flag it known-broken upstream and disable it (`PUT /api/modules/:id {enabled:false}`) |
| `engine_oom` failures / RSS near budget | Engine pool memory (§5.12: 2 GB default budget) | Watch `fmd_engine_pool_rss_bytes` + GC counters; reduce concurrent downloads (queue concurrency per lane); pack failures under memory pressure are retryable by design (D16) |
| Pack failures (`fmd_job_failures_total{kind="pack"}`) | Packer hit its 512 MB per-job budget or disk full (D16) | Check disk headroom under `library/`; retry the job — packing restarts from persisted markers; persistent failures on one chapter → inspect the page set size |
| Sync rate-limit (403/429 in sync logs, batch stalls) | GitHub rate budget exhausted (§6.1: 10 req/s, burst 50) | The batch stops CLEANLY — pending catalog ids stay in `data/sync/catalog-batch.json`; wait for the rate window, then `POST /api/sync/catalog/all` resumes from ETags (unchanged blobs skip). Never loop-retry inside the window |
| /readyz 503 `bootstrap: …` | D20 first-run bootstrap still running (or failed) | Watch the structured/plain bootstrap log lines; on FAILED the reason names the stage — fix upstream reachability, restart (stages skip when their artifact is installed) |
| /readyz 503 `catalogs (…): file is not a database` | Catalog file corrupted (partial copy, bad restore) | /healthz stays 200 — do NOT restart-loop. Re-sync that catalog: `POST /api/sync/catalog/<ID>` (atomic re-install), or full restore from backup (see Backup/restore) |
| Queue depth grows, nothing claims | Lane stopped / worker drain stuck | `GET /api/jobs?state=queued` for the lane; restart is safe (orphaned `running` rows re-enter as `retry` at boot, progress preserved) |

### Phase-3 e2e gate (`scripts/e2e.sh --phase3`) — failure artifacts

The download-engine gate runs after the Phase-2 scenario in the same
stack (compose when docker is available, the process-mode twin
otherwise):

```sh
bash scripts/e2e.sh --phase3
```

Scenarios (web/e2e/download-flow.spec.ts, Playwright project
`phase3`): ① enqueue from the Manga page → WS progress → packed file in
Library → artifact downloaded from `/api/library/:id/file` and
validated by walking the ZIP central directory; ② slow-image injection
(mock `/_control/slow`) → cancel from Downloads → `cancelled` →
re-enqueue resumes from the persisted 'D' markers (mock `/_stats`
request counts prove already-downloaded images are NOT re-fetched);
③ injected 500s (`/_control/fail500`) → job `retry` state visible →
eventual success.

On ANY failure the script exits non-zero and copies the Playwright
failure artifacts to `e2e/.tmp/artifacts/playwright/` (config:
`trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`,
output dir `FMD_E2E_TRACE_DIR`):

- `trace.zip` — open in the trace viewer
  (`npx playwright show-trace e2e/.tmp/artifacts/playwright/<test>/trace.zip`)
  for the full action-by-action timeline, network log, and console.
- `error-context.md` + `test-failed-1.png` — the page snapshot at
  failure.
- The mock's request log (`e2e/.tmp/logs/mock.log`, or
  `GET 127.0.0.1:8091/_requests` while the stack is up) shows exactly
  which upstream requests the failed run made — cross-check the
  `/_stats` counters the assertions key on.

A green run leaves no trace artifacts (retained on failure only).

## Local operations (existing sections)

### Phase 0 toolchain

- Local CI gate: `npm run ci` (or `make ci`) — contract → lint →
  typecheck → test → corpus.
- Tests are offline; nothing in `npm test` reaches the network.
- Container: `docker compose -f docker/compose.yml up --build` →
  `GET :3000/healthz`.

### Runtime (server/src/runtime-entry.ts)

- Boot: assemble the real services (module sync, catalog sync, engine
  live info, SQLite §10 job store), listen, then run the D20
  bootstrap with /readyz gating (503 + stage `reason` → 200 when done).
  `/healthz` is liveness-only and stays up throughout.
- D20 first-run bootstrap: empty data dir (no `data/lua/modules` +
  `data/sync-state.json`) → module sync against the configured pin;
  registry sweep; catalogs listed in `FMD_BOOTSTRAP_CATALOGS` (csv)
  without an install receipt → §6.1 commits check + blob sync. Every
  stage skips when its artifact is installed, so restarts resume.
  Three start-order retries cover compose service races.
- Env surface: `FMD_WEB_DATA_DIR` (data root), `PORT`,
  `FMD2_REPO` / `FMD2_LUA_SHA` / `FMD2_CODELOAD_URL` (module pin, D9),
  `FMD_DB_URL` / `FMD_DB_API_BASE` (catalog upstream override),
  `FMD_BOOTSTRAP_CATALOGS`, `FMD_BOOTSTRAP_DISABLE` (D20 disable,
  below), `FMD_HTTP_ALLOW_HOSTS` (extra hosts module
  HTTP may reach — loopback is always allowed; the transport re-checks
  the same set), `FMD_STATIC_DIR` (SPA dist), `FMD_BOOTSTRAP_DELAY_MS`
  (demo/e2e stage pacing; leave 0 in production),
  `FMD_NORMALIZE_PATHS` / `--normalize-paths` (D5 filename opt-out,
  below).
- SIGTERM drain: bounded 25 s (well inside the 30 s stop budget) —
  stops accepting, logs the queued-job summary, closes catalog stores,
  disposes engines, exits 0. Log-asserted by scripts/e2e.sh.
- One-command verification: `bash scripts/e2e.sh` (compose stack when
  docker is available, process-mode twin otherwise) — see README. The
  compose leg is validated with the real compose implementation in both
  modes by `scripts/compose-check.sh` (daemon-less `docker compose
  config` render + effective-config asserts + digest-pin freshness).

### First-run bootstrap (D20) — the three knobs

| Knob | Default | Effect |
|---|---|---|
| `FMD_BOOTSTRAP_CATALOGS` | empty | csv of catalog ids the bootstrap installs on an empty data dir (after the §6.1 commits check, one call) |
| `FMD_BOOTSTRAP_DELAY_MS` | `0` | Minimum wall time per stage — demo/e2e affordance that makes the progress banner/log stages observable; leave 0 in production |
| `FMD_BOOTSTRAP_DISABLE` | unset | `1` = the ENTIRE first-run sync is skipped: the bootstrap short-circuits to done (log: `bootstrap: disabled (FMD_BOOTSTRAP_DISABLE=1) …`), zero sync jobs enqueued, zero upstream traffic, and `/readyz` is green on an empty data dir (the lua-tree readiness check is dropped with the bootstrap — the operator owns provisioning) |

Disabled-deployment procedure: boot with `FMD_BOOTSTRAP_DISABLE=1`,
provision the data dir yourself (mount a prepared `lua/` tree +
`catalogs/*.db` + receipts, or restore a backup), then either keep the
flag set permanently (updates then run through
`POST /api/sync/modules` / `POST /api/sync/catalog/all` on your
schedule) or unset it for the next restart to let the bootstrap resume
the SHA-gated remainder. While the registry is unprovisioned, live info
answers 503 with the `FMD_BOOTSTRAP_DISABLE=1` reason instead of the
bootstrap-still-running one.

### Filename parity vs Linux-normalized (D5)

Filename resolution defaults to **Windows-desktop parity** (D5):
FMD2's tail truncation over `CurrentMaxFileNameLength` (HEAD deleted,
TAIL survives; 0 = no limit). Switch to **sanitized Linux-normalized
paths** with `FMD_NORMALIZE_PATHS=1` (env) or the `--normalize-paths`
CLI alias: same symbol sanitization, control units (C0 + DEL) deleted,
and the tail truncation NOT applied. The switch is one policy function
in `@fmd/contract` (`applyFileNamePolicy`) both filename resolvers
share — resolution order and sanitization are identical in both modes.
Flag unset = byte-identical to the pre-switch goldens.

### Catalog sync (§6)

- Layout: `data/catalogs/<ID>.db` (read-only, rollback-journal) +
  install receipts `data/catalogs/<ID>.meta.json`; FTS sidecars
  `data/fts/<ID>.db`; batch state `data/sync/catalog-batch.json`;
  scratch `data/tmp/` (cleaned after each install).
- Extractor binary resolution: `FMD_CATALOG_7ZZ` → `7zz` → `7za` on
  PATH → the 7zip-bin binary shipped via node_modules (Dockerfile
  smoke-checks it at image build). Point `FMD_CATALOG_7ZZ` at an
  apt-installed `7zz` to override.
- Rate budget: 10 req/s, burst 50 (token bucket, §6.1); rate-limit
  behavior → Troubleshooting below.
- Catalog files are NEVER written after install (read-only attach);
  if a `-journal`/`-wal` file ever appears next to a catalog db, that
  is a bug — the invariant test in `server/test/sync/db/` enforces it.
- Interrupted installs are safe: catalogs land via atomic rename from
  a temp dir; a crash leaves the previous catalog (or none) visible
  and the temp extraction inert under `data/tmp/`.

### Live smoke suite (nightly, opt-in; §13.2)

- The nightly live smoke drives real upstreams and updates the §15
  pass-rate table; its rates feed `fmd_corpus_pass_rate` via the
  runtime's corpus provider. Run it from an operator schedule, not
  inside the container boot path.

### Volumes & permissions (non-root container)

The image runs as the `node` user (uid/gid 1000). The data root
`/app/data` (env `FMD_WEB_DATA_DIR`) holds `app.db`, `lua/`,
`catalogs/`, `fts/`, `library/`, `sync/`, `tmp/`.

- **Named volume (default, `docker/compose.yml`):** the Dockerfile
  pre-creates `/app/data` and `chown node:node`s it BEFORE the
  `VOLUME`/`USER` stages, so a fresh named volume inherits `node`
  ownership on first mount. Nothing to do.
- **Bind mount:** the host directory must be writable by uid 1000 —
  `sudo chown -R 1000:1000 /srv/fmd-data` (or `chmod` a dedicated
  group). A wrong owner surfaces as `SQLITE_CANTOPEN`/`EACCES` on boot
  (troubleshooting below); the container cannot fix it (non-root by
  design).
- **Backup/restore** interacts with volumes via the Backup/restore
  section above — stop the app (or use the online-backup API) so
  `-wal`/`-shm` sidecars are folded in before copying.
- **Library output:** downloads land under `data/library/` (inside the
  same volume); to serve them from the host, mount the volume (not a
  second path) or point `FMD_WEB_DATA_DIR` at the mounted tree and keep
  the uid-1000 rule.
