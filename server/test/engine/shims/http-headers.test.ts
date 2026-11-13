import { describe, expect, it } from 'vitest';
import {
  ACCEPT_IMAGE_VALUE,
  NameValueMap,
  applyAcceptImage,
  composeReset,
  composeResetBasic,
  moveContentTypeToMimeType,
} from '../../../src/engine/shims/http-headers.js';

/**
 * Default header-set composition unit tests (DESIGN §5.4 "Default header
 * sets", Round-2 M3). Contract → test matrix (source truth
 * httpsendthread.pas):
 * | Row     | Contract                                          | Source   | Test                                        |
 * |---------|----------------------------------------------------|----------|---------------------------------------------|
 * | R-HDR1  | Reset: DNT=1, Upgrade-Insecure-Requests=1, Accept, | :924-932 | Reset set has the exact five headers        |
 * |         | Accept-Language, Accept-Charset (exact values)     |          |                                             |
 * | R-HDR2  | ResetBasic: clears, Compress ⇒ Accept-Encoding     | :944-954 | ResetBasic clears + Accept-Encoding per D13 |
 * |         | (gzip, deflate, br — zstd omitted per D13)         |          |                                             |
 * | R-HDR3  | AcceptImage: Accept set to "image/webp; all"       | :919-922 | AcceptImage swaps Accept                    |
 * | R-HDR4  | Headers/Cookies case-insensitive Values get/set    | ctor :556| NameValueMap case-insensitivity             |
 * | R-POST1 | POST moves Content-Type from Headers into MimeType | :730-741 | moveContentTypeToMimeType moves             |
 * | R-POST2 | MimeType text/html becomes urlencoded; charset=UTF-8 | :743-745 | moveContentTypeToMimeType rewrites        |
 */

describe('http-headers: Reset set (:924-932, R-HDR1)', () => {
  it('composes the exact five default headers', () => {
    const h = new NameValueMap();
    h.set('X-Leftover', '1'); // Reset clears first (via ResetBasic)
    composeReset(h, false);
    expect(h.get('DNT')).toBe('1');
    expect(h.get('Upgrade-Insecure-Requests')).toBe('1');
    expect(h.get('Accept')).toBe(
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    );
    expect(h.get('Accept-Language')).toBe('en-US,en;q=0.5');
    expect(h.get('Accept-Charset')).toBe('utf-8');
    expect(h.get('X-Leftover')).toBe('');
    expect(h.get('Accept-Encoding')).toBe('');
  });

  it('with Compress on, Accept-Encoding rides in (:953 minus zstd per D13)', () => {
    const h = new NameValueMap();
    composeReset(h, true);
    expect(h.get('Accept-Encoding')).toBe('gzip, deflate, br');
  });
});

describe('http-headers: ResetBasic (:944-954, R-HDR2)', () => {
  it('clears previous headers entirely', () => {
    const h = new NameValueMap();
    h.set('DNT', '1');
    h.set('Referer', 'https://x');
    composeResetBasic(h, false);
    expect(h.get('DNT')).toBe('');
    expect(h.get('Referer')).toBe('');
    expect(h.size).toBe(0);
  });

  it('Compress on ⇒ Accept-Encoding: gzip, deflate, br (D13: zstd omitted)', () => {
    const h = new NameValueMap();
    composeResetBasic(h, true);
    expect(h.get('Accept-Encoding')).toBe('gzip, deflate, br');
    expect(h.get('Accept-Encoding')).not.toContain('zstd');
  });

  it('Compress off ⇒ no Accept-Encoding', () => {
    const h = new NameValueMap();
    composeResetBasic(h, false);
    expect(h.get('Accept-Encoding')).toBe('');
  });
});

describe('http-headers: AcceptImage (:919-922, R-HDR3)', () => {
  it('swaps Accept to image/webp,*/*', () => {
    const h = new NameValueMap();
    composeReset(h, false);
    applyAcceptImage(h);
    expect(h.get('Accept')).toBe(ACCEPT_IMAGE_VALUE);
    expect(h.get('Accept')).toBe('image/webp,*/*');
    expect(h.get('DNT')).toBe('1'); // the rest of the set survives
  });
});

describe('http-headers: case-insensitive Values (R-HDR4)', () => {
  it('get/set/remove are case-insensitive (last writer wins)', () => {
    const h = new NameValueMap();
    h.set('Content-Type', 'text/html');
    expect(h.get('content-type')).toBe('text/html');
    expect(h.get('CONTENT-TYPE')).toBe('text/html');
    h.set('content-type', 'application/json');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.size).toBe(1);
    h.remove('CONTENT-TYPE');
    expect(h.size).toBe(0);
  });

  it('snapshot preserves insertion order for indexed reads', () => {
    const h = new NameValueMap();
    h.set('B', '2');
    h.set('A', '1');
    expect(h.snapshot()).toEqual({ B: '2', A: '1' });
  });

  it('missing names read as empty string (TStrings.Values semantics)', () => {
    const h = new NameValueMap();
    expect(h.get('nope')).toBe('');
  });
});

describe('http-headers: POST Content-Type move (:730-745, R-POST1/R-POST2)', () => {
  it('moves Content-Type from Headers into MimeType and deletes the header', () => {
    const h = new NameValueMap();
    h.set('Accept', 'text/html');
    h.set('Content-Type', 'application/json');
    const mimeType = moveContentTypeToMimeType(h, 'text/html');
    expect(mimeType).toBe('application/json');
    expect(h.get('Content-Type')).toBe('');
    expect(h.get('Accept')).toBe('text/html');
  });

  it('without a Content-Type header, MimeType stays untouched', () => {
    const h = new NameValueMap();
    h.set('Accept', 'text/html');
    const mimeType = moveContentTypeToMimeType(h, 'application/xml');
    expect(mimeType).toBe('application/xml');
    expect(h.get('Content-Type')).toBe('');
  });

  it("rewrites exactly 'text/html' to urlencoded; charset=UTF-8 (:743-745)", () => {
    const h = new NameValueMap();
    h.set('Content-Type', 'text/html');
    expect(moveContentTypeToMimeType(h, '')).toBe(
      'application/x-www-form-urlencoded; charset=UTF-8',
    );
  });

  it("does not rewrite 'text/html; charset=...' (exact Pascal string compare)", () => {
    const h = new NameValueMap();
    h.set('Content-Type', 'text/html; charset=utf-8');
    expect(moveContentTypeToMimeType(h, '')).toBe('text/html; charset=utf-8');
  });
});
