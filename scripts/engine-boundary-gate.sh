#!/usr/bin/env bash
# Engine-boundary gate (tsk-linear-varnish-restricts): enforces the
# hermetic engine boundary of DESIGN.md §11 — "no Lua gets in" as a
# machine-checked property. Four rules, each a build failure:
#
#   RULE facade-only      App layers (api, jobs, runtime, sync, catalog,
#                         web) + the top-level entry files import the
#                         engine ONLY through the two doors:
#                         server/src/engine/facade.js (the wasmoon-free
#                         domain surface) or server/src/engine/index.js
#                         (the production door). Deep imports into
#                         engine/* submodules are forbidden.
#   RULE no-lua-outside   Outside engine/ (non-test server/src): zero
#                         imports of wasmoon, zero deep engine-submodule
#                         imports, zero Lua/Wasmoon-named imported
#                         bindings (the mechanism types live only inside
#                         the engine; app code names them through the
#                         facade's domain aliases).
#   RULE engine-inward    Inside engine/: dependencies point INWARD —
#                         engine code imports engine internals, node
#                         builtins, @fmd/contract and vetted leaf libs
#                         only, never app layers. (One designed edge:
#                         shims/install.ts reads the D4 key holder in
#                         tools/import/fmd2-crypto.js — itself
#                         machine-checked by fmd2-key-isolation.test.ts.)
#   RULE facade-hygiene  The facade's public surface is DOMAIN-shaped:
#                         no Lua/Wasmoon-named exported bindings, no
#                         wasmoon import in facade.ts.
#
# scripts/engine-boundary-mutate.sh negative-tests every rule (each must
# FIRE on a planted violation); ci.sh runs gate + mutation test.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import os
import re
import sys

fail = 0


def err(rule: str, msg: str) -> None:
    global fail
    fail = 1
    print(f"engine-boundary-gate: RULE {rule}: {msg}", file=sys.stderr)


def ts_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, files in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('dist', 'node_modules', 'coverage')]
        for f in files:
            if f.endswith('.ts') and not f.endswith(('.test.ts', '.spec.ts')):
                out.append(os.path.join(dirpath, f))
    return out


# Parse every import/export-from clause (static + dynamic) of one file:
#   [("import"|"export", [binding names], specifier), ...]
STMT_RE = re.compile(
    r"(?:^|\n)\s*(?:import\s+(?:type\s+)?|export\s+(?:type\s+)?\{[^}]*\}\s*from\s+)"
    r"(\{[^}]*\})?\s*(?:from\s*)?['\"]([^'\"]+)['\"]",
)
DYN_RE = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")


def clauses(text: str) -> list[tuple[str, list[str], str]]:
    out: list[tuple[str, list[str], str]] = []
    for m in re.finditer(r"(?:^|\n)[ \t]*(import[^\n;]*?from[ \t]*['\"][^'\"]+['\"];?)", text):
        block = m.group(1)
        spec = re.findall(r"['\"]([^'\"]+)['\"]", block)
        if not spec:
            continue
        names: list[str] = []
        nb = re.search(r"\{([^}]*)\}", block)
        if nb:
            for entry in nb.group(1).split(','):
                entry = re.sub(r'/\*.*?\*/', '', entry, flags=re.S).strip()
                if not entry:
                    continue
                entry = re.sub(r'^type\s+', '', entry)
                mm = re.match(r'([\w$]+)(?:\s+as\s+([\w$]+))?$', entry)
                if mm:
                    # the LOCAL/exported name is the alias when present
                    names.append(mm.group(2) or mm.group(1))
        out.append(('import', names, spec[-1]))
    for m in DYN_RE.finditer(text):
        out.append(('import', [], m.group(1)))
    return out


APP_LAYER_DIRS = [
    'server/src/api', 'server/src/jobs', 'server/src/runtime',
    'server/src/sync', 'server/src/catalog', 'server/src/web',
]
TOP_LEVEL_FILES = [
    'server/src/main.ts', 'server/src/index.ts', 'server/src/runtime-entry.ts',
]
DOORS = re.compile(r'(^|/)engine/(facade|index)\.js$')
ENGINE_SUBMODULE = re.compile(r'(^|/)engine/[A-Za-z0-9_-]+/')
LUA_NAMED = re.compile(r'^(Lua|Wasmoon)[A-Za-z0-9_]*$')
# Inside engine/: relative imports may only escape for the designed D4 edge.
D4_EDGE = ('server/src/engine/shims/install.ts', 'tools/import/fmd2-crypto.js')
APP_LAYER_NAMES = ('api', 'jobs', 'runtime', 'sync', 'catalog', 'accounts',
                   'observability', 'db', 'web', 'tools')

src_files = ts_files('server/src')

# ── RULE facade-only ────────────────────────────────────────────────────────
rule1_scope = set(TOP_LEVEL_FILES)
for d in APP_LAYER_DIRS:
    if os.path.isdir(d):
        for p in ts_files(d):
            rule1_scope.add(p)

for path in sorted(rule1_scope):
    text = open(path, encoding='utf-8').read()
    for _kind, _names, spec in clauses(text):
        if 'engine/' in spec and not DOORS.search(spec):
            err('facade-only', f'{path}: deep engine import {spec!r} '
                               f'(app layers reach the engine ONLY via engine/facade.js or engine/index.js)')

# ── RULE no-lua-outside ─────────────────────────────────────────────────────
for path in sorted(src_files):
    if path.startswith('server/src/engine/'):
        continue
    text = open(path, encoding='utf-8').read()
    for _kind, names, spec in clauses(text):
        if spec == 'wasmoon' or spec.startswith('wasmoon/'):
            err('no-lua-outside', f'{path}: wasmoon import outside engine')
        if 'engine/' in spec and not DOORS.search(spec):
            err('no-lua-outside', f'{path}: deep engine-submodule import {spec!r} outside engine')
        for n in names:
            if LUA_NAMED.match(n):
                err('no-lua-outside', f'{path}: Lua-named imported binding {n!r} '
                                      f'(mechanism types stay inside engine; use the facade domain alias)')

# ── RULE engine-inward ──────────────────────────────────────────────────────
for path in sorted(p for p in src_files if p.startswith('server/src/engine/')):
    text = open(path, encoding='utf-8').read()
    for _kind, _names, spec in clauses(text):
        if not (spec.startswith('./') or spec.startswith('../')):
            if spec == '@fmd/server':
                err('engine-inward', f'{path}: engine imports the server package ({spec})')
            continue
        # Resolve the relative specifier against the file's directory.
        target = os.path.normpath(os.path.join(os.path.dirname(path), spec)).replace(os.sep, '/')
        if target.startswith('server/src/engine/'):
            continue
        rel = target.replace('server/src/', '', 1) if target.startswith('server/src/') else target
        top = rel.split('/')[0] if '/' in rel else rel
        if (path, rel) == D4_EDGE:
            continue  # designed D4 exception (key-isolation test owns it)
        if top in APP_LAYER_NAMES:
            err('engine-inward', f'{path}: engine imports app layer {spec!r} -> {target} '
                                 f'(dependencies point inward: engine -> contract + engine internals + node builtins)')

# ── RULE facade-hygiene ─────────────────────────────────────────────────────
facade = 'server/src/engine/facade.ts'
text = open(facade, encoding='utf-8').read()
for _kind, names, spec in clauses(text):
    if spec == 'wasmoon' or spec.startswith('wasmoon/'):
        err('facade-hygiene', 'facade.ts imports wasmoon (the facade must stay wasmoon-free '
                              'so the stub-substrate boot never evaluates it)')
exported: set[str] = set()
for m in re.finditer(r'export\s+(?:type\s+)?(?:interface|class|const|let|var|function)\s+([\w$]+)', text):
    exported.add(m.group(1))
for m in re.finditer(r'export\s+(?:type\s+)?\{([^}]*)\}', text):
    for entry in m.group(1).split(','):
        entry = re.sub(r'/\*.*?\*/', '', entry, flags=re.S).strip()
        if not entry:
            continue
        mm = re.match(r'[\w$]+(?:\s+as\s+([\w$]+))?$', entry)
        if mm:
            exported.add(mm.group(1) or entry.split()[0])
for name in sorted(exported):
    if LUA_NAMED.match(name):
        err('facade-hygiene', f'facade.ts exports Lua-mechanism name {name!r} '
                              f'(the public surface is domain-shaped; alias it)')

sys.exit(1 if fail else 0)
PY
