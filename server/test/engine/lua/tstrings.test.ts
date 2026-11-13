import { describe, expect, it } from 'vitest';
import { PascalTStrings, compareText } from '../../../src/engine/lua/tstrings.js';

/**
 * TStrings property/unit tests (§5.5, LuaStrings.pas:216-263). Every case
 * documents the Delphi/LCL (FPC 3.2.2 rtl classes/stringl.inc) semantics it
 * pins; the oracle cases were captured from FPC 3.2.2 probe programs
 * (documented inline per test). Property tests cover the round-trip
 * invariants for CommaText/DelimitedText and the IndexOfName contract.
 */

/** Deterministic ASCII fuzz corpus: letters, digits, specials, whitespace. */
function* fuzzCases(): Generator<string[]> {
  const atoms = [
    'plain',
    'has space',
    'has,comma',
    'has"quote',
    '',
    'lead ',
    ' trail',
    '\ttab',
    'a""b', // doubled quotes in an unquoted token stay literal
    '"quoted"', // literal quotes in the item
    'multi  space',
    'x',
  ];
  // deterministic pseudo-shuffle of 1..3 atoms (seeded LCG)
  let seed = 42;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let n = 0; n < 200; n += 1) {
    const len = 1 + Math.floor(next() * 3);
    const items: string[] = [];
    for (let i = 0; i < len; i += 1) {
      items.push(atoms[Math.floor(next() * atoms.length)] ?? 'x');
    }
    yield items;
  }
}

describe('TStrings basics (documented case-by-case vs FPC 3.2.2)', () => {
  it('Add returns the index (TStrings.Add; LuaStrings discards it)', () => {
    const l = new PascalTStrings();
    expect(l.add('a')).toBe(0);
    expect(l.add('b')).toBe(1);
    expect(l.count).toBe(2);
  });

  it('Get/Set 0-based; out of range raises (EStringListError parity)', () => {
    const l = new PascalTStrings();
    l.add('one');
    l.add('two');
    expect(l.get(0)).toBe('one');
    l.set(1, 'TWO');
    expect(l.get(1)).toBe('TWO');
    expect(() => l.get(2)).toThrow('List index (2) out of bounds');
    expect(() => l.get(-1)).toThrow('List index (-1) out of bounds');
    expect(() => l.set(5, 'x')).toThrow('List index (5) out of bounds');
    expect(() => l.delete(5)).toThrow('List index (5) out of bounds');
  });

  it('Delete/IndexOf/Count/Clear basics', () => {
    const l = new PascalTStrings();
    for (const s of ['a', 'b', 'a']) l.add(s);
    expect(l.indexOf('a')).toBe(0); // first occurrence
    expect(l.indexOf('A')).toBe(-1); // IndexOf is case-SENSITIVE
    expect(l.indexOf('zz')).toBe(-1);
    l.delete(1);
    expect(l.snapshot()).toEqual(['a', 'a']);
    l.clear();
    expect(l.count).toBe(0);
    expect(l.getText()).toBe('');
  });

  it('AddText parses line breaks and APPENDS (stringl.inc:956; probes T1-T6, E1)', () => {
    const l = new PascalTStrings();
    l.addText('a\nb'); // probe T: AddText LF → 2 items
    expect(l.snapshot()).toEqual(['a', 'b']);
    l.clear();
    l.addText('a\r\nb\r\n'); // trailing break adds no item (probe T2)
    expect(l.snapshot()).toEqual(['a', 'b']);
    l.addText(''); // empty text appends nothing — even on a non-empty list (probe E1)
    expect(l.snapshot()).toEqual(['a', 'b']);
    l.addText('c');
    expect(l.snapshot()).toEqual(['a', 'b', 'c']);
    l.clear();
    l.addText('x\ry'); // lone CR is a break (probe E2)
    expect(l.snapshot()).toEqual(['x', 'y']);
  });

  it('Text get: joined with trailing LineBreak when non-empty (probe: [p,q]→"p\\nq\\n")', () => {
    const l = new PascalTStrings();
    expect(l.getText()).toBe('');
    l.add('p');
    l.add('q');
    expect(l.getText()).toBe('p\nq\n');
    expect(l.getText()).toBe(l.snapshot().join('\n') + '\n');
  });

  it('Text set: CRLF/LF/lone-CR breaks, trailing break adds no item, "" clears', () => {
    const l = new PascalTStrings();
    l.setText('');
    expect(l.count).toBe(0); // probe T4
    l.setText('x\r\ny\n'); // probe T5 → 2 items
    expect(l.snapshot()).toEqual(['x', 'y']);
    l.setText('a\n\nb'); // interior empty line kept
    expect(l.snapshot()).toEqual(['a', '', 'b']);
    l.setText('a\n\n'); // trailing empty segment from the break before EOL kept
    expect(l.snapshot()).toEqual(['a', '']);
    l.setText('p\rq'); // lone CR (probe: SetText CR → 2 items)
    expect(l.snapshot()).toEqual(['p', 'q']);
    // SetText(Text) identity for items without line breaks
    l.clear();
    l.add('hello');
    l.add('world');
    l.setText(l.getText());
    expect(l.snapshot()).toEqual(['hello', 'world']);
  });

  it('Reverse reverses (LuaStrings.pas:209-231 exchange loop)', () => {
    const l = new PascalTStrings();
    for (const s of ['1', '2', '3', '4']) l.add(s);
    l.reverse();
    expect(l.snapshot()).toEqual(['4', '3', '2', '1']);
    l.reverse();
    expect(l.snapshot()).toEqual(['1', '2', '3', '4']);
  });

  it('Sort: ASCII-case-insensitive ascending (TStringList CompareStrings default)', () => {
    const l = new PascalTStrings();
    for (const s of ['B', 'a', 'C', 'b2', 'A1']) l.add(s);
    l.sort();
    // FPC probe S1: a,A1,B,b2,C — case-folded lexicographic
    expect([...l.snapshot()].sort(compareText)).toEqual(l.snapshot());
    expect(l.snapshot()).toEqual(['a', 'A1', 'B', 'b2', 'C']);
  });

  it('sort invariant property: output is sorted and a permutation of the input', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 50; n += 1) {
      const items: string[] = [];
      const count = 1 + Math.floor(next() * 12);
      for (let i = 0; i < count; i += 1) {
        const len = 1 + Math.floor(next() * 4);
        let s = '';
        for (let c = 0; c < len; c += 1) {
          s += String.fromCharCode(65 + Math.floor(next() * 26)); // A..Z
        }
        items.push(s);
      }
      const l = new PascalTStrings();
      for (const s of items) l.add(s);
      l.sort();
      const out = l.snapshot();
      expect([...out].sort(compareText)).toEqual(out);
      expect([...out].map((s) => s.toLowerCase()).sort(compareText)).toEqual(
        out.map((s) => s.toLowerCase()),
      );
      expect([...items].sort(compareText)).toEqual(out); // permutation
    }
  });
});

describe('TStrings Values/IndexOfName (stringl.inc:479/695/1291 contracts)', () => {
  it('Values set overwrites case-insensitively in place; append when absent', () => {
    const l = new PascalTStrings();
    l.setValue('a', '1');
    l.setValue('A', '2'); // probe V1: CompareText match → in-place overwrite
    expect(l.snapshot()).toEqual(['A=2']); // whole line replaced with Name+Sep+Value
    expect(l.getValue('a')).toBe('2');
    expect(l.getValue('A')).toBe('2');
    l.add('b=3');
    l.add('b = 4'); // name is 'b ' (UNTRIMMED before the separator)
    expect(l.getValue('b')).toBe('3');
    expect(l.getValue('b ')).toBe(' 4'); // value after the FIRST separator, untrimmed
    l.setValue('b', '9');
    expect(l.snapshot()).toEqual(['A=2', 'b=9', 'b = 4']); // replaced line 1 only
  });

  it('Values[""] appends "=value"; IndexOfName("") matches lines starting with the separator', () => {
    const l = new PascalTStrings();
    l.setValue('', 'e'); // probe V3: IndexOfName('')=-1 → append '=e'
    expect(l.snapshot()).toEqual(['=e']);
    expect(l.getValue('')).toBe('e');
    expect(l.indexOfName('')).toBe(0);
  });

  it('IndexOfName semantics (stringl.inc:1291, probe V3/V4/V5/T7)', () => {
    const l = new PascalTStrings();
    l.add('A=2');
    l.add('b=3');
    l.add('b = 4');
    l.add('=e');
    l.add('plain');
    l.add('k=v=w');
    expect(l.indexOfName('a')).toBe(0); // case-insensitive
    expect(l.indexOfName('A')).toBe(0);
    expect(l.indexOfName('')).toBe(3); // '' matches the line STARTING with '='
    expect(l.indexOfName('b ')).toBe(2); // untrimmed name
    expect(l.indexOfName('b')).toBe(1); // 'b = 4' does NOT match 'b' (prefix≠separator)
    expect(l.indexOfName('plain')).toBe(-1); // no separator → never a name
    expect(l.indexOfName('k')).toBe(5);
    expect(l.indexOfName('zz')).toBe(-1);
    expect(l.getValue('k')).toBe('v=w'); // value = everything after FIRST separator
    expect(l.getValue('plain')).toBe('');
    expect(l.getValue('zz')).toBe('');
  });

  it('NameValueSeparator changes Values/IndexOfName (probe N1-N4)', () => {
    const l = new PascalTStrings();
    l.add('k: v');
    expect(l.nameValueSeparator).toBe('=');
    expect(l.indexOfName('k')).toBe(-1);
    l.nameValueSeparator = ':';
    expect(l.indexOfName('k')).toBe(0);
    expect(l.getValue('k')).toBe(' v'); // after the separator, untrimmed
    l.setValue('k', 'w');
    expect(l.snapshot()).toEqual(['k:w']); // whole line rebuilt with Name+Sep+Value
    l.nameValueSeparator = '=';
    expect(l.indexOfName('k')).toBe(-1); // 'k:w' has no '='
  });
});

describe('TStrings CommaText/DelimitedText (stringl.inc Get/Set + probes)', () => {
  it('CommaText get: force comma/quote; quote items containing <=#32, comma or quote', () => {
    const l = new PascalTStrings();
    l.add('plain');
    l.add('has space');
    l.add('has,comma');
    l.add('has"quote');
    l.add('');
    l.add('lead ');
    l.add('\ttab');
    // probe C2 — empty item emits nothing (OnlyQuote=False), rest quoted per rule
    expect(l.getCommaText()).toBe('plain,"has space","has,comma","has""quote",,"lead ","\ttab"');
    l.clear();
    l.add('a');
    l.add('b');
    expect(l.getCommaText()).toBe('a,b'); // probe C3
    expect(new PascalTStrings().getCommaText()).toBe(''); // probe C4 (empty list)
    l.clear();
    l.add('ä'); // high bytes do NOT trigger quoting (probe E3)
    expect(l.getCommaText()).toBe('ä');
  });

  it('single empty item serializes as \'""\' (stringl.inc:247-249, probe Q1/Q2)', () => {
    const l = new PascalTStrings();
    l.add('');
    expect(l.getCommaText()).toBe('""');
    l.clear();
    l.add('');
    l.delimiter = ';';
    expect(l.getDelimitedText()).toBe('""');
    l.setDelimitedText('""'); // probe Q3: parses back to one empty item
    expect(l.snapshot()).toEqual(['']);
  });

  it('CommaText set forces delimiter "," and quote \'"\' (probes A2/A3)', () => {
    const l = new PascalTStrings();
    l.delimiter = '|';
    l.setCommaText('x|y'); // probe A2: '|' is NOT a separator here
    expect(l.snapshot()).toEqual(['x|y']);
    l.clear();
    l.setCommaText('#has space#|z'); // probe A3: '#' is NOT a quote here
    expect(l.snapshot()).toEqual(['#has', 'space#|z']);
    l.clear();
    l.setCommaText('"x, y",z , p\'q , '); // probe C1
    expect(l.snapshot()).toEqual(['x, y', 'z', "p'q", '']);
  });

  it('DelimitedText uses the CURRENT delimiter/quote (probes D1-D3, A1)', () => {
    const l = new PascalTStrings();
    l.add('a,b');
    l.add('c');
    l.delimiter = '|';
    // probe A1: DelimitedText with '|' — no quoting needed (comma is inert)
    expect(l.getDelimitedText()).toBe('a,b|c');
    expect(l.getCommaText()).toBe('"a,b",c'); // CommaText forces ',' + '"'
    l.clear();
    l.delimiter = ';';
    l.setDelimitedText('a; b; "c;d"; e'); // probe D1: spaces around tokens skipped
    expect(l.snapshot()).toEqual(['a', 'b', 'c;d', 'e']);
    l.delimiter = '|';
    l.quoteChar = '#';
    l.setDelimitedText('x|#y|z#| w|'); // probe D2
    expect(l.snapshot()).toEqual(['x', 'y|z', 'w', '']);
    l.delimiter = ',';
    // probe D3: get with delimiter ',' quote '#'
    expect(l.getDelimitedText()).toBe('x,y|z,w,');
    expect(l.getCommaText()).toBe('x,y|z,w,');
  });

  it('DelimitedText parser: whitespace acts as separator, not empty-item emitter', () => {
    const l = new PascalTStrings();
    l.setDelimitedText('a  b'); // probe P1
    expect(l.snapshot()).toEqual(['a', 'b']);
    l.setDelimitedText(' a , b '); // probe P3
    expect(l.snapshot()).toEqual(['a', 'b']);
    l.setDelimitedText(','); // probe P10: [empty, empty]
    expect(l.snapshot()).toEqual(['', '']);
    l.setDelimitedText(' '); // probe P11
    expect(l.snapshot()).toEqual([]);
    l.setDelimitedText(''); // probe E4: clears
    expect(l.snapshot()).toEqual([]);
    l.setDelimitedText('a,,"b'); // probe P9: empty mid + unterminated quote reads to end
    expect(l.snapshot()).toEqual(['a', '', 'b']);
    l.setDelimitedText('a,"b,c",d'); // probe P7
    expect(l.snapshot()).toEqual(['a', 'b,c', 'd']);
    l.setDelimitedText('"a""b"c'); // probe P12: doubled quote → literal; trailing char new token
    expect(l.snapshot()).toEqual(['a"b', 'c']);
    l.setDelimitedText('a""b'); // probe P6: doubled quote OUTSIDE quotes stays literal
    expect(l.snapshot()).toEqual(['a""b']);
    l.setDelimitedText('"a" b'); // probe P14
    expect(l.snapshot()).toEqual(['a', 'b']);
    l.setDelimitedText('"a b"'); // probe P4: quoted internal space kept
    expect(l.snapshot()).toEqual(['a b']);
  });

  it('PROPERTY: CommaText get→set round-trips items exactly', () => {
    for (const items of fuzzCases()) {
      const l = new PascalTStrings();
      for (const s of items) l.add(s);
      const text = l.getCommaText();
      const l2 = new PascalTStrings();
      l2.setCommaText(text);
      expect(l2.snapshot()).toEqual(items);
    }
  });

  it('PROPERTY: DelimitedText get→set round-trips with custom delimiter/quote', () => {
    for (const items of fuzzCases()) {
      const l = new PascalTStrings();
      l.delimiter = '|';
      l.quoteChar = '#';
      for (const s of items) l.add(s);
      const text = l.getDelimitedText();
      const l2 = new PascalTStrings();
      l2.delimiter = '|';
      l2.quoteChar = '#';
      l2.setDelimitedText(text);
      expect(l2.snapshot()).toEqual(items);
    }
  });

  it('PROPERTY: CommaText get is idempotent-stable (set→get→set fixed point)', () => {
    for (const items of fuzzCases()) {
      const l1 = new PascalTStrings();
      for (const s of items) l1.add(s);
      const text1 = l1.getCommaText();
      const l2 = new PascalTStrings();
      l2.setCommaText(text1);
      expect(l2.getCommaText()).toBe(text1);
    }
  });

  it('PROPERTY: Text set→get round-trips items without line breaks', () => {
    for (const items of [...fuzzCases()].slice(0, 100)) {
      const filtered = items.filter((s) => !/[\r\n]/.test(s));
      const l = new PascalTStrings();
      for (const s of filtered) l.add(s);
      const text = l.getText();
      const l2 = new PascalTStrings();
      l2.setText(text);
      expect(l2.snapshot()).toEqual(filtered);
    }
  });
});

describe('compareText (FPC CompareText, ASCII fold, no locale)', () => {
  it('case-insensitive, prefix < longer, code-unit order otherwise', () => {
    expect(compareText('a', 'B')).toBeLessThan(0);
    expect(compareText('A1', 'a')).toBeGreaterThan(0);
    expect(compareText('abc', 'abc')).toBe(0);
    expect(compareText('ABC', 'abc')).toBe(0);
    expect(compareText('a', 'a\u00e4')).toBeLessThan(0);
  });
});
