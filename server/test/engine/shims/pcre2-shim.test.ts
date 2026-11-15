import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { compilePcre2, utf8ByteOffset } from '../../../src/engine/shims/pcre2-shim.js';
import { installRequireShim } from '../../../src/engine/shims/lua-require.js';

/**
 * fmd.pcre2 proofs (DESIGN.md §5.7, LuaPCRE2.pas). Vectors are ported
 * from the PCRE2 documentation (pcre2syntax/pcre2pattern man pages and
 * the pcre2test sample set): \h/\H, \v/\V, \N, \R, \A/\z/\Z, \Q..\E,
 * \x{...}, \o{...}, \cX, named groups + \k<name>, backreferences,
 * inline (?i) flags, the PCRE2-default `$` (before-final-newline)
 * semantics, possessive-quantifier/atomic-group downgrades, and the
 * LuaPCRE2 result conventions (find 1-based (start,end); match groups
 * only; gmatch ExecNext continuation; gsub PCRE2 $-expansion).
 */

describe('compilePcre2 — PCRE2-doc translation vectors', (): void => {
  const match = (pattern: string, subject: string): RegExpExecArray | null => {
    const { reg } = compilePcre2(pattern);
    expect(reg, `pattern "${pattern}" must compile`).not.toBeNull();
    return (reg as RegExp).exec(subject);
  };

  it('plain literals and ASCII classes (pcre2syntax basics)', (): void => {
    expect(match('cat', 'the cat sat')?.[0]).toBe('cat');
    expect(match('\\bcat\\b', 'concat')?.[0]).toBeUndefined();
    expect(match('\\d+', 'abc 123 def')?.[0]).toBe('123');
    expect(match('[a-z]+@[a-z]+\\.com', 'user@site.com')?.[0]).toBe('user@site.com');
  });

  it('\\h / \\H horizontal whitespace (pcre2syntax HSPACE set)', (): void => {
    expect(match('a\\hb', 'a\tb')?.[0]).toBe('a\tb');
    expect(match('a\\hb', 'a b')?.[0]).toBe('a b');
    expect(match('a\\hb', 'a\u00a0b')?.[0]).toBe('a\u00a0b');
    expect(match('a\\hb', 'a\nb')?.[0]).toBeUndefined();
    expect(match('a\\Hb', 'a\nb')?.[0]).toBe('a\nb');
    expect(match('a\\Hb', 'a b')?.[0]).toBeUndefined();
  });

  it('\\v / \\V vertical whitespace (pcre2syntax VSPACE set)', (): void => {
    expect(match('a\\vb', 'a\nb')?.[0]).toBe('a\nb');
    expect(match('a\\vb', 'a\rb')?.[0]).toBe('a\rb');
    expect(match('a\\vb', 'a\u2028b')?.[0]).toBe('a\u2028b');
    expect(match('a\\vb', 'a b')?.[0]).toBeUndefined();
    expect(match('a\\Vb', 'a b')?.[0]).toBe('a b');
    expect(match('a\\Vb', 'a\fb')?.[0]).toBeUndefined();
  });

  it('\\N = any character except newline (pcre2pattern)', (): void => {
    expect(match('\\N\\N', 'abc')?.[0]).toBe('ab');
    expect(match('\\N\\N', 'a\nc')?.[0]).toBeUndefined();
  });

  it('\\R any newline sequence, \\r\\n as one (pcre2syntax)', (): void => {
    expect(match('a\\Rb', 'a\nb')?.[0]).toBe('a\nb');
    expect(match('a\\Rb', 'a\r\nb')?.[0]).toBe('a\r\nb');
    expect(match('a\\Rb', 'a\u0085b')?.[0]).toBe('a\u0085b');
    expect(match('a\\Rb', 'a b')?.[0]).toBeUndefined();
  });

  it('\\A / \\z / \\Z anchors (pcre2pattern §absolute assertions)', (): void => {
    expect(match('\\Aabc\\z', 'abc')?.[0]).toBe('abc');
    expect(match('\\Aabc\\z', 'xabc')?.[0]).toBeUndefined();
    // \Z = end of subject or before a final newline; \z = end only
    expect(match('abc\\Z', 'abc\n')?.[0]).toBe('abc');
    expect(match('abc\\z', 'abc\n')?.[0]).toBeUndefined();
    expect(match('abc\\Z', 'abc\nx')?.[0]).toBeUndefined();
  });

  it('default $ matches before a final newline (PCRE2 default, no DOLLAR_ENDONLY)', (): void => {
    expect(match('abc$', 'xabc')?.[0]).toBe('abc');
    expect(match('abc$', 'abc\n')?.[0]).toBe('abc');
    expect(match('abc$', 'abc\nx')?.[0]).toBeUndefined();
  });

  it('\\Q..\\E quoting (pcre2pattern §metacharacters)', (): void => {
    expect(match('\\Q+.\\E', 'a+.b')?.[0]).toBe('+.');
    expect(match('\\Q+.*?\\E', 'x+.*?y')?.[0]).toBe('+.*?');
    expect(match('\\Qa-b\\E', 'a-b')?.[0]).toBe('a-b');
  });

  it('\\x{...} and \\o{...} code points (pcre2syntax)', (): void => {
    expect(match('\\x{263A}', 'a☺b')?.[0]).toBe('☺');
    expect(match('\\o{101}', 'A')?.[0]).toBe('A');
    expect(match('\\x41', 'A')?.[0]).toBe('A');
  });

  it('\\cX control characters (pcre2syntax)', (): void => {
    expect(match('\\cA', '\x01')?.[0]).toBe('\x01');
    expect(match('\\cZ', '\x1a')?.[0]).toBe('\x1a');
  });

  it('\\a / \\e (pcre2syntax)', (): void => {
    expect(match('\\a', '\x07')?.[0]).toBe('\x07');
    expect(match('\\e', '\x1b')?.[0]).toBe('\x1b');
  });

  it('named groups (?<name>…), Python alias (?P<name>…), \\k<name> (pcre2pattern)', (): void => {
    const m = match('(?<year>\\d{4})-(?<month>\\d{2})', '2024-05');
    expect(m?.[0]).toBe('2024-05');
    expect(m?.groups?.['year']).toBe('2024');
    expect(m?.groups?.['month']).toBe('05');
    const py = match('(?P<day>\\d\\d)\\.(?P<month>\\d\\d)', '25.12');
    expect(py?.groups?.['day']).toBe('25');
    expect(match('(?<word>\\w+) \\k<word>', 'hello hello')?.[0]).toBe('hello hello');
    expect(match('(?P<word>\\w+) (?P=word)', 'echo echo')?.[0]).toBe('echo echo');
  });

  it('numbered backreferences (pcre2pattern)', (): void => {
    expect(match('(\\w+) \\1', 'hello hello')?.[0]).toBe('hello hello');
    expect(match('(\\w+) \\1', 'hello world')?.[0]).toBeUndefined();
  });

  it('inline (?i) flags hoist to compile flags (pcre2pattern §internal options)', (): void => {
    expect(match('(?i)HELLO', 'say hello')?.[0]).toBe('hello');
    expect(match('(?im)^HELLO', 'hello')?.[0]).toBe('hello');
    expect(match('(?s)A.B', 'A\nB')?.[0]).toBe('A\nB'); // DOTALL
    expect(match('(?i)cat', 'CAT')?.[0]).toBe('CAT');
  });

  it('lookahead and lookbehind (pcre2pattern §lookaround)', (): void => {
    expect(match('foo(?=bar)', 'foobar')?.[0]).toBe('foo');
    expect(match('foo(?!bar)', 'foobaz')?.[0]).toBe('foo');
    expect(match('(?<=foo)bar', 'foobar')?.[0]).toBe('bar');
    expect(match('(?<!foo)bar', 'bazbar')?.[0]).toBe('bar');
  });

  it('alternation, groups, quantifiers (pcre2pattern grammar)', (): void => {
    expect(match('cat|dog|bird', 'he has a dog')?.[0]).toBe('dog');
    expect(match('(ab)+', 'ababab x')?.[0]).toBe('ababab');
    expect(match('a{2,3}', 'aaaa')?.[0]).toBe('aaa');
    expect(match('colou?r', 'my color')?.[0]).toBe('color');
  });

  it('possessive quantifiers downgrade to greedy (COMPAT.md-documented divergence)', (): void => {
    // PCRE2 possessive '".*+"' cannot match '""' (no backtracking); the
    // facade downgrades to greedy and CAN — the documented behavior the
    // vector pins (0/418 tree modules require fmd.pcre2)
    expect(match('".*+"', '"" x ""')?.[0]).toBe('"" x ""');
    // on 'aaab' both engines agree: possessive and greedy match 'aaa'
    expect(match('a*+', 'aaab')?.[0]).toBe('aaa');
  });

  it('atomic groups downgrade to non-capturing (COMPAT.md-documented divergence)', (): void => {
    // (?>a*)a: PCRE2 atomic consumes all 'aaa' then fails; the greedy
    // downgrade backtracks and matches — pinned documented behavior
    expect(match('(?>a*)a', 'aaa')?.[0]).toBe('aaa');
  });

  it('(* verbs): LF/UTF/UTF8 are stripped (facade defaults), others fail loud', (): void => {
    expect(match('(*LF)abc', 'abc')?.[0]).toBe('abc');
    expect(match('(*UTF)\\x{263A}', '☺')?.[0]).toBe('☺');
    const { reg } = compilePcre2('(*CR)a$b');
    expect(reg).toBeNull();
    const { reg: accept } = compilePcre2('a(*ACCEPT)b');
    expect(accept).toBeNull();
  });

  it('untranslatable constructs fail loud (never a silent stub)', (): void => {
    for (const pattern of ['a\\Kb', 'a\\Xb', '(?R)a', '(?<a>b)(?&a)', '(?C1)a', '(?(1)a|b)', '(?x)a b', 'a(?U)*']) {
      const outcome = compilePcre2(pattern);
      expect(outcome.reg, pattern).toBeNull();
    }
  });
});

describe('utf8ByteOffset — byte semantics (PCRE2_UTF subjects are bytes)', (): void => {
  it('ASCII indexes pass through', (): void => {
    expect(utf8ByteOffset('hello world', 5)).toBe(5);
  });

  it('2-byte UTF-8 chars advance byte offsets (é, ö)', (): void => {
    // 'héllo wörld': é at js index 1 → byte 1; w at js index 6 → byte 7
    expect(utf8ByteOffset('héllo wörld', 6)).toBe(7);
    expect(utf8ByteOffset('héllo wörld', 7)).toBe(8);
  });

  it('4-byte UTF-8 chars (surrogate pairs) advance by 4 bytes', (): void => {
    // 'a😀b': 😀 is 2 JS units, 4 UTF-8 bytes
    expect(utf8ByteOffset('a😀b', 3)).toBe(5);
  });
});

describe("require 'fmd.pcre2' — LuaPCRE2.pas result conventions (wasmoon end-to-end)", (): void => {
  const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-pcre2-shim-'));
  const logger = createMemoryLogger();
  let engine: LuaEngine;

  beforeAll(async (): Promise<void> => {
    mkdirSync(luaRoot, { recursive: true });
    writeFileSync(join(luaRoot, 'placeholder.lua'), 'return true');
    engine = await new LuaFactory().createEngine();
    installRequireShim(engine, { luaRoot, moduleId: 'TestModule', logger });
  });

  afterAll((): void => {
    engine.global.close();
    rmSync(luaRoot, { recursive: true, force: true });
  });

  it('exec returns a boolean', (): void => {
    const p = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      return tostring(pcre.exec('hello world', 'wor')) .. ',' .. tostring(pcre.exec('hello world', 'xyz'))
    `) as string;
    expect(p).toBe('true,false');
  });

  it('find returns (start, end) 1-based like string.find (LuaPCRE2.pas:108-128)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local s, e = pcre.find('abcabc', 'bca')
      return tostring(s) .. ',' .. tostring(e)
    `) as string;
    expect(r).toBe('2,4');
  });

  it('find honours the 1-based start offset (LuaPCRE2.pas:74-81)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      -- 'abc' occurs at bytes 0 and 3; from byte 1 the first match is at 3
      local s, e = pcre.find('abcabc', 'abc', 2)
      return tostring(s) .. ',' .. tostring(e)
    `) as string;
    expect(r).toBe('4,6');
  });

  it('find returns no values when the match only lies before the offset', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      -- 'bca' occurs only at byte 1; searching from byte 2 finds nothing
      local s, e = pcre.find('abcabc', 'bca', 3)
      return tostring(s) .. '|' .. tostring(e)
    `) as string;
    expect(r).toBe('nil|nil');
  });

  it('find yields UTF-8 byte offsets (PCRE2_UTF subjects are byte strings)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local s, e = pcre.find('héllo wörld', 'wör')
      return tostring(s) .. ',' .. tostring(e)
    `) as string;
    expect(r).toBe('8,11');
  });

  it('find returns no values on no match (Pascal Result = 0)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local s, e = pcre.find('abc', 'xyz')
      return tostring(s) .. '|' .. tostring(e)
    `) as string;
    expect(r).toBe('nil|nil');
  });

  it('match with no capture groups returns the whole match (MatchCount == 1)', (): void => {
    const r = engine.doStringSync(
      `return require 'fmd.pcre2'.match('hello world', 'wor\\\\w+')`,
    ) as string;
    expect(r).toBe('world');
  });

  it('match with capture groups returns the groups only (internalmatch)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local a, b = pcre.match('a123-456b', '(\\\\d+)-(\\\\d+)')
      return tostring(a) .. '|' .. tostring(b)
    `) as string;
    expect(r).toBe('123|456');
  });

  it('match returns named-group values in group order (PCRE2 docs pattern)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local a, b = pcre.match('2024-05', '(?<year>\\\\d{4})-(?<month>\\\\d{2})')
      return tostring(a) .. '|' .. tostring(b)
    `) as string;
    expect(r).toBe('2024|05');
  });

  it('unset capture groups come back as empty strings (PCRE2_UNSET wrap)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local a, b = pcre.match('b', '(a)|(b)')
      return tostring(a) .. '|' .. tostring(b)
    `) as string;
    expect(r).toBe('|b');
  });

  it('match honours the start offset', (): void => {
    const r = engine.doStringSync(
      `return require 'fmd.pcre2'.match('abc123def', '\\\\d+', 4)`,
    ) as string;
    expect(r).toBe('123');
  });

  it('gmatch iterates with ExecNext continuation (match end offsets)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local t = {}
      for v in pcre.gmatch('k1=v1;k2=v2', '\\\\w+=\\\\w+') do t[#t + 1] = v end
      return table.concat(t, ';')
    `) as string;
    expect(r).toBe('k1=v1;k2=v2');
  });

  it('gmatch yields capture groups when the pattern has them', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local t = {}
      for k, v in pcre.gmatch('k1=v1;k2=v2', '(\\\\w+)=(\\\\w+)') do t[#t + 1] = k .. '>' .. v end
      return table.concat(t, ';')
    `) as string;
    expect(r).toBe('k1>v1;k2>v2');
  });

  it('gmatch stops after the last match', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local n = 0
      for v in pcre.gmatch('abc', 'xyz') do n = n + 1 end
      return n
    `) as number;
    expect(r).toBe(0);
  });

  it('gsub with PCRE2 $-expansion ($0, $n, $${...}, $$)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      return
        pcre.gsub('abc abc', 'abc', '[${'$'}{0}]') .. '|' ..
        pcre.gsub('a-b', '(\\\\w)-(\\\\w)', '${'$'}2-${'$'}1') .. '|' ..
        pcre.gsub('abc', 'abc', '${'$'}${'$'}1')
    `) as string;
    expect(r).toBe('[abc] [abc]|b-a|$1');
  });

  it('gsub substitutes globally (PCRE2_SUBSTITUTE_GLOBAL)', (): void => {
    const r = engine.doStringSync(
      `return require 'fmd.pcre2'.gsub('aaa', 'a', 'b')`,
    ) as string;
    expect(r).toBe('bbb');
  });

  it('gsub honours the 4-argument start offset form (LuaPCRE2.pas:79-80)', (): void => {
    const r = engine.doStringSync(
      `return require 'fmd.pcre2'.gsub('aaa', 'a', 'b', 2)`,
    ) as string;
    expect(r).toBe('abb');
  });

  it('gsub advances past empty matches like pcre2_substitute', (): void => {
    const r = engine.doStringSync(
      `return require 'fmd.pcre2'.gsub('abc', 'x*', '-')`,
    ) as string;
    expect(r).toBe('-a-b-c-');
  });

  it('gsub with untranslatable pattern leaves the subject unchanged + logs', (): void => {
    logger.clear();
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local out = pcre.gsub('abc', 'a\\\\Kbc', 'x')
      local n = 0
      for v in pcre.gmatch('abc', 'a\\\\Kb') do n = n + 1 end
      return out .. '|' .. tostring(n) .. '|' .. tostring(pcre.exec('abc', 'a\\\\Kb'))
    `) as string;
    expect(r).toBe('abc|0|false');
    const records = logger.forModule('TestModule');
    expect(records.length).toBeGreaterThanOrEqual(3);
    for (const rec of records) {
      expect(rec.level).toBe('log');
      expect(rec.message).toContain('PCRE2 compile error');
    }
  });

  it('malformed PCRE2 pattern fails loud via the compile path', (): void => {
    logger.clear();
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local f1, f2 = pcre.find('abc', '[unclosed')
      local m1 = pcre.match('abc', '[unclosed')
      return
        tostring(pcre.exec('abc', '[unclosed')) .. '|' ..
        tostring(f1) .. '|' ..
        tostring(select('#', pcre.find('abc', '[unclosed'))) .. '|' ..
        tostring(m1)
    `) as string;
    expect(r).toBe('false|nil|0|nil');
    expect(logger.forModule('TestModule')).toHaveLength(4);
  });

  it('^ never matches at a non-zero startoffset (documented divergence)', (): void => {
    // PCRE2 treats startoffset as a virtual string start (no NOTBOL);
    // JS anchors ^ at the subject start only — COMPAT.md row
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      return tostring(pcre.exec('ab', '^b', 2))
    `) as string;
    expect(r).toBe('false');
  });

  it('lookbehind still sees characters before the start offset (PCRE2 parity)', (): void => {
    const r = engine.doStringSync(`
      local pcre = require 'fmd.pcre2'
      local s, e = pcre.find('abc', '(?<=a)b', 2)
      return tostring(s) .. ',' .. tostring(e)
    `) as string;
    expect(r).toBe('2,2');
  });

  it('the required lib exposes exactly the LuaPCRE2.pas method surface (LuaPCRE2.pas:237-245)', (): void => {
    // host libs cross as wasmoon userdata proxies (like fmd.duktape) —
    // method presence, not pairs()
    const r = engine.doStringSync(`
      local t = require 'fmd.pcre2'
      return tostring(t.exec ~= nil) .. ',' .. tostring(t.find ~= nil) .. ',' ..
             tostring(t.match ~= nil) .. ',' .. tostring(t.gmatch ~= nil) .. ',' ..
             tostring(t.gsub ~= nil)
    `) as string;
    expect(r).toBe('true,true,true,true,true');
  });
});
