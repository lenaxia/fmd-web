import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  QueryLanguage,
  QueryOutputMode,
} from '@fmd/contract';

/**
 * Corpus harvester (DESIGN.md §13.1) — static extraction of TXQuery
 * expression literals from FMD2's Lua ecosystem.
 *
 * FMD2's Lua side reaches the query engine through exactly six methods
 * (baseunits/lua/LuaXQuery.pas:194-199): `XPath`, `XPathString`,
 * `XPathStringAll`, `XPathHREFAll`, `XPathHREFTitleAll`, `XPathCount`.
 * This harvester lexes Lua source into code / string / comment regions,
 * finds those call sites, and decodes their first string argument —
 * robust to quoting: `'…'`, `"…"`, `[[…]]`, `[=[…]=]`, escape sequences,
 * and `..` concatenation (static when all parts are literals, marked
 * dynamic — with `{…}` placeholders — otherwise).
 */

/** The registered TXQuery method surface (LuaXQuery.pas:194-199). */
export const QUERY_METHODS: readonly string[] = [
  'XPath',
  'XPathString',
  'XPathStringAll',
  'XPathHREFAll',
  'XPathHREFTitleAll',
  'XPathCount',
];

/** One harvested expression call site. */
export interface HarvestedExpression {
  /** `<module?>#<line>#<occurrence-on-line>` — stable for a given tree. */
  readonly id: string;
  /** TXQuery method the Lua side called. */
  readonly method: string;
  /** Dialect: json()/css() forms are tagged, everything else is xpath. */
  readonly language: QueryLanguage;
  /** Consumer shape derived from the method. */
  readonly output: QueryOutputMode;
  /**
   * Decoded expression text. Fully-literal arguments concatenate their
   * parts; dynamic arguments keep their literal fragments joined with
   * `{…}` placeholders where non-literal operands sit.
   */
  readonly expression: string;
  /** True when the argument was built with `..` around non-literals. */
  readonly dynamic: boolean;
  /** 1-based source line of the call. */
  readonly line: number;
}

/** One harvested file (module or template). */
export interface HarvestedModule {
  /** File stem — the FMD2 module/template name. */
  readonly module: string;
  /** Path as harvested. */
  readonly file: string;
  readonly expressions: HarvestedExpression[];
}

interface StringSpan {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const PLACEHOLDER = '{…}';

/**
 * Lex Lua source: returns the string literals with decoded values plus a
 * copy of the source where every string body and comment is masked with
 * spaces (offsets preserved), so call-site scanning only sees code.
 */
function lexLua(source: string): { masked: string; strings: StringSpan[] } {
  const out: string[] = [];
  const strings: StringSpan[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] as string;
    // Line comment.
    if (ch === '-' && source[i + 1] === '-') {
      // Long-bracket block comment? --[[ … ]] / --[==[ … ]==]
      const lb = matchLongBracketOpen(source, i + 2);
      if (lb !== null) {
        const close = findLongBracketClose(source, lb.end, lb.level);
        const closeEnd =
          close === -1 ? n : close + longBracketNeedleLength(lb.level);
        for (let k = i; k < closeEnd; k++) out.push(' ');
        i = closeEnd;
        continue;
      }
      for (let k = i; k < n && source[k] !== '\n'; k++) out.push(' ');
      i = skipLineComment(source, i);
      continue;
    }
    // Long-bracket string.
    const lbOpen = matchLongBracketOpen(source, i);
    if (lbOpen !== null) {
      const close = findLongBracketClose(source, lbOpen.end, lbOpen.level);
      const bodyEnd = close === -1 ? n : close;
      const spanEnd =
        close === -1 ? n : bodyEnd + longBracketNeedleLength(lbOpen.level);
      strings.push({
        start: i,
        end: spanEnd,
        value: source.slice(lbOpen.end, bodyEnd),
      });
      for (let k = i; k < spanEnd; k++) out.push('S');
      i = spanEnd;
      continue;
    }
    // Quoted string.
    if (ch === "'" || ch === '"') {
      const { end, value } = readQuotedString(source, i);
      strings.push({ start: i, end, value });
      out.push(' ');
      for (let k = i + 1; k < end - 1; k++) out.push('S');
      out.push(' ');
      i = end;
      continue;
    }
    out.push(ch);
    i++;
  }
  return { masked: out.join(''), strings };
}

function skipLineComment(source: string, start: number): number {
  let i = start;
  while (i < source.length && source[i] !== '\n') i++;
  return i;
}

/** At `pos`, is there a `[` + `=`* + `[` opener? Returns its level/end. */
function matchLongBracketOpen(
  source: string,
  pos: number,
): { level: number; end: number } | null {
  if (source[pos] !== '[') return null;
  let j = pos + 1;
  while (source[j] === '=') j++;
  if (source[j] === '[') return { level: j - pos - 1, end: j + 1 };
  return null;
}

/** Find the matching `]` + `=`* + `]` for a long-bracket body. */
function findLongBracketClose(
  source: string,
  from: number,
  level: number,
): number {
  const needle = ']' + '='.repeat(level) + ']';
  return source.indexOf(needle, from);
}

/** Closing needle length: `]` + `=`*level + `]`. */
function longBracketNeedleLength(level: number): number {
  return level + 2;
}

/** Read a `'…'` / `"…"` string starting at `start`; decodes escapes. */
function readQuotedString(
  source: string,
  start: number,
): { end: number; value: string } {
  const quote = source[start];
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const decoded = readEscape(source, i + 1);
      value += decoded.value;
      i = decoded.end;
      continue;
    }
    if (ch === quote) return { end: i + 1, value };
    // A raw newline cannot appear inside a quoted Lua string.
    if (ch === '\n') return { end: i + 1, value };
    value += ch;
    i++;
  }
  return { end: i, value };
}

/** Decode one Lua escape sequence after the backslash. */
function readEscape(
  source: string,
  pos: number,
): { end: number; value: string } {
  const ch = source[pos];
  switch (ch) {
    case 'a': return { end: pos + 1, value: '\x07' };
    case 'b': return { end: pos + 1, value: '\b' };
    case 'f': return { end: pos + 1, value: '\f' };
    case 'n': return { end: pos + 1, value: '\n' };
    case 'r': return { end: pos + 1, value: '\r' };
    case 't': return { end: pos + 1, value: '\t' };
    case 'v': return { end: pos + 1, value: '\v' };
    case '\\': return { end: pos + 1, value: '\\' };
    case '"': return { end: pos + 1, value: '"' };
    case "'": return { end: pos + 1, value: "'" };
    case '\n': return { end: pos + 1, value: '\n' };
    case 'z': {
      // \z skips following whitespace.
      let j = pos + 1;
      while (j < source.length && /\s/.test(source[j] as string)) j++;
      return { end: j, value: '' };
    }
    case 'x': {
      const m = /^[0-9a-fA-F]{2}/.exec(source.slice(pos + 1));
      if (m === null) return { end: pos + 1, value: 'x' };
      return {
        end: pos + 3,
        value: String.fromCodePoint(Number.parseInt(m[0], 16)),
      };
    }
    default: {
      if (ch === undefined) return { end: pos, value: '' };
      // \ddd decimal escape (1-3 digits).
      const m = /^[0-9]{1,3}/.exec(source.slice(pos));
      if (m !== null) {
        return {
          end: pos + m[0].length,
          value: String.fromCodePoint(Number.parseInt(m[0], 10)),
        };
      }
      // \u{XXX} (Lua 5.3+).
      const u = /^u\{([0-9a-fA-F]+)\}/.exec(source.slice(pos));
      if (u !== null && u[1] !== undefined) {
        return {
          end: pos + u[0].length,
          value: String.fromCodePoint(Number.parseInt(u[1], 16)),
        };
      }
      return { end: pos + 1, value: ch };
    }
  }
}

interface CallSite {
  readonly method: string;
  /** Offset of the `(` in the masked source. */
  readonly paren: number;
  readonly line: number;
}

const METHOD_RE = new RegExp(
  `\\.(${QUERY_METHODS.join('|')})\\s*\\(`,
  'g',
);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Find TXQuery call sites in code (masked source — strings are opaque). */
function findCallSites(masked: string): CallSite[] {
  const sites: CallSite[] = [];
  METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METHOD_RE.exec(masked)) !== null) {
    sites.push({
      method: m[1] as string,
      paren: m.index + m[0].length - 1,
      line: lineAt(masked, m.index),
    });
  }
  return sites;
}

/**
 * Span of the first argument of a call whose `(` sits at `paren`:
 * walk with paren depth; strings are already masked so parens inside
 * expressions never confuse depth. Returns the [start, end) code span.
 */
function firstArgSpan(masked: string, paren: number): [number, number] | null {
  let depth = 0;
  let start = -1;
  for (let i = paren; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') {
      depth++;
      if (depth === 1) start = i + 1;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return [start, i];
      continue;
    }
    if (depth === 1 && (ch === ',' )) {
      // Top-level comma ends argument 1 — but not inside brackets that
      // belong to the expression text itself (masked strings keep [] out
      // of depth; literal `[`/`]` are not parens, so depth still guards).
      return [start, i];
    }
  }
  return null;
}

/** Classify the dialect of a decoded expression (§13.1 coverage list). */
export function classifyLanguage(expression: string): QueryLanguage {
  if (/\bjson\s*\(/.test(expression) || /^json\b/.test(expression.trimStart())) {
    return 'json';
  }
  if (/\bcss\s*\(/.test(expression)) return 'css';
  if (/\b(parse-json|xquery)\b/.test(expression)) return 'xquery';
  return 'xpath';
}

function outputForMethod(method: string): QueryOutputMode {
  switch (method) {
    case 'XPathString': return 'scalar';
    case 'XPathStringAll':
    case 'XPathHREFAll':
    case 'XPathHREFTitleAll': return 'list';
    case 'XPathCount': return 'count';
    default: return 'all';
  }
}

/**
 * Harvest one Lua source string. `moduleId` prefixes harvested ids
 * (`<module>#<line>#<n>`); omit for anonymous sources.
 */
export function harvestLuaSource(
  source: string,
  moduleId?: string,
): HarvestedExpression[] {
  const { masked, strings } = lexLua(source);
  const prefix = moduleId === undefined ? '' : `${moduleId}#`;
  const perLine = new Map<number, number>();
  const results: HarvestedExpression[] = [];
  for (const site of findCallSites(masked)) {
    const span = firstArgSpan(masked, site.paren);
    if (span === null) continue;
    const [argStart, argEnd] = span;
    // String literals inside the argument span, in source order.
    const parts = strings.filter(
      (s) => s.start >= argStart && s.end <= argEnd,
    );
    if (parts.length === 0) continue;
    // Anything besides literals, `..`, and whitespace ⇒ dynamic.
    let dynamic = false;
    let cursor = argStart;
    for (const part of parts) {
      const gap = masked.slice(cursor, part.start);
      if (/[^\s.]/.test(gap.replace(/\.\./g, ''))) dynamic = true;
      cursor = part.end;
    }
    const tail = masked.slice(cursor, argEnd);
    if (/[^\s.]/.test(tail.replace(/\.\./g, ''))) dynamic = true;
    const expression = dynamic
      ? parts.map((p) => p.value).join(PLACEHOLDER)
      : parts.map((p) => p.value).join('');
    const occ = (perLine.get(site.line) ?? 0) + 1;
    perLine.set(site.line, occ);
    results.push({
      id: `${prefix}${site.line}#${occ}`,
      method: site.method,
      language: classifyLanguage(expression),
      output: outputForMethod(site.method),
      expression,
      dynamic,
      line: site.line,
    });
  }
  return results;
}

/** Harvest one .lua file. */
export function harvestLuaFile(path: string): HarvestedModule {
  const source = readFileSync(path, 'utf8');
  const module = basename(path, '.lua');
  return {
    module,
    file: path,
    expressions: harvestLuaSource(source, module),
  };
}

/** Harvest every `*.lua` file under `dir` (non-recursive), sorted by name. */
export function harvestTree(dir: string): HarvestedModule[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith('.lua')).sort();
  return entries.map((f) => harvestLuaFile(join(dir, f)));
}

/** Harvest the module + template halves of an FMD2 `lua/` tree. */
export function harvestFmd2Tree(
  luaDir: string,
): { modules: HarvestedModule[]; templates: HarvestedModule[] } {
  return {
    modules: harvestTree(join(luaDir, 'modules')),
    templates: harvestTree(join(luaDir, 'templates')),
  };
}

/** Count helper for reports/tests. */
export function countExpressions(mods: readonly HarvestedModule[]): number {
  return mods.reduce((sum, m) => sum + m.expressions.length, 0);
}
