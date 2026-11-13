#!/usr/bin/env bash
# Local CI gate for fmd-web (DESIGN.md Phase-0 toolchain).
# Fails fast: typecheck -> lint -> test (offline).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> typecheck"
npm run typecheck

echo "==> lint"
npm run lint

echo "==> test (offline)"
npm test

echo "==> CI gate passed"
