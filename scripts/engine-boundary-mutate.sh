#!/usr/bin/env bash
# Engine-boundary MUTATION tests (tsk-linear-varnish-restricts): the
# negative half of the gate — each of the four rules must FIRE on a
# planted violation. A rule that cannot fire is a rule that proves
# nothing; skipping this is papering (see the story's anti-papering
# clause). Runs the REAL gate script against a throwaway violation
# planted in server/src (cleaned up afterwards, trap-guarded).
set -euo pipefail
cd "$(dirname "$0")/.."

GATE=scripts/engine-boundary-gate.sh
TMP_DIR=server/src/gate-mutation-tmp
FACADE=server/src/engine/facade.ts
FACADE_BACKUP="$TMP_DIR/facade.backup.ts"
planted=0

cleanup() {
  rm -rf "$TMP_DIR"
  if [[ -f "$FACADE_BACKUP" ]]; then
    mkdir -p "$(dirname "$FACADE_BACKUP")"
    mv "$FACADE_BACKUP" "$FACADE"
  fi
}
trap cleanup EXIT

# plant <label> <expect-rule-id> -- plants via $1 then runs the gate,
# expecting a FAILURE that cites the expected rule id.
expect_fire() {
  local label="$1" rule_id="$2"
  planted=$((planted + 1))
  mkdir -p "$TMP_DIR"
  if ! bash "$GATE" > "$TMP_DIR/gate.out" 2>&1; then
    if grep -q "RULE $rule_id" "$TMP_DIR/gate.out"; then
      echo "mutation[$label]: RULE $rule_id fired as expected"
      return 0
    fi
    echo "mutation[$label]: gate FAILED but without RULE $rule_id — wrong rule fired:" >&2
    head -5 "$TMP_DIR/gate.out" >&2
    exit 1
  fi
  echo "mutation[$label]: gate PASSED despite the planted violation — RULE $rule_id cannot fire!" >&2
  exit 1
}

# ── M1: app-layer deep engine import (RULE facade-only) ─────────────────────
mkdir -p "$TMP_DIR"
cat > server/src/runtime/gate_mutation_probe.ts <<'EOF'
// gate mutation: deep engine submodule import from an app layer
import { SyncHostGate } from '../engine/shims/http-hostgate.js';
export const probe = SyncHostGate;
EOF
expect_fire "app-deep-import" "facade-only"
rm -f server/src/runtime/gate_mutation_probe.ts

# ── M2: wasmoon imported outside engine (RULE no-lua-outside) ───────────────
cat > server/src/catalog/gate_mutation_probe.ts <<'EOF'
// gate mutation: wasmoon outside the engine
import { LuaFactory } from 'wasmoon';
export const probe = LuaFactory;
EOF
expect_fire "wasmoon-outside" "no-lua-outside"
rm -f server/src/catalog/gate_mutation_probe.ts

# ── M3: Lua-named type imported outside engine (RULE no-lua-outside) ────────
cat > server/src/observability/gate_mutation_probe.ts <<'EOF'
// gate mutation: Lua-named mechanism binding outside the engine
import type { LuaHost } from '@fmd/contract';
export type Probe = LuaHost;
EOF
expect_fire "lua-named-type" "no-lua-outside"
rm -f server/src/observability/gate_mutation_probe.ts

# ── M4: engine importing an app layer (RULE engine-inward) ──────────────────
cat > server/src/engine/services/gate_mutation_probe.ts <<'EOF'
// gate mutation: engine reaching into an app layer
import { ApiError } from '../../api/errors.js';
export const probe = ApiError;
EOF
expect_fire "engine-app-import" "engine-inward"
rm -f server/src/engine/services/gate_mutation_probe.ts

# ── M5: facade exporting a Lua-mechanism name (RULE facade-hygiene) ─────────
mkdir -p "$TMP_DIR"
cp "$FACADE" "$FACADE_BACKUP"
printf '\n// gate mutation: Lua-mechanism name on the public surface\nexport type { LuaHost } from "./contract.js";\n' >> "$FACADE"
expect_fire "facade-lua-export" "facade-hygiene"
mv "$FACADE_BACKUP" "$FACADE"

echo "engine-boundary mutation tests: all $planted rules proven to fire"
