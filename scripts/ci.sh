#!/usr/bin/env bash
# Local CI gate for fmd-web (DESIGN.md Phase-0 toolchain).
# Fails fast: typecheck -> lint -> contract drift -> test (offline).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> typecheck"
npm run typecheck

echo "==> lint"
npm run lint

echo "==> contract drift check (Pascal extractors vs contract.json vs generated bindings)"
npm run contract:check

echo "==> test (offline)"
npm test

echo "==> CI gate passed"
