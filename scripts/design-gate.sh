#!/usr/bin/env bash
# Design-system gate (tsk-fuzzy-titanium-folds): enforces the token-only
# styling contract of the design system retrofit — the "anti-papering"
# guarantee that hand-rolled CSS cannot quietly come back.
#
#   1. styles/tokens.css is the ONLY stylesheet under web/src;
#   2. no TSX module imports CSS (only main.tsx, the entry, does);
#   3. no raw color literals (hex / rgb( / hsl( / oklch( in web/src TSX
#      outside the vendored ui/ components — the eslint rule mirrors
#      this; the grep is the CI belt-and-braces);
#   4. the shadcn component inventory and the pattern library exist.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
err() { echo "design-gate: $1" >&2; fail=1; }

# (1) tokens.css is the only stylesheet under web/src.
while IFS= read -r sheet; do
  if [[ "$sheet" != "web/src/styles/tokens.css" ]]; then
    err "unexpected stylesheet: $sheet (all styling must live in tokens.css / Tailwind utilities)"
  fi
done < <(find web/src -name '*.css' -type f)

# (2) Only the SPA entry imports CSS.
offenders=$(grep -rln "import './.*\.css'\|import \"./.*\.css\"" web/src --include='*.tsx' --include='*.ts' | grep -v '^web/src/main.tsx$' || true)
if [[ -n "$offenders" ]]; then
  err "CSS imports outside the SPA entry (main.tsx):
$offenders"
fi

# (3) No raw color literals outside the vendored ui/ components.
color_hits=$(grep -rEn "#[0-9a-fA-F]{6}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab)\(" \
  web/src/pages web/src/components/patterns web/src/components/*.tsx 2>/dev/null \
  | grep -v "Binary file" || true)
if [[ -n "$color_hits" ]]; then
  err "raw color literals outside tokens.css:
$color_hits"
fi

# (4) Component + pattern inventories.
for component in button input select command tabs dialog badge card table \
                 skeleton tooltip scroll-area progress dropdown-menu \
                 checkbox separator sheet sonner; do
  if [[ ! -f "web/src/components/ui/${component}.tsx" ]]; then
    err "missing shadcn/ui component: web/src/components/ui/${component}.tsx"
  fi
done
for pattern in PageHeader ListPanel EntryRow FilterBar StatPill EmptyState \
               ErrorBanner ProgressToast BottomTabNav; do
  if [[ ! -f "web/src/components/patterns/${pattern}.tsx" ]]; then
    err "missing pattern: web/src/components/patterns/${pattern}.tsx"
  fi
done

# Visual fixtures: every page × theme × VIEWPORT must have a committed
# screenshot (R3: desktop AND mobile are locked — 6 pages × 2 themes
# × 2 viewports = 24 fixtures; mobile shots carry the bottom-nav shell).
for page in browse manga downloads favorites library settings; do
  for theme in dark light; do
    for viewport in "" "-mobile"; do
      if ! ls web/e2e/visual/fixtures/*/ > /dev/null 2>&1 \
         || ! find web/e2e/visual/fixtures -name "${page}${viewport}-${theme}.png" | grep -q .; then
        err "missing visual fixture: ${page}${viewport}-${theme}.png (npm run e2e:visual:update -w @fmd/web)"
      fi
    done
  done
done

if [[ "$fail" -ne 0 ]]; then
  echo "design-gate: FAILED" >&2
  exit 1
fi
echo "design-gate: OK (tokens-only styling, inventory + visual fixtures present)"
