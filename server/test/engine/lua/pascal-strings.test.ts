import { describe, expect, it } from 'vitest';
import {
  getBetween,
  mangaInfoStatusIfPos,
  maybeFillHost,
  pascalTrim,
  pascalTrimChars,
  removeURLDelim,
  separateLeft,
  separateRight,
  splitURL,
  trimLua,
  MANGAINFO_STATUS_CANCELLED,
  MANGAINFO_STATUS_COMPLETED,
  MANGAINFO_STATUS_HIATUS,
  MANGAINFO_STATUS_ONGOING,
  MANGAINFO_STATUS_UNKNOWN,
} from '../../../src/engine/lua/pascal-strings.js';

/**
 * Pascal-parity unit tests for the §5.1 base-global string helpers —
 * ports of synapse/synautil.pas, uBaseUnit.pas and httpsendthread.pas
 * edge cases (128 modules depend on MangaInfoStatusIfPos output
 * constants; MaybeFillHost is used by nearly every GetInfo).
 */

describe('Trim (LuaBaseUnit.pas:20-24 over SysUtils)', () => {
  it('trims whitespace both ends by default (chars <= #32)', () => {
    expect(pascalTrim('  hello \t\n')).toBe('hello');
    expect(pascalTrim('\t\r\nx')).toBe('x');
    expect(pascalTrim('')).toBe('');
    expect(pascalTrim('   ')).toBe('');
    expect(pascalTrim('a b')).toBe('a b');
  });

  it('trims a char set when given', () => {
    expect(pascalTrimChars('xxhelloxx', 'x')).toBe('hello');
    expect(pascalTrimChars('abc123abc', 'abc')).toBe('123');
    expect(trimLua('  s  ', ' s')).toBe('');
  });
});

describe('SeparateLeft/SeparateRight (synautil.pas:1156-1180)', () => {
  it('splits on the first delimiter', () => {
    expect(separateLeft('a|b|c', '|')).toBe('a');
    expect(separateRight('a|b|c', '|')).toBe('b|c');
  });

  it('returns the whole string when the delimiter is absent', () => {
    expect(separateLeft('abc', '|')).toBe('abc');
    expect(separateRight('abc', '|')).toBe('abc');
  });

  it('handles multi-char delimiters and empty strings', () => {
    expect(separateLeft('key=value', '=')).toBe('key');
    expect(separateRight('key=value', '=')).toBe('value');
    expect(separateRight('', 'x')).toBe('');
    expect(separateLeft('abc', '')).toBe('');
  });
});

describe('GetBetween (synautil.pas:1671-1727, nesting-aware)', () => {
  it('extracts text between the first pair', () => {
    expect(getBetween('(', ')', 'a(b)c')).toBe('b');
    expect(getBetween('<div>', '</div>', '<div>hello</div>')).toBe('hello');
  });

  it('returns empty when value is exactly begin+end', () => {
    expect(getBetween('[', ']', '[]')).toBe('');
  });

  it('falls back to the whole value on degenerate inputs', () => {
    // shorter than begin+end
    expect(getBetween('[[', ']]', '[a]')).toBe('[a]');
    // no begin pair
    expect(getBetween('<<', '>>', 'plain')).toBe('plain');
    // no end pair after begin
    expect(getBetween('<', '>', '<abc')).toBe('<abc');
  });

  it('is nesting-aware like the Pascal implementation', () => {
    expect(getBetween('{', '}', '{a{b}c}')).toBe('a{b}c');
    expect(getBetween('(', ')', '(a(b)c)d)')).toBe('a(b)c');
  });
});

describe('SplitURL (httpsendthread.pas:191-268)', () => {
  it('splits scheme://host/path', () => {
    expect(splitURL('https://www.11toon.com/page')).toEqual({
      host: 'www.11toon.com',
      path: '/page',
    });
  });

  it('treats leading-slash paths as host-less', () => {
    expect(splitURL('/manga/x/ch-1')).toEqual({ host: '', path: '/manga/x/ch-1' });
    expect(splitURL('/')).toEqual({ host: '', path: '' });
  });

  it('detects bare hosts only when a path follows (Pascal poschar semantics)', () => {
    // no scheme, no '/': Pascal leaves host='' and treats it as a path
    expect(splitURL('site.example')).toEqual({ host: '', path: '/site.example' });
    expect(splitURL('site.example/manga')).toEqual({ host: 'site.example', path: '/manga' });
  });

  it('strips ports from the host', () => {
    expect(splitURL('http://site.example:8080/a')).toEqual({ host: 'site.example', path: '/a' });
    expect(splitURL('https://site.example:443')).toEqual({ host: 'site.example', path: '' });
  });

  it('handles protocol-relative URLs like the Pascal code', () => {
    // cleanuri strips the leading '//' but no proto/port ⇒ host stays ''
    expect(splitURL('//site.example')).toEqual({ host: '', path: '/site.example' });
  });
});

describe('MaybeFillHost (uBaseUnit.pas:943)', () => {
  it('prefixes host-less paths with the host (trailing slash removed)', () => {
    expect(maybeFillHost('https://site.example', '/manga/x/ch-1')).toBe(
      'https://site.example/manga/x/ch-1',
    );
    expect(maybeFillHost('https://site.example/', '/manga')).toBe('https://site.example/manga');
    expect(maybeFillHost('https://site.example/', 'manga')).toBe('https://site.example/manga');
  });

  it('keeps absolute URLs untouched', () => {
    expect(maybeFillHost('https://base.example', 'https://other.example/page')).toBe(
      'https://other.example/page',
    );
    expect(maybeFillHost('https://base.example', '')).toBe('');
  });
});

describe('RemoveURLDelim (uBaseUnit.pas:2003)', () => {
  it('trims trailing slashes', () => {
    expect(removeURLDelim('https://site.example/')).toBe('https://site.example');
    expect(removeURLDelim('https://site.example')).toBe('https://site.example');
    expect(removeURLDelim('///')).toBe('');
  });
});

describe('MangaInfoStatusIfPos (uBaseUnit.pas:2793-2852)', () => {
  it('maps keywords to the exact output constants, priority ordered', () => {
    expect(mangaInfoStatusIfPos('ongoing', 'ongoing', 'complete')).toBe(MANGAINFO_STATUS_ONGOING);
    expect(mangaInfoStatusIfPos('Completed', 'ongoing', 'complete')).toBe(MANGAINFO_STATUS_COMPLETED);
    expect(mangaInfoStatusIfPos('on hiatus', '', '', 'hiatus')).toBe(MANGAINFO_STATUS_HIATUS);
    expect(mangaInfoStatusIfPos('cancelled', '', '', '', 'cancelled')).toBe(
      MANGAINFO_STATUS_CANCELLED,
    );
    // priority: ongoing wins over completed when both match
    expect(mangaInfoStatusIfPos('ongoing and completed', 'ongoing', 'completed')).toBe(
      MANGAINFO_STATUS_ONGOING,
    );
  });

  it('supports |-alternatives in the search strings', () => {
    expect(mangaInfoStatusIfPos('en cours', 'en cours|ongoing|连载中', 'terminé')).toBe(
      MANGAINFO_STATUS_ONGOING,
    );
    expect(mangaInfoStatusIfPos('완결', '주간|월간|연재|격주', '완결')).toBe(
      MANGAINFO_STATUS_COMPLETED,
    );
  });

  it('searches substrings case-insensitively', () => {
    expect(mangaInfoStatusIfPos('Status: ONGOING!', 'ongoing', '')).toBe(MANGAINFO_STATUS_ONGOING);
  });

  it('returns Unknown for unmatched and empty for empty search', () => {
    expect(mangaInfoStatusIfPos('whatever', 'ongoing', 'completed')).toBe(MANGAINFO_STATUS_UNKNOWN);
    expect(mangaInfoStatusIfPos('')).toBe('');
  });
});
