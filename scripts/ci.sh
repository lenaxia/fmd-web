#!/usr/bin/env bash
# Local CI gate for fmd-web (GitHub-Action-less; DESIGN.md Phase-0
# toolchain + Phase-1 gate). Fails fast, in order:
# contract:check -> lint -> typecheck -> test -> corpus.
#
# The corpus step replays the full seed corpus through the live query
# engine, regenerates docs/COMPAT.md and gate-fails when the pass rate
# drops below 99% or any mismatch is undocumented (see
# corpus/scripts/generate-compat.ts --gate). The nightly LIVE smoke
# harness (server/tools/smoke) is NOT part of CI by design — it needs
# the explicit --live flag and never runs here.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> contract:check (Pascal extractors vs contract.json vs generated bindings)"
npm run contract:check

echo "==> lint"
npm run lint

echo "==> typecheck"
npm run typecheck

echo "==> test (offline)"
npm test

echo "==> corpus (full seed replay vs FPC oracle; >=99% + zero undocumented mismatches)"
npx tsx corpus/scripts/generate-compat.ts --gate

# The committed COMPAT.md must already reflect the fresh replay (generation
# is byte-stable); a diff means the committed artifact went stale.
if ! git diff --exit-code -- docs/COMPAT.md; then
  echo "corpus gate FAILED: docs/COMPAT.md is stale (regenerated content differs from the committed artifact)"
  exit 1
fi

echo "==> CI gate passed"
