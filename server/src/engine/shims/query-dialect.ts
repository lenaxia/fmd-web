/**
 * InternetTools query-dialect transform (DESIGN.md §5.6, §13.1).
 *
 * FMD2's TXQuery surface speaks the InternetTools XQuery dialect on top of
 * plain XPath 3.1: `json(...)`/`parse-json(...)` node-tree constructors,
 * `.name` relative-step shorthand (the dot IS the step separator),
 * `name()` array-item steps, `?name`/`?*` map lookups and `css("sel")`.
 *
 * The live engine is FontoXPath over linkedom; this module rewrites the
 * dialect subset the corpus seeds use into XPath 3.1 — quoted literals are
 * never touched. The transform is pure and unit-tested against the seed
 * expression set.
 */

/**
 * Rewrite one expression from the InternetTools dialect to XPath 3.1.
 * Outside quoted literals:
 * - `json(` / `parse-json(` → the registered `fmd:json` / `fmd:parse-json`
 * - `css(` → the registered `fmd:css`
 * - `not(` → `fmd:not` (JSONiq effective boolean value over the JSON
 *   node tree; identical semantics for plain nodes/atomics)
 * - `string(` / `string-join(` → `fmd:string` / `fmd:string-join` (FMD2
 *   node→string trim, xquery.pas:5291 XQGlobalTrimNodes)
 * - `name()` right after a step (empty parens) → `name/*` (array items)
 * - `?name` / `?*` → `/name` / `/*` (map lookups over the node tree)
 * - `.name` → `/name` (relative child step; the dot is the separator —
 *   at expression start it is a relative step with no leading `/`)
 * - `fmd:json(...)` immediately followed by `()` → `fmd:json(...)/*`
 *
 * Quoted literals additionally get InternetTools' XQuery parser line-ending
 * normalization (xquery.pas:8384 LineEndingNormalization := xqlenXML1):
 * CRLF/CR → LF inside string literals.
 */
export function transformExpression(expression: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const c = expression[i] as string;
    if (quote !== null) {
      if (c === '\r') {
        // strNormalizeLineEndings: CR / CRLF fold to a single LF
        if (expression[i + 1] === '\n') {
          i += 1;
        }
        out += '\n';
      } else {
        out += c;
        if (c === quote) {
          quote = null;
        }
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    const prev = i > 0 ? (expression[i - 1] as string) : '';
    const prevIsName = /[\w-]/.test(prev);
    const prevIsColon = prev === ':';
    if (!prevIsName && !prevIsColon && (c === 'j' || c === 'p')) {
      const m = /^(parse-)?json\(/.exec(expression.slice(i));
      if (m !== null) {
        out += `fmd:${m[0].slice(0, -1)}(`;
        i += m[0].length;
        continue;
      }
    }
    if (!prevIsName && !prevIsColon && c === 'c' && expression.startsWith('css(', i)) {
      out += 'fmd:css(';
      i += 4;
      continue;
    }
    if (!prevIsName && !prevIsColon && (c === 'n' || c === 's')) {
      const m = /^(string-join|string|not)\(/.exec(expression.slice(i));
      if (m !== null) {
        out += `fmd:${m[0].slice(0, -1)}(`;
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }

  // `.name()` array-item steps (before the dot rewrite; `text()`-style node
  // tests are never preceded by `.` in the corpus).
  out = out.replace(/\.([A-Za-z_][\w.-]*)\(\)/g, '.$1/*');
  // `?name` / `?*` map lookups → child steps over the JSON node tree.
  out = out.replace(/\?([A-Za-z_][\w-]*)/g, '/$1').replace(/\?\*/g, '/*');

  // `.name` child steps — quote-aware (the dot is the separator; at
  // expression start it is a plain relative step).
  let fixed = '';
  for (let p = 0; p < out.length; p += 1) {
    const ch = out[p] as string;
    if (ch === '"' || ch === "'") {
      const end = findQuoteEnd(out, p);
      fixed += out.slice(p, end);
      p = end - 1;
      continue;
    }
    if (ch === '.' && /[A-Za-z_]/.test(out[p + 1] ?? '')) {
      const prev = fixed.trimEnd().slice(-1);
      fixed += fixed.length === 0 || prev === undefined ? (out[p + 1] as string) : `/${out[p + 1] as string}`;
      p += 1;
      continue;
    }
    fixed += ch;
  }

  // JSON boolean EBV (InternetTools semantics): over the json node tree
  // a bare `not(key)` predicate must follow the JSON VALUE, not element
  // existence (AsuraScans `[not(is_premium)]`, Tapas uses the value-form
  // `not(free=false)` which XPath already compares by text). Rewrite the
  // bare form to `not(string(key))` — false/missing → '' → not ⇒ true.
  // Applied only when the expression builds a json node tree; plain HTML
  // existence predicates are untouched. Documented in COMPAT.md.
  if (/\bjson\(|\bparse-json\(/u.test(fixed)) {
    fixed = fixed.replace(/\[not\(\s*([A-Za-z_][\w-]*)\s*\)\]/gu, '[not(string($1) = "true")]');
  }
  return expandJsonCallArrayStep(fixed);
}

function findQuoteEnd(s: string, start: number): number {
  const q = s[start] as string;
  let k = start + 1;
  while (k < s.length) {
    if (s[k] === '\\' && q === '"') {
      k += 2;
      continue;
    }
    if (s[k] === q) {
      return k + 1;
    }
    k += 1;
  }
  return s.length;
}

/** `fmd:json(X)()` → `fmd:json(X)/*` (balanced-paren aware, quote-aware). */
function expandJsonCallArrayStep(expr: string): string {
  let result = '';
  let i = 0;
  while (i < expr.length) {
    const idx = expr.indexOf('fmd:json(', i);
    if (idx === -1) {
      result += expr.slice(i);
      break;
    }
    let depth = 0;
    let k = idx + 'fmd:json('.length - 1;
    let quote: string | null = null;
    while (k < expr.length) {
      const ch = expr[k] as string;
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
        }
        k += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        k += 1;
        continue;
      }
      if (ch === '(') {
        depth += 1;
      }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
      k += 1;
    }
    result += expr.slice(i, k + 1);
    if (expr.startsWith('()', k + 1)) {
      result += '/*';
      i = k + 3;
    } else {
      i = k + 1;
    }
  }
  return result;
}
