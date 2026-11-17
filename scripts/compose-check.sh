#!/usr/bin/env bash
# Compose-leg validation (scripts/e2e.sh runs this in BOTH modes).
#
# Validates the e2e compose overlay with the REAL docker compose
# implementation — `docker compose config` renders + merges the two
# files (env_file interpolation, profiles, depends_on conditions,
# healthcheck overrides) purely client-side; NO docker daemon needed.
# On a docker host the host CLI is used; otherwise a vendored static
# CLI + compose plugin (e2e/.tmp/bin, authoring-time download, pinned
# below) provides the same validation. This does NOT run containers —
# daemon execution stays compose-mode's job; what it removes is the
# "merge by construction only" risk for the compose leg.
#
# Pinned tooling: docker CLI 27.5.1 + compose v2.32.4 (both from
# download.docker.com / github.com/docker/compose releases).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ART="${1:-$ROOT/e2e/.tmp/artifacts}"
STRICT="${COMPOSE_CHECK_STRICT:-0}"   # 1 = fail when no docker CLI at all
mkdir -p "$ART"

log() { printf '[compose-check] %s\n' "$*"; }
fail() { printf '[compose-check] FAIL: %s\n' "$*" >&2; exit 1; }

COMPOSE_FILES=(-f docker/compose.yml -f docker/compose.e2e.yml)

# ── pick a docker CLI ───────────────────────────────────────────────────
DOCKER_BIN=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_BIN="docker"
  log "using host docker CLI: $(docker --version 2>&1)"
elif [[ -x "$ROOT/e2e/.tmp/bin/docker/docker" && -x "$ROOT/e2e/.tmp/bin/cli-plugins/docker-compose" ]]; then
  export DOCKER_CONFIG="$ROOT/e2e/.tmp/bin"
  DOCKER_BIN="$ROOT/e2e/.tmp/bin/docker/docker"
  log "using vendored docker CLI: $($DOCKER_BIN --version 2>&1) + $($DOCKER_BIN compose version 2>&1)"
else
  if [[ "$STRICT" == "1" ]]; then
    fail "no docker CLI with the compose plugin (host docker, or vendored e2e/.tmp/bin) — compose leg cannot be validated"
  fi
  log "WARN: no docker CLI available — compose-leg validation SKIPPED (install docker, or vendor e2e/.tmp/bin per docs/docker-pinning.md)"
  echo "skipped: no docker CLI" > "$ART/compose-config.NOTE"
  exit 0
fi

# ── render + merge with the real implementation ────────────────────────
log "rendering the merged config (docker compose config — real merge, no daemon)"
# shellcheck disable=SC2086
"$DOCKER_BIN" compose -p fmd-e2e "${COMPOSE_FILES[@]}" --profile test config > "$ART/compose-config.rendered.yaml" 2>"$ART/compose-config.err" \
  || fail "docker compose config rejected the files: $(cat "$ART/compose-config.err")"
"$DOCKER_BIN" compose -p fmd-e2e "${COMPOSE_FILES[@]}" --profile test config --format json > "$ART/compose-config.json" 2>/dev/null \
  || fail "docker compose config --format json failed"

# ── assert the effective merged config ─────────────────────────────────
python3 - "$ART/compose-config.json" <<'PY'
import json, os, sys

cfg = json.load(open(sys.argv[1]))
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1]))))
services = cfg.get("services", {})

def fail(msg):
    print(f"[compose-check] FAIL: {msg}", file=sys.stderr)
    sys.exit(1)

if set(services) != {"app", "e2e-mock"}:
    fail(f"merged services must be app + e2e-mock, got {sorted(services)}")

app = services["app"]
mock = services["e2e-mock"]

# app: mock ordering, drain budget, clean stop, published port, data volume
deps = (app.get("depends_on") or {}).get("e2e-mock", {})
if deps.get("condition") != "service_healthy":
    fail(f"app must depend_on e2e-mock service_healthy, got {deps}")
if app.get("stop_grace_period") != "30s":
    fail(f"app stop_grace_period must be 30s (drain budget), got {app.get('stop_grace_period')}")
if app.get("restart") not in ("no", None):
    fail(f"app restart must be 'no' in the e2e leg, got {app.get('restart')}")
ports = app.get("ports") or []
published = {p.get("published") for p in ports if isinstance(p, dict)}
if "3000" not in published:
    fail(f"app must publish 3000, got {ports}")
vols = app.get("volumes") or []
if not any(v.get("target") == "/app/data" for v in vols):
    fail(f"app must mount a volume at /app/data, got {vols}")

# app env: the e2e env_file landed (interpolated into the merge)
env = app.get("environment") or {}
required_env = {
    "FMD2_CODELOAD_URL": "http://e2e-mock:8081/codeload",
    "FMD_DB_URL": "http://e2e-mock:8081/FMD2-DB/master",
    "FMD_DB_API_BASE": "http://e2e-mock:8081/api-github",
    "FMD_HTTP_ALLOW_HOSTS": "e2e-mock",
    "FMD_STATIC_DIR": "/app/web/dist-web",
    "FMD_WEB_DATA_DIR": "/app/data",
    "PORT": "3000",
}
for key, expected in required_env.items():
    if env.get(key) != expected:
        fail(f"app env {key}={env.get(key)!r}, expected {expected!r}")

hc = " ".join(str(x) for x in (app.get("healthcheck") or {}).get("test", []))
if "/healthz" not in hc:
    fail(f"app healthcheck must target /healthz, got {hc!r}")

# mock: digest-pinned base, test profile, fixture mounts exist on the host
image = mock.get("image", "")
if "@" not in image or not image.endswith("sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b"):
    fail(f"e2e-mock image must be the digest-pinned node:22.14.0-bookworm-slim, got {image!r}")
profiles = mock.get("profiles") or []
if "test" not in profiles:
    fail(f"e2e-mock must live under the test profile, got {profiles}")
cmd = " ".join(str(x) for x in (mock.get("command") or []))
if "mock-upstream.mjs" not in cmd or "--port 8081" not in cmd:
    fail(f"e2e-mock command must run the mock on 8081, got {mock.get('command')!r}")
mock_ports = mock.get("ports") or []
if not any(str(p.get("published")) == "8091" and str(p.get("target")) == "8081" for p in mock_ports):
    fail(f"e2e-mock must map host 8091 -> 8081, got {mock_ports}")
for v in mock.get("volumes") or []:
    src = v.get("source", "")
    # `compose config` renders bind sources absolute; if a relative path
    # ever slips through, resolve it against the repo root.
    target = src if os.path.isabs(src) else os.path.join(REPO_ROOT, src)
    if not os.path.exists(target):
        fail(f"e2e-mock bind source does not exist: {src}")
    if v.get("type") != "bind":
        fail(f"e2e-mock mount must be a bind mount, got {v}")

print("[compose-check] merged config asserts OK (app env/depends_on/drain budget/ports/volume, mock pin/profile/mounts)")
PY

# ── Dockerfile contract (what the compose build produces) ──────────────
grep -q '^USER node' docker/Dockerfile || fail "Dockerfile must run as USER node (non-root)"
grep -q 'HEALTHCHECK' docker/Dockerfile || fail "Dockerfile must carry a HEALTHCHECK"
CMD_FILE=$(sed -n 's/^CMD \["node", "\([^"]*\)"\]$/\1/p' docker/Dockerfile | tail -1)
[[ -n "$CMD_FILE" ]] || fail "Dockerfile CMD must run a node entry file"
# CMD_FILE is the dist-tree path (server/dist/src/runtime-entry.js):
# its presence proves the runtime entry was built (npm run build).
[[ -f "$ROOT/$CMD_FILE" ]] || fail "built runtime entry missing: $CMD_FILE (run npm run build)"
[[ -d "$ROOT/web/dist-web" ]] || fail "SPA bundle missing (npm run build -w @fmd/web produces web/dist-web — a Dockerfile COPY source)"
log "Dockerfile contract OK (non-root USER, HEALTHCHECK, CMD -> built runtime entry, COPY sources present)"

# ── digest pin freshness (registry check; advisory when offline) ───────
PIN="sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b"
if TOKEN=$(curl -fsS --max-time 10 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])" 2>/dev/null); then
  RESOLVED=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
    -I "https://registry-1.docker.io/v2/library/node/manifests/22.14.0-bookworm-slim" 2>/dev/null \
    | grep -i docker-content-digest | awk '{print $2}' | tr -d '\r')
  if [[ "$RESOLVED" == "$PIN" ]]; then
    log "digest pin FRESH: node:22.14.0-bookworm-slim = $PIN"
    echo "$RESOLVED" > "$ART/mock-image-digest.txt"
  else
    fail "compose pin $PIN differs from the registry digest for node:22.14.0-bookworm-slim ($RESOLVED) — re-pin (docs/docker-pinning.md)"
  fi
else
  log "WARN: registry unreachable — digest freshness check skipped (pin asserted against docs/docker-pinning.md only)"
fi

# ── §5.11 browser profile render (docker/compose.yml standalone) ───────
# The `browser` profile is validated with the SAME real implementation:
# a render WITHOUT the profile must NOT contain flaresolverr (the
# known-broken flags stand); a render WITH it must carry the
# digest-pinned flaresolverr service + healthcheck + the app's
# FMD_WEB_BROWSER_SIDECAR_URL pass-through (empty default).
log "rendering the §5.11 browser profile (docker compose config — real merge, no daemon)"
"$DOCKER_BIN" compose -p fmd-browser -f docker/compose.yml --profile browser config --format json > "$ART/compose-config.browser.json" 2>/dev/null \
  || fail "docker compose config rejected the browser profile render"
python3 - "$ART/compose-config.json" "$ART/compose-config.browser.json" <<'PY'
import json, sys

base = json.load(open(sys.argv[1]))
browser = json.load(open(sys.argv[2]))

def fail(msg):
    print(f"[compose-check] FAIL: {msg}", file=sys.stderr)
    sys.exit(1)

if "flaresolverr" in base.get("services", {}):
    fail("flaresolverr must NOT be in the default (no-profile) render — the §5.10 known-broken flags stand without --profile browser")

services = browser.get("services", {})
if "flaresolverr" not in services:
    fail("browser-profile render must contain the flaresolverr service")
fl = services["flaresolverr"]
PIN = "ghcr.io/flaresolverr/flaresolverr:v3.3.21@sha256:f104ee51e5124d83cf3be9b37480649355d223f7d8f9e453d0d5ef06c6e3b31b"
if fl.get("image") != PIN:
    fail(f"flaresolverr image must be digest-pinned {PIN}, got {fl.get('image')}")
hc = (fl.get("healthcheck") or {}).get("test") or []
if not any("8191/health" in str(part) for part in hc):
    fail("flaresolverr healthcheck must probe http://127.0.0.1:8191/health (the adapter's health gate path)")
profiles = fl.get("profiles") or []
if "browser" not in profiles:
    fail("flaresolverr must carry profiles: [browser]")
app_env = (services.get("app") or {}).get("environment") or {}
sidecar = app_env.get("FMD_WEB_BROWSER_SIDECAR_URL")
if sidecar is None:
    fail("app must carry the FMD_WEB_BROWSER_SIDECAR_URL env pass-through (empty default)")
print("[compose-check] §5.11 browser profile OK (digest-pinned flaresolverr + healthcheck + sidecar env pass-through)")
PY

log "PASS — compose leg validated with the real docker compose implementation"
