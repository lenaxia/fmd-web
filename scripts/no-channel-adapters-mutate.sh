#!/usr/bin/env bash
# No-channel-adapters MUTATION tests (webhook story, review bounce
# merry-woodland-refrains): the negative half of the grep gate — an
# adapter-shaped file planted in EITHER scanned root must make the
# gate FAIL. The first shipping of the gate used \b-anchored whole
# words and the review proved camelCase identifiers
# (telegramAdapter / sendDiscordMessage / ntfyClient /
# slackWebhookUrl) passed GREEN; the tightened substring gate must
# fire on every one of those shapes. A gate that cannot fire is a
# gate that proves nothing (the engine-boundary-mutate discipline).
#
# Plants are throwaway files (trap-guarded cleanup); the REAL gate
# test runs against them via node_modules/.bin (D1 §8.1 — no npx).
set -euo pipefail
cd "$(dirname "$0")/.."

GATE_TEST=server/test/api/no-channel-adapters-grep.test.ts
SERVER_PROBE=server/src/gate_mutation_channel_adapter_probe.ts
WEB_PROBE=web/src/gate_mutation_channel_adapter_probe.ts
OUT=/tmp/opencode/no-channel-adapters-mutate.out
planted=0

cleanup() {
  rm -f "$SERVER_PROBE" "$WEB_PROBE" "$OUT"
}
trap cleanup EXIT

# expect_fire <label> <must-name-in-output> — runs the gate test and
# requires a FAILURE whose assertion output names the planted file.
expect_fire() {
  local label="$1" must_name="$2"
  planted=$((planted + 1))
  if node_modules/.bin/vitest run "$GATE_TEST" > "$OUT" 2>&1; then
    echo "mutation[$label]: gate PASSED despite the planted adapter — the ban cannot fire!" >&2
    exit 1
  fi
  if ! grep -q "$must_name" "$OUT"; then
    echo "mutation[$label]: gate failed but did not name the offender ($must_name):" >&2
    tail -20 "$OUT" >&2
    exit 1
  fi
  echo "mutation[$label]: gate fired as expected (offender named)"
}

# ── M1: camelCase adapter identifiers, server root — the exact shape ────────
# the review proved evaded the word-anchored gate.
cat > "$SERVER_PROBE" <<'EOF'
// gate mutation probe: adapter-shaped naming, server root
export const telegramAdapter = 1;
export function sendDiscordMessage(): void {}
export const ntfyClient = 3;
export const slackWebhookUrl = '';
EOF
expect_fire "server-camelcase-identifiers" "gate_mutation_channel_adapter_probe.ts"
rm -f "$SERVER_PROBE"

# ── M2: dotted API URL only, server root — the endpoint-string shape ───────
cat > "$SERVER_PROBE" <<'EOF'
// gate mutation probe: adapter endpoint URL, server root
export const endpoint = 'https://api.telegram.org/bot000/sendMessage';
EOF
expect_fire "server-dotted-url" "gate_mutation_channel_adapter_probe.ts"
rm -f "$SERVER_PROBE"

# ── M3: camelCase + URL, web root — the UI-side adapter shape ──────────────
if [[ -d web/src ]]; then
  cat > "$WEB_PROBE" <<'EOF'
// gate mutation probe: adapter-shaped naming, web root
export const discordBridge = { send: (): void => {} };
export const pushEndpoint = 'https://ntfy.sh/my-topic';
EOF
  expect_fire "web-camelcase-and-url" "gate_mutation_channel_adapter_probe.ts"
  rm -f "$WEB_PROBE"
else
  echo "mutation[web-camelcase-and-url]: web/src absent (server-only checkout) — skipped"
fi

# ── Clean tree control: the gate must be GREEN with every plant removed ────
if ! node_modules/.bin/vitest run "$GATE_TEST" > "$OUT" 2>&1; then
  echo "clean-tree control FAILED — the gate is red after cleanup (leftover plant?):" >&2
  tail -20 "$OUT" >&2
  exit 1
fi
echo "mutation[clean-tree-control]: gate green with all ${planted} plants removed"

echo "no-channel-adapters mutation tests: all adapter shapes proven to fire"
