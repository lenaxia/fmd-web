import { describe, expect, it } from 'vitest';
import {
  decodeURL,
  encodeURL,
  massageUrl,
  maybeEncodeURL,
  resolveRedirectLocation,
  splitURL,
} from '../../../src/engine/shims/http-url.js';

/**
 * URL massaging unit tests (DESIGN §5.4 contract rows R-URL1..R-URL4).
 *
 * Contract → test matrix (source truth httpsendthread.pas / synacode.pas):
 * | Row    | Contract                                                        | Source                  | Test                                        |
 * |--------|------------------------------------------------------------------|-------------------------|---------------------------------------------|
 * | R-URL1 | strip leading ':', '/', control chars + spaces, trim right       | httpsendthread.pas:612  | massageUrl strips leading ":/" + whitespace |
 * | R-URL2 | MaybeEncodeURL: encode unless already encoded                    | :394-400                | maybeEncodeURL encode/leave matrix          |
 * | R-URL3 | prepend https:// when no '://' present                           | :615-616                | massageUrl prepends scheme                  |
 * | R-URL4 | EncodeURL/DecodeURL synacode parity (URLSpecialChar set)         | synacode.pas:494-497,93 | encodeURL/decodeURL parity                  |
 * | R-URL5 | empty URL after massaging fails                                  | :613-614 (Exit)         | massageUrl empty → ''                       |
 * | R-LOC1 | SplitURL host/path split (https default, port kept, path '/')    | :152-281                | splitURL matrix                             |
 * | R-LOC2 | redirect Location merge: relative → current host, absolute wins  | :665-671                | resolveRedirectLocation matrix              |
 */

describe('http-url: EncodeURL/DecodeURL synacode parity (R-URL4)', () => {
  it('encodes exactly the URLSpecialChar set as %XX', () => {
    // URLSpecialChar = [#0..#20, '<', '>', '"', '%', '{', '}', '|', '\',
    // '^', '[', ']', '`', #127..#255] (synacode.pas:93-94)
    expect(encodeURL('a b')).toBe('a%20b');
    expect(encodeURL('<>"%{}|\\^[]`')).toBe(
      '%3C%3E%22%25%7B%7D%7C%5C%5E%5B%5D%60',
    );
    // safe characters pass through (incl. ':' '/' '?' '=' '&' '+' '#' ';')
    expect(encodeURL('https://h/p?a=1&b=2+c#f')).toBe('https://h/p?a=1&b=2+c#f');
    expect(encodeURL('höhe')).toBe('h%C3%B6he'); // non-ASCII (#128+)
    expect(encodeURL('')).toBe('');
  });

  it('decodes %XX triplets (DecodeTriplet %)', () => {
    expect(decodeURL('a%20b')).toBe('a b');
    expect(decodeURL('h%C3%B6he')).toBe('höhe');
    // invalid triplet passes through untouched
    expect(decodeURL('100%')).toBe('100%');
    expect(decodeURL('%G1')).toBe('%G1');
    expect(decodeURL('')).toBe('');
  });

  it('round-trips through decode', () => {
    const raw = 'a b?c=d&e[f]'; // f is safe, [ ] encode
    expect(decodeURL(encodeURL(raw))).toBe(raw);
  });
});

describe('http-url: MaybeEncodeURL (:394-400, R-URL2)', () => {
  it('encodes when decoded length >= original length (not yet encoded)', () => {
    expect(maybeEncodeURL('a b')).toBe('a%20b');
    expect(maybeEncodeURL('ünïcode')).toBe('%C3%BCn%C3%AFcode');
  });

  it('leaves already-encoded URLs alone (decode shortens)', () => {
    expect(maybeEncodeURL('a%20b')).toBe('a%20b');
  });

  it('trims surrounding whitespace first', () => {
    expect(maybeEncodeURL('  a b  ')).toBe('a%20b');
  });

  it('returns empty string for empty input', () => {
    expect(maybeEncodeURL('')).toBe('');
    expect(maybeEncodeURL('   ')).toBe('');
  });
});

describe('http-url: massageUrl (:612-616, R-URL1/R-URL3/R-URL5)', () => {
  it('strips leading ":", "/" and control/space chars (:612)', () => {
    expect(massageUrl('://example.com/manga')).toBe('https://example.com/manga');
    expect(massageUrl('//example.com/manga')).toBe('https://example.com/manga');
    expect(massageUrl('  :/ /example.com')).toBe('https://example.com');
    expect(massageUrl('example.com')).toBe('https://example.com');
  });

  it('keeps URLs that already carry a scheme untouched (beyond massaging)', () => {
    expect(massageUrl('http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9/x');
    expect(massageUrl('https://example.com')).toBe('https://example.com');
  });

  it('applies MaybeEncodeURL (:614)', () => {
    expect(massageUrl('://example.com/a b')).toBe('https://example.com/a%20b');
  });

  it('returns "" for blank/only-strippable input (:613-614 Exit, R-URL5)', () => {
    expect(massageUrl('')).toBe('');
    expect(massageUrl('://  ///')).toBe('');
    expect(massageUrl('   ')).toBe('');
  });

  it('prepends https:// when no "://" anywhere (:615-616, R-URL3)', () => {
    expect(massageUrl('example.com:89/path')).toBe('https://example.com:89/path');
  });
});

describe('http-url: splitURL (:152-281, R-LOC1)', () => {
  it('splits scheme://host[:port]/path', () => {
    expect(splitURL('https://example.com/x/y?z=1')).toEqual({
      host: 'https://example.com',
      path: '/x/y?z=1',
    });
    expect(splitURL('http://127.0.0.1:8123/p')).toEqual({
      host: 'http://127.0.0.1:8123',
      path: '/p',
    });
  });

  it('dot-less hosts with ports degenerate (FMD2 quirk: port appended after fallback host)', () => {
    // SplitURL requires a dot to recognize the host; a dot-less host with
    // a port falls into the `ihost := iurl` fallback (:263-266) and the
    // port is appended after it — reproduced faithfully.
    expect(splitURL('http://other:2/b')).toEqual({
      host: 'http://other/b:2',
      path: '',
    });
  });

  it('defaults the scheme to https:// when absent', () => {
    expect(splitURL('example.com/x')).toEqual({
      host: 'https://example.com',
      path: '/x',
    });
  });

  it('path-only input → empty host, path kept', () => {
    expect(splitURL('/x/y')).toEqual({ host: '', path: '/x/y' });
    // relative segments lose directory context (cleanuri quirk, :169-172)
    expect(splitURL('next/page.html')).toEqual({
      host: '',
      path: '/next/page.html',
    });
    expect(splitURL('./rel')).toEqual({ host: '', path: '/rel' });
  });

  it('protocol-relative input carries no scheme into host', () => {
    expect(splitURL('//cdn.example.com/x')).toEqual({
      host: 'https://cdn.example.com',
      path: '/x',
    });
  });

  it('empty input → empty split', () => {
    expect(splitURL('')).toEqual({ host: '', path: '' });
  });
});

describe('http-url: resolveRedirectLocation (:649-671, R-LOC2)', () => {
  it('absolute Location wins entirely', () => {
    expect(
      resolveRedirectLocation('http://127.0.0.1:1/a', 'http://other.example.com:2/b'),
    ).toBe('http://other.example.com:2/b');
  });

  it('path Location merges onto the current URL host (:653-661)', () => {
    expect(
      resolveRedirectLocation('http://127.0.0.1:1/a/b', '/c?d=1'),
    ).toBe('http://127.0.0.1:1/c?d=1');
    expect(
      resolveRedirectLocation(
        'https://example.com/dir/page',
        'other/page.html',
      ),
    ).toBe('https://example.com/other/page.html'); // directory context dropped (quirk)
  });

  it('protocol-relative Location keeps the redirect target host', () => {
    expect(
      resolveRedirectLocation('http://127.0.0.1:1/a', '//other.example.com/x'),
    ).toBe('https://other.example.com/x');
  });

  it('empty Location keeps the current URL (re-request)', () => {
    expect(resolveRedirectLocation('http://127.0.0.1:1/a', '')).toBe(
      'http://127.0.0.1:1/a',
    );
  });
});
