#!/usr/bin/env python3
"""verify-tables.py — byte-for-byte verification of the replicated filter
tables in corpus/harness/fmdstrings.pas against the FMD2 originals in
FMD2/baseunits/uBaseUnit.pas.

The original tables carry literal UTF-8 chars; the replica renders
non-ASCII as #NNN byte escapes plus ASCII literals (so it compiles
codepage-independently). Both are decoded to raw byte sequences here and
compared row by row, including row order — the filter loops are
order-sensitive, so a reordered "equal" table would still be a behavior
change.

Usage:  python3 tools/verify-tables.py  (repo-relative paths below; exit 0
= tables identical). Run as part of the review evidence for
tsk-lofty-poncho-slogs; advisory tool, not part of the build gate.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ORIG = os.path.join(HERE, '..', '..', '..', '..', 'FMD2', 'baseunits', 'uBaseUnit.pas')
REPL = os.path.join(HERE, '..', 'fmdstrings.pas')


def parse_table(path, name):
    text = open(path, encoding='utf-8').read()
    m = re.search(
        re.escape(name)
        + r"\s*:\s*array\s*\[0\.\.(\d+)\]\s*of\s*array\s*\[0\.\.1\]\s*of\s*String\s*=\s*\((.*?)\n\s*\);",
        text, re.S)
    if not m:
        sys.exit(f'table {name} not found in {path}')
    body = m.group(2)

    # quote-aware row split: rows are top-level (...) groups; quoted values
    # may themselves contain parens/commas (e.g. ('（', '('))
    rows, cur, depth, instr, i = [], '', 0, False, 0
    while i < len(body):
        c = body[i]
        if instr:
            cur += c
            if c == "'":
                if i + 1 < len(body) and body[i + 1] == "'":
                    cur += "'"
                    i += 1
                else:
                    instr = False
            i += 1
            continue
        if c == "'":
            instr = True
            cur += c
            i += 1
            continue
        if c == '(':
            depth += 1
            if depth == 1:
                cur = ''
                i += 1
                continue
        if c == ')':
            depth -= 1
            if depth == 0:
                rows.append(cur)
                cur = ''
                i += 1
                continue
        if depth >= 1:
            cur += c
        i += 1

    def dec(seg):
        out, k = bytearray(), 0
        while k < len(seg):
            if seg[k] == "'":
                mm = re.match(r"'((?:[^']|'')*)'", seg[k:], re.S)
                out += mm.group(1).replace("''", "'").encode('utf-8')
                k += mm.end()
            elif seg[k] == '#':
                mm = re.match(r'#(\d+)', seg[k:])
                out.append(int(mm.group(1)) & 0xFF)
                k += mm.end()
            else:
                k += 1
        return bytes(out)

    parsed = []
    for r in rows:
        segs, this, instr2, j = [], '', False, 0
        while j < len(r):
            c = r[j]
            if instr2:
                this += c
                if c == "'":
                    if j + 1 < len(r) and r[j + 1] == "'":
                        this += "'"
                        j += 1
                    else:
                        instr2 = False
                j += 1
                continue
            if c == "'":
                instr2 = True
                this += c
                j += 1
                continue
            if c == ',':
                segs.append(this)
                this = ''
                j += 1
                continue
            this += c
            j += 1
        segs.append(this)
        parsed.append([dec(s) for s in segs])
    return int(m.group(1)) + 1, parsed


def main():
    if not os.path.exists(ORIG):
        sys.exit(f'FMD2 checkout not found at {ORIG}')
    fail = 0
    for name in ('StringFilterChar', 'HTMLEntitiesChar'):
        o_decl, o_rows = parse_table(ORIG, name)
        r_decl, r_rows = parse_table(REPL, name)
        ok = True
        if len(o_rows) != o_decl:
            print(f'{name}: original declares {o_decl}, parsed {len(o_rows)}')
            ok = False
            fail += 1
        if len(r_rows) != r_decl:
            print(f'{name}: replica declares {r_decl}, parsed {len(r_rows)}')
            ok = False
            fail += 1
        if o_rows != r_rows:
            ok = False
            fail += 1
            for idx, (a, b) in enumerate(zip(o_rows, r_rows)):
                if a != b:
                    print(f'  {name}[{idx}]: orig={a!r} repl={b!r}')
        print(f'{name}: {len(o_rows)} rows vs {len(r_rows)} rows -> '
              f"{'IDENTICAL (byte-for-byte, in order)' if ok else 'MISMATCH'}")
    print('RESULT:', 'PASS' if fail == 0 else f'FAIL ({fail})')
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
