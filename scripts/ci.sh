#!/usr/bin/env bash
# Local CI gate for fmd-web (GitHub-Action-less; DESIGN.md Phase-0
# toolchain + the full release gate, 0.1.0). Fails fast, in order:
#
#   contract:check -> lint -> typecheck -> test (unit + integration,
#   one offline suite) -> corpus (>=99% seed) -> e2e phase-2 -> e2e
#   phase-3 -> (optional --live smoke).
#
# The corpus step replays the full seed corpus through the live query
# engine, regenerates docs/COMPAT.md and gate-fails when the pass rate
# drops below 99% or any mismatch is undocumented (see
# corpus/scripts/generate-compat.ts --gate).
#
# The two e2e steps run scripts/e2e.sh against the compose stack when a
# docker daemon is available, else the documented process-mode twin
# (same fixtures, mock upstream, app entry, Playwright specs). Phase-2 =
# bootstrap-watch + main scenario; phase-3 adds the download gate
# (enqueue → WS progress → pack → library → cancel/resume → retry).
#
# The nightly LIVE smoke harness (server/tools/smoke) is NOT part of the
# default gate by design — it needs the explicit --live flag here and
# never runs unattended:
#
#   scripts/ci.sh            # the release gate (no external network)
#   scripts/ci.sh --live     # + nightly live smoke (rotating sample)
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --live) LIVE_SMOKE=1 ;;
    *) echo "unknown arg: $arg (usage: ci.sh [--live])" >&2; exit 2 ;;
  esac
done

echo "==> contract:check (Pascal extractors vs contract.json vs generated bindings)"
npm run contract:check

echo "==> lint"
npm run lint

echo "==> typecheck"
npm run typecheck

echo "==> test (unit + integration — the one offline suite, DESIGN.md §13)"
npm test

echo "==> corpus (full seed replay vs FPC oracle; >=99% + zero undocumented mismatches)"
npm run corpus

# The committed artifacts must already reflect the fresh replay
# (generation is byte-stable); a diff means a committed artifact went
# stale. docs/COMPAT.md: the human-readable tracker. docs/corpus-report.json:
# the machine report (per-module/per-expression pass rates) — the same
# bytes corpus-live.test.ts golden-pins.
if ! git diff --exit-code -- docs/COMPAT.md docs/corpus-report.json; then
  echo "corpus gate FAILED: docs/COMPAT.md / docs/corpus-report.json are stale (regenerated content differs from the committed artifacts)"
  exit 1
fi

echo "==> e2e phase-2 (bootstrap-watch + main: compose stack, or the process twin without docker)"
bash scripts/e2e.sh

echo "==> e2e phase-3 (download gate: enqueue → WS progress → pack → library → cancel/resume → retry)"
bash scripts/e2e.sh --phase3

if [[ "$LIVE_SMOKE" == "1" ]]; then
  echo "==> live smoke (--live: rotating nightly sample; external network — never in unattended CI)"
  npx tsx server/tools/smoke/run.ts --live
fi

echo "==> CI gate passed"
