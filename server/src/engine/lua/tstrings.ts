/**
 * FPC TStringList-semantics list (§5.5 TStrings facade backing, LuaStrings.pas:216-263).
 *
 * Semantics are pinned against the REAL FPC 3.2.2 rtl (rtl/objpas/classes/
 * stringl.inc @ release_3_2_2 — the exact runtime FMD2 and the corpus FPC
 * harness compile against), verified case-by-case with probe programs; the
 * documented decision per case:
 *
 *  - Add(s)            appends and RETURNS the index (classes.pp TStrings.Add);
 *                      the LuaStrings facade discards it (strings_add Result:=0).
 *  - AddText(s)        TStrings.AddText = DoSetTextStr(S, DoClear=False): parse s
 *                      as Text (#10/#13/CRLF breaks, trailing break adds no item)
 *                      and APPEND the lines (stringl.inc:956; probe E1/T2/T3/T6).
 *  - Get/Set[i]        0-based bracket access (LuaStrings default array property);
 *                      out of range raises EStringListError 'List index (N) out
 *                      of bounds' (probe P1 — FMD2 propagates it as a Lua error).
 *  - Count/Clear/Delete standard; Delete OOR raises the same way.
 *  - IndexOf           exact case-sensitive compare, -1 when absent.
 *  - IndexOfName(n)    stringl.inc:1291: for each line, len:=Pos(sep,line)-1;
 *                      match when len>=0 and CompareText(Name, Copy(line,1,len))=0
 *                      — ASCII-case-INSENSITIVE, name is the UNTRIMMED prefix
 *                      before the FIRST separator, a line without separator never
 *                      matches, name '' matches lines STARTING with the separator
 *                      (probe V3: IndexOfName('')=3 for line '=e').
 *  - Values[n] get     GetValue (stringl.inc:479): IndexOfName → GetNameValue —
 *                      value = everything after the FIRST separator, UNTRIMMED
 *                      ('k=v=w' → 'v=w'; 'k: v' with sep ':' → ' v'); absent → ''.
 *  - Values[n] set     SetValue (stringl.inc:695): overwrite in place with
 *                      Name+Sep+Value when found (case-insensitively), else
 *                      Add(Name+Sep+Value) — NO Add('') detour in FPC 3.2.2.
 *  - Reverse           LuaStrings.pas:209-231 exchange loop = full reversal.
 *  - Sort              TStringList default: CompareStrings → DoCompareText →
 *                      ASCII-case-insensitive ascending (CaseSensitive=False,
 *                      no locale data on the Linux runtime); FPC quicksort is
 *                      NOT stable — equal keys may reorder either way, tests pin
 *                      the sorted invariant, not the order of equal keys.
 *  - Text get          GetTextStr (stringl.inc:773): items joined with
 *                      LineEnding, WITH a trailing LineBreak when Count>0
 *                      (soTrailingLineBreak default; probe: [p,q] → 'p\nq\n').
 *                      LineEnding = LF here, matching the Linux FPC ground-truth
 *                      harness this port is verified against (FMD2's Windows
 *                      builds emit CRLF; parsing accepts both either way).
 *  - Text set          DoSetTextStr/GetNextLine (stringl.inc:834-947): breaks are
 *                      #10, #13 and CRLF; a trailing break adds no item; '' →
 *                      cleared (probe T4/T5/E2). SetText('') clears.
 *  - CommaText get     GetCommaText (stringl.inc:172): forces Delimiter=',',
 *                      QuoteChar='"', then GetDelimitedText.
 *  - DelimitedText get GetDelimitedText (stringl.inc:215): BreakChars =
 *                      [#0..' ', QuoteChar, Delimiter] (StrictDelimiter=false);
 *                      an item containing a BreakChar is QuoteString-quoted
 *                      (doubled quotes); items are joined with Delimiter, no
 *                      trailing delimiter; a SINGLE empty item serializes as
 *                      '""' (stringl.inc:247-249; probe Q1/Q2).
 *  - CommaText set     SetCommaText (stringl.inc:630): DoSetDelimitedText with
 *                      quote '"' delimiter ',' FORCED (probe A2/A3) — current
 *                      Delimiter/QuoteChar are NOT used.
 *  - DelimitedText set SetDelimitedText (stringl.inc:530): DoSetDelimitedText
 *                      with the CURRENT QuoteChar/Delimiter. Parser
 *                      (stringl.inc:537-625, verified statement-by-statement
 *                      against probes P1-P14/E5-E7): per iteration — skip ONE
 *                      delimiter (only from the 2nd token on), skip whitespace
 *                      (Ord<=32), then a quoted section (QuoteChar…QuoteChar,
 *                      ''→literal quote, unterminated quote reads to the end)
 *                      or an unquoted token read until whitespace/delimiter/
 *                      end; trailing delimiter (from the 2nd token on) adds an
 *                      empty item; whitespace between tokens acts as a separator
 *                      but does NOT itself emit empty items (probe P1/P3/P10).
 */

export class PascalTStrings {
  private items: string[] = [];
  delimiter: string = ',';
  quoteChar: string = '"';
  nameValueSeparator: string = '=';

  get count(): number {
    return this.items.length;
  }

  /** TStrings.Add — returns the new index (facade discards it). */
  add(s: string): number {
    this.items.push(s);
    return this.items.length - 1;
  }

  /** TStrings.AddText — parse `s` like Text and append the lines. */
  addText(s: string): void {
    for (const line of textLines(s)) {
      this.items.push(line);
    }
  }

  /** TStrings.Strings[i] read — raises out of bounds (EStringListError parity). */
  get(index: number): string {
    const i = Math.trunc(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) {
      throw new Error(`List index (${index}) out of bounds`);
    }
    return this.items[i] ?? '';
  }

  /** TStrings.Strings[i] write — raises out of bounds. */
  set(index: number, s: string): void {
    const i = Math.trunc(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) {
      throw new Error(`List index (${index}) out of bounds`);
    }
    this.items[i] = s;
  }

  clear(): void {
    this.items.length = 0;
  }

  delete(index: number): void {
    const i = Math.trunc(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) {
      throw new Error(`List index (${index}) out of bounds`);
    }
    this.items.splice(i, 1);
  }

  indexOf(s: string): number {
    return this.items.findIndex((item) => item === s);
  }

  /** stringl.inc:1291 — ASCII-case-insensitive, first-separator name match. */
  indexOfName(name: string): number {
    for (let i = 0; i < this.items.length; i += 1) {
      const line = this.items[i] ?? '';
      const sep = line.indexOf(this.nameValueSeparator);
      if (sep >= 0 && compareText(name, line.slice(0, sep)) === 0) {
        return i;
      }
    }
    return -1;
  }

  /** LuaStrings.pas:209-231 — exchange-loop reversal. */
  reverse(): void {
    this.items.reverse();
  }

  /** TStringList default sort: ASCII-case-insensitive ascending. */
  sort(): void {
    this.items.sort(compareText);
  }

  /** GetText — joined with LineEnding, trailing break when non-empty. */
  getText(): string {
    return this.items.length === 0 ? '' : this.items.join('\n') + '\n';
  }

  /** SetText — #10/#13/CRLF breaks, trailing break adds no item. */
  setText(s: string): void {
    this.items = textLines(s);
  }

  getCommaText(): string {
    return this.getDelimitedTextWith(',', '"');
  }

  setCommaText(s: string): void {
    this.doSetDelimitedText(s, ',', '"');
  }

  getDelimitedText(): string {
    return this.getDelimitedTextWith(this.delimiter, this.quoteChar);
  }

  setDelimitedText(s: string): void {
    this.doSetDelimitedText(s, this.delimiter, this.quoteChar);
  }

  /** stringl.inc:479 GetValue. */
  getValue(name: string): string {
    const i = this.indexOfName(name);
    if (i < 0) return '';
    const line = this.items[i] ?? '';
    const sep = line.indexOf(this.nameValueSeparator);
    return sep >= 0 ? line.slice(sep + this.nameValueSeparator.length) : '';
  }

  /** stringl.inc:695 SetValue — in-place overwrite (case-insensitive) or append. */
  setValue(name: string, value: string): void {
    const i = this.indexOfName(name);
    const entry = `${name}${this.nameValueSeparator}${value}`;
    if (i < 0) {
      this.items.push(entry);
    } else {
      this.items[i] = entry;
    }
  }

  /** Live backing entries (host-side harvest, e.g. dispatcher read-back). */
  snapshot(): string[] {
    return [...this.items];
  }

  // -------------------------------------------------------------------------
  // stringl.inc:215 GetDelimitedText
  // -------------------------------------------------------------------------
  private getDelimitedTextWith(delim: string, quote: string): string {
    let result = '';
    for (let i = 0; i < this.items.length; i += 1) {
      const s = this.items[i] ?? '';
      let doQuote = false;
      for (let p = 0; p < s.length; p += 1) {
        const c = s.charCodeAt(p);
        if (c <= 32 || s[p] === quote || s[p] === delim) {
          doQuote = true;
          break;
        }
      }
      if (doQuote) {
        result += quote + replaceAllStr(s, quote, quote + quote) + quote;
      } else {
        result += s;
      }
      if (i < this.items.length - 1) {
        result += delim;
      }
    }
    // single empty item → '""' (stringl.inc:247-249)
    if (result.length === 0 && this.items.length === 1) {
      result = quote + quote;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // stringl.inc:537 DoSetDelimitedText — verified statement-by-statement
  // -------------------------------------------------------------------------
  private doSetDelimitedText(value: string, delim: string, quote: string): void {
    this.clear();
    const len = value.length;
    let i = 0; // 0-based cursor (Pascal i-1)
    let aNotFirst = false;
    while (i < len) {
      // skip ONE delimiter (from the 2nd token on)
      if (aNotFirst && value[i] === delim) {
        i += 1;
      }
      // MaybeSkipSpaces: Ord<=Ord(' ')
      while (i < len && value.charCodeAt(i) <= 32) {
        i += 1;
      }
      if (i >= len) {
        if (aNotFirst) {
          this.items.push('');
        }
      } else if (quote !== '\0' && value[i] === quote) {
        // CheckQuoted: scan to the closing quote, '' → literal quote
        let j = i + 1;
        while (j < len && (value[j] !== quote || value[j + 1] === quote)) {
          j += value[j] === quote ? 2 : 1;
        }
        const content = value.slice(i + 1, j);
        this.items.push(replaceAllStr(content, quote + quote, quote));
        i = j + 1;
      } else {
        // unquoted token: until whitespace/delimiter/end
        let j = i;
        while (j < len && value.charCodeAt(j) > 32 && value[j] !== delim) {
          j += 1;
        }
        this.items.push(value.slice(i, j));
        i = j;
      }
      while (i < len && value.charCodeAt(i) <= 32) {
        i += 1;
      }
      aNotFirst = true;
    }
  }
}

/** FPC CompareText (no locale data): ASCII-case-insensitive, else code-unit order. */
export function compareText(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const n = Math.min(la, lb);
  for (let i = 0; i < n; i += 1) {
    const ca = foldAscii(a.charCodeAt(i));
    const cb = foldAscii(b.charCodeAt(i));
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
  }
  return la === lb ? 0 : la < lb ? -1 : 1;
}

function foldAscii(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

function replaceAllStr(s: string, from: string, to: string): string {
  if (from === '') return s;
  return s.split(from).join(to);
}

/** FPC GetNextLine (stringl.inc:834): #10/#13/CRLF breaks; trailing → no item. */
function textLines(value: string): string[] {
  const out: string[] = [];
  let p = 0;
  while (p < value.length) {
    const start = p;
    while (p < value.length && value.charCodeAt(p) !== 10 && value.charCodeAt(p) !== 13) {
      p += 1;
    }
    out.push(value.slice(start, p));
    if (value.charCodeAt(p) === 13) p += 1;
    if (value.charCodeAt(p) === 10) p += 1;
  }
  return out;
}
