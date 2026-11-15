#!/usr/bin/env bash
# fmd-web compose e2e — the Phase-2 (+ --phase3) exit gate, ONE command:
#
#   bash scripts/e2e.sh                 # compose stack (docker) when available
#   bash scripts/e2e.sh --mode compose  # force the compose stack
#   bash scripts/e2e.sh --mode process  # process-mode twin (no docker: same
#                                       # fixtures, mock script, app entry, specs)
#   bash scripts/e2e.sh --phase3        # + the Phase-3 gate scenarios
#                                       # (download → pack → library →
#                                       # cancel/resume → retry; the SAME
#                                       # stack, one more Playwright project)
#
# Scenario (offline — fixtures + local mock upstream only):
#   1. build the repo + SPA, prep the fixture upstream tree (crafted
#      catalog .7z, fixture lua zipball, commits JSON, manga + chapter
#      pages, per-(chapter,page) deterministic JPEG images)
#   2. boot the stack: docker compose (test profile) or the process twin
#   3. Playwright bootstrap-watch: empty-state → bootstrap progress → ready
#      (starts BEFORE the readiness gate so the banner is observable)
#   4. wait-on /readyz (healthcheck gates the test startup)
#   5. Playwright main: browse latest → search → manga detail (live info
#      through the seed module vs the mock upstream) → dry-run enqueue →
#      Downloads shows the queued job
#   5b. (--phase3) Playwright phase3: enqueue → WS progress → library
#      listing → artifact download validated (zip central directory);
#      slow-image cancel → cancelled → re-enqueue resumes via persisted
#      markers (mock request-count asserted); injected 500s → job retry
#      visible → recovers. Failure retains Playwright traces +
#      screenshots (copied to e2e/.tmp/artifacts/playwright/).
#   6. evidence: mock request log, non-root container user (id),
#      SIGTERM drain ≤30s with flush logs, image digest/SBOM record
#   7. teardown + artifact dump under e2e/.tmp/artifacts/
set -euo pipefail

MODE="auto"
PHASE3=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --mode=*) MODE="${1#--mode=}"; shift ;;
    --phase3) PHASE3=1; shift ;;
    --phase3=true) PHASE3=1; shift ;;
    --phase3=false) PHASE3=0; shift ;;
    *) echo "unknown arg: $1 (usage: e2e.sh [--mode auto|compose|process] [--phase3])" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$ROOT/e2e/.tmp"
ART="$TMP/artifacts"
LOGS="$TMP/logs"
mkdir -p "$ART" "$LOGS"

APP_URL="http://localhost:3000"
MOCK_HOST_URL="http://127.0.0.1:8091"

log() { printf '\n[e2e] %s\n' "$*"; }
fail() { printf '\n[e2e] FAIL: %s\n' "$*" >&2; exit 1; }

if [[ "$MODE" == "auto" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    MODE="compose"
  else
    MODE="process"
    log "docker unavailable — running the process-mode twin (same fixtures/mock/entry/specs)"
  fi
fi

# ── compose-leg validation (REAL docker compose tooling, daemon-less) ──
# Renders + merges the two compose files with `docker compose config`
# and asserts the effective config (env_file interpolation, profile,
# depends_on, drain budget, digest pin). Uses the host CLI on docker
# hosts; otherwise the vendored static CLI under e2e/.tmp/bin. Compose
# mode REQUIRES it (strict); process mode runs it whenever a CLI is
# available and skips with a loud note otherwise.
COMPOSE_CHECK_STRICT=1
if [[ "$MODE" != "compose" ]]; then
  COMPOSE_CHECK_STRICT=0
fi
COMPOSE_CHECK_STRICT=$COMPOSE_CHECK_STRICT bash scripts/compose-check.sh "$ART"

# Pre-flight: the scenario owns ports 3000 (app) and 8091 (mock host
# mapping) — a stale server from an earlier run would silently skunk the
# bootstrap-watch pass.
if command -v ss >/dev/null 2>&1; then
  for port in 3000 8091; do
    if ss -tln 2>/dev/null | grep -q ":${port} "; then
      fail "port ${port} already in use — stop the stale server (e.g. pkill -f runtime-entry.js) and re-run"
    fi
  done
fi

# ── 1. build + fixture prep ─────────────────────────────────────────────
log "building workspaces (tsc -b) + SPA (vite)"
npm run build --silent
npm run build -w @fmd/web --silent

# The catalog fixture embeds the mock base in its entry links — the
# module fetches those URLs verbatim (live info), so the base must be
# the one THIS mode's app can actually reach.
if [[ "$MODE" == "compose" ]]; then
  MOCK_BASE="http://e2e-mock:8081"
else
  MOCK_BASE="http://127.0.0.1:8091"
fi
log "preparing fixture upstream tree (crafted catalog .7z + fixture zipball; mock base $MOCK_BASE)"
node e2e/prep.mjs --out "$TMP/fixtures/upstream" --mock-base "$MOCK_BASE"
cp "$TMP/fixtures/upstream/manifest.json" "$ART/fixture-manifest.json"

MOCK_LOG="$LOGS/mock.log"
APP_LOG="$LOGS/app.log"
: > "$MOCK_LOG"; : > "$APP_LOG"

# ── 2. boot the stack ───────────────────────────────────────────────────
if [[ "$MODE" == "compose" ]]; then
  # Explicit project name: deterministic container naming, no collision
  # with other compose activity on the host. The trap registers BEFORE
  # `up` so a failed start still tears down partial state.
  COMPOSE="docker compose -p fmd-e2e -f docker/compose.yml -f docker/compose.e2e.yml --profile test"
  down() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
  trap 'down' EXIT
  log "building the app image"
  $COMPOSE build app
  log "starting the compose stack (app + e2e-mock, test profile)"
  $COMPOSE up -d
else
  log "starting the mock upstream (process mode)"
  node e2e/mock-upstream.mjs --root "$TMP/fixtures/upstream" --port 8091 \
    >"$MOCK_LOG" 2>&1 &
  MOCK_PID=$!
  down() {
    [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
    [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
  }
  trap 'down' EXIT
fi

if [[ "$MODE" == "process" ]]; then
  E2E_SHA=$(python3 -c "import json;print(json.load(open('e2e/fixtures/e2e.json'))['luaSha'])")
  E2E_REPO=$(python3 -c "import json;print(json.load(open('e2e/fixtures/e2e.json'))['repo'])")
  E2E_CATALOG=$(python3 -c "import json;print(json.load(open('e2e/fixtures/e2e.json'))['catalogId'])")
  DATA_DIR="$TMP/app-data"
  rm -rf "$DATA_DIR"
  log "starting the app runtime (process mode, empty data dir → D20 bootstrap)"
  PORT=3000 \
  NODE_ENV=production \
  FMD_WEB_DATA_DIR="$DATA_DIR" \
  FMD_STATIC_DIR="$ROOT/web/dist-web" \
  FMD_BOOTSTRAP_DELAY_MS=2500 \
  FMD2_REPO="$E2E_REPO" \
  FMD2_LUA_SHA="$E2E_SHA" \
  FMD2_CODELOAD_URL="http://127.0.0.1:8091/codeload" \
  FMD_DB_URL="http://127.0.0.1:8091/FMD2-DB/db" \
  FMD_DB_API_BASE="http://127.0.0.1:8091/api-github" \
  FMD_BOOTSTRAP_CATALOGS="$E2E_CATALOG" \
  node server/dist/src/runtime-entry.js >"$APP_LOG" 2>&1 &
  APP_PID=$!
  echo "$APP_PID" > "$TMP/app.pid"
fi

# ── 3. bootstrap-watch (BEFORE the readiness gate — UI-asserted D20) ───
log "Playwright: bootstrap-watch (empty-state → bootstrap progress → ready)"
(cd web && npx playwright test --config playwright.compose.config.ts --project=bootstrap-watch)
cp "$TMP/fixtures/upstream/manifest.json" "$ART/fixture-manifest.json" 2>/dev/null || true

# ── 4. readiness gate (wait-on /readyz) ────────────────────────────────
log "waiting on /readyz (healthcheck-gated test startup)"
npx wait-on --timeout 120000 "$APP_URL/readyz"
log "/readyz is 200 ready"

# ── 5. main scenario ───────────────────────────────────────────────────
log "Playwright: main scenario (browse → search → live info → dry-run → Downloads)"
(cd web && npx playwright test --config playwright.compose.config.ts --project=main)

# ── 5b. phase3 gate (optional) ─────────────────────────────────────────
# The download-engine gate: enqueue → WS progress → pack → library →
# artifact validation; cancel/resume via persisted markers (request-count
# asserted against the mock's /_stats); injected 500s → retry → recover.
# Traces/screenshots are RETAINED ON FAILURE and copied into the
# artifacts dir (docs/runbook.md: open trace.zip in the trace viewer).
PLAYWRIGHT_TRACE_DIR="$TMP/playwright"
rm -rf "$PLAYWRIGHT_TRACE_DIR"
if [[ "$PHASE3" == "1" ]]; then
  log "Playwright: phase3 gate (download → pack → library → cancel/resume → retry)"
  if (cd web && FMD_E2E_TRACE_DIR="$PLAYWRIGHT_TRACE_DIR" npx playwright test --config playwright.compose.config.ts --project=phase3); then
    log "phase3 gate green"
  else
    PW_STATUS=$?
    mkdir -p "$ART/playwright"
    if compgen -G "$PLAYWRIGHT_TRACE_DIR/*" > /dev/null; then
      cp -r "$PLAYWRIGHT_TRACE_DIR"/. "$ART/playwright"/
      log "FAIL: phase3 gate failed — Playwright traces + screenshots copied to $ART/playwright"
    else
      log "FAIL: phase3 gate failed — no trace artifacts were produced (check web/test-results)"
    fi
    exit "$PW_STATUS"
  fi
fi

# ── 6. evidence ─────────────────────────────────────────────────────────
log "asserting the mock upstream request log (offline proof: only fixtures hit)"
curl -fsS "$MOCK_HOST_URL/_requests" > "$ART/mock-requests.json"
python3 - "$ART/mock-requests.json" <<'PY'
import json, sys
paths = [r["path"] for r in json.load(open(sys.argv[1]))["requests"]]
def find(prefix):
    return next((p for p in paths if p.startswith(prefix)), None)
zipball = find("/codeload/")
commits = find("/api-github/repos/")
catalog = find("/FMD2-DB/db/7z/")
site = find("/manga/alpha-quest")
missing = [n for n, v in [("zipball", zipball), ("commits", commits), ("catalog .7z", catalog), ("site page", site)] if v is None]
assert not missing, f"mock upstream never served: {missing} (offline proof incomplete)"
print("[e2e] mock served: zipball, commits, catalog .7z, site page — the ONLY upstream traffic")
PY

if [[ "$MODE" == "compose" ]]; then
  log "asserting the container runs as a NON-ROOT user (id-asserted)"
  UID_OUT=$($COMPOSE exec -T app id -u)
  [[ "$UID_OUT" =~ ^[0-9]+$ ]] && [[ "$UID_OUT" != "0" ]] || fail "app container runs as uid $UID_OUT (expected non-root)"
  ID_FULL=$($COMPOSE exec -T app id)
  echo "app container: $ID_FULL" > "$ART/non-root-id.txt"
  log "container identity: $ID_FULL"

  log "recording image digest + SBOM evidence (docs/docker-pinning.md)"
  docker image inspect fmd-web:local --format '{{.Id}}' > "$ART/image-id.txt" 2>/dev/null || true
  docker image inspect fmd-web:local --format '{{json .RepoDigests}}' > "$ART/image-repo-digests.json" 2>/dev/null || true
  if command -v syft >/dev/null 2>&1; then
    syft fmd-web:local -o spdx-json > "$ART/image-sbom.spdx.json" 2>/dev/null || true
    log "SBOM captured with syft"
  else
    echo "syft not installed — SBOM procedure documented in docs/docker-pinning.md (CI runs syft + double-build SBOM diff)" > "$ART/image-sbom.NOTE"
  fi
else
  log "asserting the server process runs NON-ROOT (process-mode id equivalent)"
  SERVER_UID=$(ps -o uid= -p "$(cat "$TMP/app.pid")")
  [[ "$SERVER_UID" != "0" ]] || fail "server runs as uid 0"
  id > "$ART/non-root-id.txt"
  echo "process-mode twin: server uid=$SERVER_UID (invoking user, non-root)" >> "$ART/non-root-id.txt"
  log "server uid=$SERVER_UID (non-root)"
fi

# ── SIGTERM graceful drain (≤30s, flush logs asserted) ─────────────────
log "SIGTERM drain: stopping the app (bound 30s), asserting flush logs"
# Millisecond timing: whole-second granularity could pass a 30.x s drain.
DRAIN_STARTED_MS=$(date +%s%3N)
if [[ "$MODE" == "compose" ]]; then
  # Stop FIRST, then read the logs: `compose logs` covers the container's
  # whole life including the post-SIGTERM drain lines — captured before
  # the stop they could never be in the log.
  $COMPOSE stop -t 35 app
  $COMPOSE logs app > "$LOGS/app-compose.log" 2>&1 || true
  APP_LOG="$LOGS/app-compose.log"
else
  APP_PID=$(cat "$TMP/app.pid" 2>/dev/null || true)
  [[ -n "$APP_PID" ]] && kill -TERM "$APP_PID"
  wait "$APP_PID" 2>/dev/null || true
fi
DRAIN_MS=$(( $(date +%s%3N) - DRAIN_STARTED_MS ))
echo "${DRAIN_MS}ms" > "$ART/drain-ms.txt"
echo "$(( DRAIN_MS / 1000 ))" > "$ART/drain-seconds.txt"
if [[ "$DRAIN_MS" -gt 30000 ]]; then
  fail "drain took ${DRAIN_MS}ms (>30000ms)"
fi
for needle in "SIGTERM received — beginning graceful drain" "stopped accepting connections" "queued job(s) preserved" "flush complete" "drain: complete in"; do
  grep -q "$needle" "$APP_LOG" || fail "drain log line missing: '$needle'"
done
log "drain OK: exited in ${DRAIN_MS}ms with flush logs"

# ── 7. teardown + summary ───────────────────────────────────────────────
if [[ "$MODE" == "compose" ]]; then
  $COMPOSE logs e2e-mock > "$LOGS/mock-compose.log" 2>&1 || true
  # The drain must be a CLEAN exit: the container exited itself (flush
  # completed, exit code 0) — not SIGKILLed at the stop bound. `ps -a`
  # because the app is STOPPED at this point.
  APP_CID=$($COMPOSE ps -a -q app)
  [[ -n "$APP_CID" ]] || fail "app container not found after stop"
  APP_EXIT=$(docker inspect "$APP_CID" --format '{{.State.ExitCode}}')
  APP_STATE=$(docker inspect "$APP_CID" --format '{{.State.Status}}')
  echo "exit=$APP_EXIT state=$APP_STATE" > "$ART/app-exit.txt"
  [[ "$APP_EXIT" == "0" ]] || fail "app container exited $APP_STATE/$APP_EXIT (expected clean exit 0 from the drain)"
  log "app container: state=$APP_STATE exit=$APP_EXIT (clean drain exit)"
fi
down
trap - EXIT

log "PASS — compose e2e green (mode: $MODE, drain ${DRAIN_MS}ms)"
log "artifacts: $ART (request log, drain timing, non-root id, digest/SBOM evidence)"
