import type { HostLogger, ModuleId } from '@fmd/contract';
import { LuaMultiReturn } from 'wasmoon';

/**
 * fmd.pcre2 shim (DESIGN.md §5.7, `LuaPCRE2.pas`): API-faithful facade of
 * TLuaPCRE2Engine + the five exported functions (`exec`, `find`, `match`,
 * `gmatch`, `gsub` — LuaPCRE2.pas:237-245), compiled with PCRE2_UTF
 * semantics (LuaPCRE2.pas:83 — PCRE2_UTF is always on, no other options).
 *
 * Backend: the host V8 RegExp engine (offline target — RE2 native and
 * pcre2-wasm are not vendorable in this repo; see COMPAT.md "fmd.pcre2
 * compatibility notes" for the full expressibility ledger). PCRE2_UTF
 * without PCRE2_UCP keeps `\w \d \s` ASCII; JS RegExp keeps them ASCII in
 * BOTH modes, so the no-`u` path is faithful and `u` is enabled only when
 * the pattern needs it (named groups, `\p{...}`, `\k<name>`, `\x{...}`).
 * A class-aware translation layer carries the PCRE2-only constructs V8
 * can express (`\A \z \Z \h \H \v \V \N \R \a \e \cX \x{...} \o{...}`,
 * `\Q..\E`, PCRE2-vs-JS `$` semantics, `(?P<name>)`/`(?P=name)` aliases,
 * atomic-group + possessive downgrades, `(?#...)` comments, hoisted
 * `(?ims)` flags); everything V8 cannot express throws a loud
 * Pcre2TranslateError that takes the exact Pascal compile-failure path
 * (log + nil), never a silent stub.
 *
 * Per-call parity (LuaPCRE2.pas): the engine (compile + match data)
 * lives for ONE call — exec/find/match/gsub compile per call; gmatch
 * compiles once and its closure reuses it (TLuaPCRE2Engine.ExecNext).
 * Offsets: the Lua 1-based start offset arrives as `arg - 1` (:74-81,
 * including the gsub 4-argument form reading Lua arg 4); `find` returns
 * `(start+1, end)` 1-based (:110-128); `match` returns the whole match
 * when the pattern has no capture groups, else the groups only with
 * unset groups as '' (the PCRE2_UNSET Cardinal wrap in the ovector
 * helpers, pcre2.pas:290-298); `gmatch` continues at the match end
 * (ExecNext :59-66 — a zero-width match re-tries the same offset, so
 * non-advancing patterns loop forever, FMD2-identical); `gsub` (re_gsub
 * :200-235) substitutes globally from the start offset with PCRE2
 * $-expansion ($$, $0-$99, ${name}; unset → ''). Compile failure logs
 * (Logger.Send, :86) and degrades per-method exactly as the Pascal
 * pushes nothing/false: exec → false, find/match → no values, gmatch →
 * the nil iterator (:174-177), gsub → the subject unchanged.
 */

export interface Pcre2ShimOptions {
  readonly logger?: HostLogger | null;
  readonly moduleId?: ModuleId;
}

/** Loud translation gap — surfaces as the Pascal compile-failure paths. */
export class Pcre2TranslateError extends Error {}

const HSPACE = '\\t\\x20\\xA0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000';
const VSPACE = '\\n\\x0B\\x0C\\r\\x85\\u2028\\u2029';
const NEWLINE_SEQ = `(?:\\r\\n|[${VSPACE}])`;
const JS_META = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
/** PCRE2 inline-flag letters the facade can hoist to JS compile flags. */
const HOISTABLE_FLAGS = new Set(['i', 'm', 's']);
const FLAG_GROUP_CHARS = /^[a-zA-Z^:-]$/;

function throwTranslate(message: string): never {
  throw new Pcre2TranslateError(`PCRE2: ${message}`);
}

function escapeLiteralChar(c: string, insideClass: boolean): string {
  // \Q..\E quoting: escape every JS metachar; `-` only matters inside a
  // class (the range operator) and would be an illegal identity escape
  // under the u flag outside one.
  if (JS_META.has(c) || (insideClass && c === '-')) {
    return `\\${c}`;
  }
  return c;
}

interface Translation {
  readonly jsPattern: string;
  /** Hoisted top-level (?ims) groups → JS compile flags ('', 'i', …). */
  readonly flags: string;
  /** Pattern uses JS-`u`-only constructs (named groups, \p{}, \u{…}). */
  readonly needsUnicode: boolean;
}

interface EscapeOutcome {
  readonly text: string;
  /** Source chars consumed (multi-char escapes: \x{..}, \cX, …). */
  readonly consumed: number;
}

/**
 * PCRE2 → JS pattern translation: one class-aware scan rewriting the
 * PCRE2-only constructs to their JS equivalents and collecting the
 * hoistable flags / u-flag need. Throws Pcre2TranslateError for the
 * documented unexpressible set.
 */
export function translatePattern(pattern: string): Translation {
  let out = '';
  let flags = '';
  let needsUnicode = false;
  let i = 0;
  let inClass = false;

  while (i < pattern.length) {
    const c = pattern[i] as string;

    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (n === '') throwTranslate('pattern ends with a trailing backslash');
      if (n === 'Q') {
        // quoted span: literal until \E (a dangling \Q quotes to the end)
        const end = pattern.indexOf('\\E', i + 2);
        const content = end === -1 ? pattern.slice(i + 2) : pattern.slice(i + 2, end);
        out += [...content].map((ch) => escapeLiteralChar(ch, inClass)).join('');
        i = end === -1 ? pattern.length : end + 3;
        continue;
      }
      if (!inClass && (n === 'p' || n === 'P')) needsUnicode = true;
      if (n === 'x' && pattern[i + 2] === '{') needsUnicode = true; // \x{...} → \u{...}
      if (n === 'o' && pattern[i + 2] === '{') needsUnicode = true; // \o{...} → \u{...}
      if (n === 'k' && pattern[i + 2] === '<') needsUnicode = true; // \k<name> backref
      const e = translateEscape(pattern, i, inClass);
      out += e.text;
      i += e.consumed;
      continue;
    }

    if (!inClass && c === '[') {
      inClass = true;
      out += c;
      i += 1;
      // both engines treat []... as a class whose first member is ]
      if (pattern[i] === ']') {
        out += ']';
        i += 1;
      }
      continue;
    }
    if (inClass && c === ']') {
      inClass = false;
      out += c;
      i += 1;
      continue;
    }
    if (inClass) {
      // character classes carry almost everything literally; the only
      // u-flag-legal rewrites are the \h/\v family handled above
      if (c === '\\') {
        const n = pattern[i + 1] ?? '';
        if (n === 'k' && pattern[i + 2] === '<') needsUnicode = true;
      }
      out += c;
      i += 1;
      continue;
    }

    if (c === '(') {
      const g = translateGroupHead(pattern, i);
      out += g.text;
      i += g.consumed;
      if (g.hoistedFlags !== undefined) flags += g.hoistedFlags;
      continue;
    }

    if (c === '$') {
      // PCRE2 default $ = end of subject or before a final newline (no
      // DOLLAR_ENDONLY); JS $ = true end. (?=\n?$) is the exact anchor.
      out += '(?=\\n?$)';
      i += 1;
      continue;
    }

    // quantifier possessiveness: *+ ++ ?+ {n,m}+ — V8 cannot express
    // possessive quantifiers; downgrade to greedy (COMPAT.md row)
    if ((c === '*' || c === '+' || c === '?') && pattern[i + 1] === '+') {
      out += c;
      i += 2;
      continue;
    }
    if (c === '{') {
      const q = /^\{(\d+)(,(\d*))?\}(\+?)/.exec(pattern.slice(i));
      if (q !== null) {
        out += q[0].endsWith('+') ? q[0].slice(0, -1) : q[0];
        i += q[0].length;
        continue;
      }
    }

    out += c;
    i += 1;
  }
  return { jsPattern: out, flags, needsUnicode };
}

/** One escape sequence starting at pattern[i] (the backslash). */
function translateEscape(pattern: string, i: number, inClass: boolean): EscapeOutcome {
  const n = pattern[i + 1] ?? '';
  const findClose = (): number => {
    const close = pattern.indexOf('}', i + 3);
    if (close === -1) throwTranslate(`\\${n}{ without a closing brace`);
    return close;
  };
  switch (n) {
    case 'a': return { text: '\\x07', consumed: 2 };
    case 'e': return { text: '\\x1B', consumed: 2 };
    case 'h': return { text: inClass ? HSPACE : `[${HSPACE}]`, consumed: 2 };
    case 'H': return { text: `[^${HSPACE}]`, consumed: 2 };
    case 'v': return { text: inClass ? VSPACE : `[${VSPACE}]`, consumed: 2 };
    case 'V': return { text: `[^${VSPACE}]`, consumed: 2 };
    case 'N': return { text: '.', consumed: 2 };
    case 'R':
      if (inClass) throwTranslate('\\R inside a character class');
      return { text: NEWLINE_SEQ, consumed: 2 };
    case 'A': return { text: '^', consumed: 2 };
    case 'z': return { text: '$', consumed: 2 };
    case 'Z': return { text: '(?=\\n?$)', consumed: 2 };
    case 'K': return throwTranslate('\\K (match-start reset) is not expressible on the facade backend (COMPAT.md)');
    case 'C': return throwTranslate('\\C is not expressible on the facade backend (COMPAT.md)');
    case 'X': return throwTranslate('\\X (grapheme cluster) is not expressible on the facade backend (COMPAT.md)');
    case 'G': return throwTranslate('\\G is not expressible on the facade backend (COMPAT.md)');
    case 'c': {
      const x = (pattern[i + 2] ?? '').toUpperCase();
      if (x === '') throwTranslate('\\c at end of pattern');
      return { text: `\\x${(x.charCodeAt(0) & 0x1f).toString(16).padStart(2, '0')}`, consumed: 3 };
    }
    case 'x': {
      if (pattern[i + 2] !== '{') return { text: '\\x', consumed: 2 };
      const close = findClose();
      const hex = pattern.slice(i + 3, close);
      if (!/^[0-9a-fA-F]+$/.test(hex)) throwTranslate(`\\x{${hex}} is not valid hexadecimal`);
      return { text: `\\u{${hex}}`, consumed: close + 1 - i };
    }
    case 'o': {
      if (pattern[i + 2] !== '{') throwTranslate('\\o requires {octal}');
      const close = findClose();
      const oct = pattern.slice(i + 3, close);
      if (!/^[0-7]+$/.test(oct)) throwTranslate(`\\o{${oct}} is not valid octal`);
      return { text: `\\u{${Number.parseInt(oct, 8).toString(16)}}`, consumed: close + 1 - i };
    }
    case 'g': {
      if (pattern[i + 2] === '{') {
        const close = pattern.indexOf('}', i + 3);
        if (close === -1) throwTranslate('\\g{ without a closing brace');
        const inner = pattern.slice(i + 3, close);
        if (/^\d+$/.test(inner)) return { text: `\\${Number.parseInt(inner, 10)}`, consumed: close + 1 - i };
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
          return { text: `\\k<${inner}>`, consumed: close + 1 - i };
        }
        throwTranslate(`\\g{${inner}} is not a supported backreference`);
      }
      if (/\d/.test(pattern[i + 2] ?? '')) {
        return { text: `\\${pattern[i + 2]}`, consumed: 3 };
      }
      return throwTranslate('\\g requires a group number or {name}');
    }
    case 'Q': return throwTranslate('unreachable: \\Q is handled by the scanner');
    // \d \D \s \S \w \W \b \B \1-\9 \p{..} \P{..} and literal escapes pass
    // through; a JS-illegal escape fails at compile time (the Pascal
    // compile-error path)
    default: return { text: `\\${n}`, consumed: 2 };
  }
}

interface GroupHeadOutcome {
  readonly text: string;
  readonly consumed: number;
  readonly hoistedFlags?: string;
}

/** Group-head constructs at pattern[i] === '('. */
function translateGroupHead(pattern: string, start: number): GroupHeadOutcome {
  const p = pattern;
  const rest = p.slice(start);

  if (rest.startsWith('(?#')) {
    const close = p.indexOf(')', start + 3);
    if (close === -1) throwTranslate('(?# without a closing paren');
    return { text: '', consumed: close + 1 - start };
  }
  if (rest.startsWith('(*')) {
    const close = p.indexOf(')', start + 2);
    if (close === -1) throwTranslate('(* without a closing paren');
    const verb = p.slice(start + 2, close);
    // facade defaults make these no-ops: LF newline convention, UTF always on
    if (verb === 'LF' || verb === 'UTF' || verb === 'UTF8') {
      return { text: '', consumed: close + 1 - start };
    }
    throwTranslate(`(*${verb}) is not expressible on the facade backend (COMPAT.md)`);
  }
  if (rest.startsWith('(?<')) {
    const c = p[start + 3];
    if (c === '=' || c === '!') {
      return { text: p.slice(start, start + 4), consumed: 4 }; // lookbehind
    }
    const gt = p.indexOf('>', start + 3);
    if (gt === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.slice(start + 3, gt))) {
      throwTranslate(`malformed (?<...> group at offset ${start}`);
    }
    return { text: p.slice(start, gt + 1), consumed: gt + 1 - start };
  }
  if (rest.startsWith('(?P<')) {
    const gt = p.indexOf('>', start + 4);
    if (gt === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.slice(start + 4, gt))) {
      throwTranslate(`malformed (?P<...> group at offset ${start}`);
    }
    return { text: `(?<${p.slice(start + 4, gt)}>`, consumed: gt + 1 - start };
  }
  if (rest.startsWith('(?P=')) {
    const close = p.indexOf(')', start + 4);
    if (close === -1) throwTranslate('(?P= without a closing paren');
    return { text: `\\k<${p.slice(start + 4, close)}>`, consumed: close + 1 - start };
  }
  if (rest.startsWith('(?>')) {
    // atomic group — V8 has no non-backtracking groups; downgrade to
    // non-capturing (COMPAT.md row)
    return { text: '(?:', consumed: 3 };
  }
  if (rest.startsWith('(?P>')) throwTranslate('(?P>name) subroutine calls are not expressible (COMPAT.md)');
  if (rest.startsWith('(?&')) throwTranslate('(?&name) subroutine calls are not expressible (COMPAT.md)');
  if (rest.startsWith('(?|')) throwTranslate('(?|...) branch reset groups are not expressible (COMPAT.md)');
  if (rest.startsWith('(?C')) throwTranslate('(?C...) callouts are not expressible (COMPAT.md)');
  if (rest.startsWith('(?(')) throwTranslate('(?(cond)...) conditionals are not expressible (COMPAT.md)');
  if (rest.startsWith('(?R)')) throwTranslate('(?R) recursion is not expressible (COMPAT.md)');
  const ref = p[start + 2];
  if (ref !== undefined && /[0-9+-]/.test(ref)) {
    throwTranslate(`(?${ref}...) group references/recursion are not expressible (COMPAT.md)`);
  }
  // inline flags (?flags) / (?flags:...) — the (? two-char head is the
  // gate (a plain group like "(ab" must NOT enter this path); the check
  // sits after the (?< / (?P / (?> special cases above
  if (rest.startsWith('(?') && ref !== undefined && FLAG_GROUP_CHARS.test(ref)) {
    let j = start + 2;
    let flags = '';
    let negated = false;
    while (j < p.length && FLAG_GROUP_CHARS.test(p[j] as string)) {
      const ch = p[j] as string;
      if (ch === '-' || ch === '^') {
        negated = true;
        j += 1;
        continue;
      }
      if (negated) {
        throwTranslate(`inline flag negation (?-${ch}) is not expressible (COMPAT.md)`);
      }
      if (!HOISTABLE_FLAGS.has(ch)) {
        throwTranslate(`inline flag (?${ch}) is not expressible (COMPAT.md)`);
      }
      flags += ch;
      j += 1;
    }
    if (p[j] === ':') throwTranslate('scoped inline flags (?flags:...) are not expressible (COMPAT.md)');
    if (p[j] === ')') {
      // top-level flag set → hoisted to compile flags (the
      // applies-from-here semantics degrade to whole-pattern — COMPAT.md)
      return { text: '', consumed: j + 1 - start, hoistedFlags: flags };
    }
    throwTranslate(`malformed inline flag group at offset ${start}`);
  }
  // (, (?:, (?=, (?! pass through (3 chars when the (? two-char head is
  // complete, else the bare paren)
  if (rest.startsWith('(?:')) return { text: '(?:', consumed: 3 };
  if (rest.startsWith('(?=') || rest.startsWith('(?!')) return { text: rest.slice(0, 3), consumed: 3 };
  return { text: '(', consumed: 1 };
}

/** Compiled outcome: null + message takes the Pascal compile-failure path. */
export interface CompileOutcome {
  readonly reg: RegExp | null;
  readonly errorMessage: string;
}

/** Translate + compile (flags: `g`, plus `u` and hoisted (?ims) when present). */
export function compilePcre2(pattern: string): CompileOutcome {
  let t: Translation;
  try {
    t = translatePattern(pattern);
  } catch (err: unknown) {
    if (err instanceof Pcre2TranslateError) {
      return { reg: null, errorMessage: err.message };
    }
    throw err;
  }
  const flagSet = `g${t.needsUnicode ? 'u' : ''}${t.flags}`;
  try {
    return { reg: new RegExp(t.jsPattern, flagSet), errorMessage: '' };
  } catch (err: unknown) {
    return { reg: null, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

/** JS-visible index → UTF-8 byte offset (Lua string positions are bytes). */
export function utf8ByteOffset(subject: string, jsIndex: number): number {
  let bytes = 0;
  let i = 0;
  while (i < jsIndex && i < subject.length) {
    const cp = subject.codePointAt(i) as number;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return bytes;
}

interface Pcre2Host {
  readonly logger: HostLogger | null;
  readonly moduleId: ModuleId;
}

function logCompileError(host: Pcre2Host, message: string): void {
  // LuaPCRE2.pas:86 — Logger.Send(pcre2.GetErrorMessage(...)) on failure
  host.logger?.write({
    level: 'log',
    moduleId: host.moduleId,
    message: `PCRE2 compile error: ${message}`,
  });
}

interface MatchState {
  readonly reg: RegExp;
  readonly subject: string;
  /** JS-visible index of the next search start (global exec semantics). */
  lastIndex: number;
}

/** pcre2_match from startoffset: first match starting at/after the offset. */
function execFrom(state: MatchState): RegExpExecArray | null {
  state.reg.lastIndex = state.lastIndex;
  const m = state.reg.exec(state.subject);
  if (m !== null) {
    // Pascal ExecNext: continue at the match end — a zero-width match
    // re-tries the same offset (non-advancing patterns loop forever)
    state.lastIndex = m.index + m[0].length;
  }
  return m;
}

/** LuaPCRE2.pas:74-81 offset extraction (arg3 number, else the gsub arg4). */
function startOffsetArg(args: unknown[]): number {
  const third = args[2];
  if (typeof third === 'number') return Math.max(0, Math.trunc(third) - 1);
  const fourth = args[3];
  if (typeof fourth === 'number') return Math.max(0, Math.trunc(fourth) - 1);
  return 0;
}

function stateOf(
  host: Pcre2Host,
  subject: string,
  pattern: string,
  offset: number,
): MatchState | null {
  const compiled = compilePcre2(pattern);
  if (compiled.reg === null) {
    logCompileError(host, compiled.errorMessage);
    return null;
  }
  return { reg: compiled.reg, subject, lastIndex: Math.min(offset, subject.length) };
}

/** LuaPCRE2.pas re_exec — boolean. */
function pcre2Exec(host: Pcre2Host, args: unknown[]): boolean {
  const state = stateOf(host, String(args[0] ?? ''), String(args[1] ?? ''), startOffsetArg(args));
  if (state === null) return false;
  return execFrom(state) !== null;
}

/** LuaPCRE2.pas re_find — (start+1, end) 1-based byte positions, or nothing. */
function pcre2Find(host: Pcre2Host, args: unknown[]): LuaMultiReturn {
  const subject = String(args[0] ?? '');
  const state = stateOf(host, subject, String(args[1] ?? ''), startOffsetArg(args));
  if (state === null) return LuaMultiReturn.from([]);
  const m = execFrom(state);
  if (m === null) return LuaMultiReturn.from([]);
  return LuaMultiReturn.from([
    utf8ByteOffset(subject, m.index) + 1,
    utf8ByteOffset(subject, m.index + m[0].length),
  ]);
}

/** LuaPCRE2.pas internalmatch — whole match iff no capture groups, else groups. */
function matchValues(m: RegExpExecArray): string[] {
  const groups = m.length - 1;
  if (groups === 0) return [m[0]];
  // unset groups: the Pascal ovector helpers wrap PCRE2_UNSET into
  // (start 0, length 0) — an empty string, not nil (pcre2.pas:290-298)
  return Array.from({ length: groups }, (_, gi) => m[gi + 1] ?? '');
}

/** LuaPCRE2.pas re_match — match values or nothing. */
function pcre2Match(host: Pcre2Host, args: unknown[]): LuaMultiReturn {
  const state = stateOf(host, String(args[0] ?? ''), String(args[1] ?? ''), startOffsetArg(args));
  if (state === null) return LuaMultiReturn.from([]);
  const m = execFrom(state);
  if (m === null) return LuaMultiReturn.from([]);
  return LuaMultiReturn.from(matchValues(m));
}

/** LuaPCRE2.pas re_gmatch — iterator closure (internalgmatch). */
function pcre2Gmatch(
  host: Pcre2Host,
  args: unknown[],
): (state: unknown, control: unknown) => LuaMultiReturn {
  const state = stateOf(host, String(args[0] ?? ''), String(args[1] ?? ''), 0);
  if (state === null) {
    return (): LuaMultiReturn => LuaMultiReturn.from([]); // internalgmatchnil
  }
  return (): LuaMultiReturn => {
    const m = execFrom(state);
    if (m === null) return LuaMultiReturn.from([]);
    return LuaMultiReturn.from(matchValues(m));
  };
}

/**
 * PCRE2 substitute $-expansion over one match: $$ → '$', $0-$99 → group
 * (unset → ''), ${name} → named group; unknown names/sequences stay
 * literal. (pcre2_substitute semantics; JS `$\``/$' are NOT special.)
 */
function expandReplacement(replacement: string, m: RegExpExecArray): string {
  let out = '';
  let i = 0;
  while (i < replacement.length) {
    const c = replacement[i] as string;
    if (c !== '$') {
      out += c;
      i += 1;
      continue;
    }
    const n = replacement[i + 1] ?? '';
    if (n === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (n === '{') {
      const close = replacement.indexOf('}', i + 2);
      const name = close === -1 ? '' : replacement.slice(i + 2, close);
      const numeric = /^\d+$/.test(name) ? Number.parseInt(name, 10) : -1;
      const namedKnown =
        close !== -1 &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        m.groups !== undefined &&
        m.groups !== null &&
        name in m.groups;
      if (numeric >= 0 && numeric < m.length) {
        out += m[numeric] ?? '';
        i = (close as number) + 1;
        continue;
      }
      if (namedKnown) {
        out += m.groups?.[name] ?? '';
        i = (close as number) + 1;
        continue;
      }
      // unknown ${...} stays literal (PCRE2 errors — the facade keeps the
      // string; COMPAT.md row)
      out += replacement.slice(i, close === -1 ? replacement.length : close + 1);
      i = close === -1 ? replacement.length : close + 1;
      continue;
    }
    if (/\d/.test(n)) {
      let j = i + 1;
      while (j < replacement.length && /\d/.test(replacement[j] as string) && j - i <= 2) j += 1;
      const num = Number.parseInt(replacement.slice(i + 1, j), 10);
      if (num === 0) {
        out += m[0];
        i = j;
        continue;
      }
      if (num < m.length) {
        out += m[num] ?? '';
        i = j;
        continue;
      }
      // out-of-range group number: the literal digits stand
      out += replacement.slice(i, j);
      i = j;
      continue;
    }
    out += '$';
    i += 1;
  }
  return out;
}

/** LuaPCRE2.pas re_gsub — global substitute from the start offset. */
function pcre2Gsub(host: Pcre2Host, args: unknown[]): string {
  const subject = String(args[0] ?? '');
  const replacement = String(args[2] ?? '');
  const state = stateOf(host, subject, String(args[1] ?? ''), startOffsetArg(args));
  if (state === null) return subject; // Pascal pushes the original subject
  const reg = state.reg;
  reg.lastIndex = state.lastIndex;
  // pcre2_substitute copies the WHOLE subject out — the prefix before the
  // start offset passes through untouched, substitutions begin at it
  let out = '';
  let pos = 0;
  for (;;) {
    const m = reg.exec(subject);
    if (m === null) break;
    out += subject.slice(pos, m.index);
    out += expandReplacement(replacement, m);
    if (m[0].length === 0) {
      // pcre2_substitute: after an empty match the skipped character is
      // copied out and the position advances by one
      out += subject.charAt(m.index);
      pos = m.index + 1;
      if (pos > subject.length) break;
      reg.lastIndex = pos;
    } else {
      pos = m.index + m[0].length;
    }
  }
  out += subject.slice(pos);
  return out;
}

/**
 * The `require 'fmd.pcre2'` host-lib table (LuaPCRE2.pas:237-245 order).
 * Registered through the require-registry host-lib path (lua-require.ts);
 * arguments/returns are text-only (PCRE2_UTF subjects are UTF-8 text by
 * construction; byte-level subjects are a COMPAT.md-documented non-goal),
 * so the plain wasmoon marshalling is faithful.
 */
export function makePcre2Shim(options: Pcre2ShimOptions): {
  exec(...args: unknown[]): boolean;
  find(...args: unknown[]): LuaMultiReturn;
  match(...args: unknown[]): LuaMultiReturn;
  gmatch(...args: unknown[]): (state: unknown, control: unknown) => LuaMultiReturn;
  gsub(...args: unknown[]): string;
} {
  const host: Pcre2Host = { logger: options.logger ?? null, moduleId: options.moduleId ?? '' };
  return {
    exec: (...args: unknown[]): boolean => pcre2Exec(host, args),
    find: (...args: unknown[]): LuaMultiReturn => pcre2Find(host, args),
    match: (...args: unknown[]): LuaMultiReturn => pcre2Match(host, args),
    gmatch: (...args: unknown[]): ((state: unknown, control: unknown) => LuaMultiReturn) =>
      pcre2Gmatch(host, args),
    gsub: (...args: unknown[]): string => pcre2Gsub(host, args),
  };
}

/**
 * Install the `fmd.pcre2` host lib (registry row servedBy host-lib).
 * Arguments/returns are text-only (PCRE2_UTF subjects are UTF-8 text by
 * construction; byte-level subjects are a COMPAT.md-documented non-goal),
 * so the plain wasmoon marshalling is faithful.
 */
