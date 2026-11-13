import { describe, expect, it } from 'vitest';
import { RecordedResponseResolver } from '../../../src/engine/shims/http-shim.js';
import { RecordedHttpTransport } from '../../../src/engine/shims/http-transport.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import { CookieStore, CookieJar } from '../../../src/engine/shims/http-cookies.js';
import { HttpPipeline } from '../../../src/engine/shims/http-pipeline.js';
import { SyncHostGate } from '../../../src/engine/shims/http-hostgate.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { gzipSync, brotliCompressSync } from 'node:zlib';

/**
 * Pipeline unit tests over the recorded transport (offline). Contract →
 * test matrix (source truth httpsendthread.pas unless noted):
 * | Row      | Contract                                            | Test                                      |
 * |----------|------------------------------------------------------|-------------------------------------------|
 * | R-REQ1   | Request(method,url) dispatch, unknown method ⇒ GET   | Request dispatch                          |
 * | R-RED1   | 301/302/303/307 followed AS GET                      | redirect method rewrite                   |
 * | R-RED2   | max 5 redirects default; exceeding fails (Result=false, code=30x) | redirect cap                 |
 * | R-RED3   | Referer = pre-redirect URL added once                | Referer header capture                    |
 * | R-RED4   | FollowRedirection=false stops                        | FollowRedirection off                     |
 * | R-RET1   | retry on >500, no delay, bounded by RetryCount       | retry bounds + attempt counting           |
 * | R-RET2   | RetryCount default 0 ⇒ single attempt                | default single attempt                    |
 * | R-RET3   | AllowServerErrorResponse=true passes 5xx through     | 5xx passthrough                           |
 * | R-OK1    | success ⇔ Document.Size > 0 (:717)                   | empty body ⇒ false; body ⇒ true; HEAD     |
 * | R-DEC1   | Content-Encoding decompression (gzip here; D13 zstd policy in headers tests) | gzip decode |
 * | R-TERM1  | Terminated before request ⇒ fail fast, nothing sent  | pre-aborted request                       |
 * | R-TERM2  | queued-but-unstarted requests fail fast on abort     | gate-held slot + pre-abort                |
 * | R-EG1    | egress hook denies private targets before send       | egress deny stops the request             |
 * | R-HOP1   | response headers replace request Headers; Location readable | response header state              |
 * | R-HOP2   | MimeType ← response Content-Type (default text/html) | MimeType per hop                          |
 * | R-QUIRK1 | first header line 'HTTP/…' triggers Reset (:618-620) | HTTP/ reset quirk                        |
 */

describe('http-pipeline', () => {
  const BASE = 'http://mock.test';

function make(entries: ConstructorParameters<typeof RecordedResponseResolver>[0], opts?: { terminated?: boolean; gate?: SyncHostGate; consume?: boolean }) {
  const resolver = new RecordedResponseResolver(
    entries,
    opts?.consume !== undefined ? { consume: opts.consume } : {},
  );
  const abort = new DeadlineAbortHandle(createDeadlineCells());
  if (opts?.terminated === true) {
    abort.abort('test');
  }
  const pipeline = new HttpPipeline({
    transport: new RecordedHttpTransport((m, u, b, mt, h) => resolver.resolve(m, u, b, mt, h)),
    egress: new EgressPolicy({ allow: [] }),
    cookies: new CookieStore(new CookieJar()),
    ...(opts?.gate !== undefined ? { gate: opts.gate } : {}),
    isTerminated: () => abort.terminated,
  });
  return { pipeline, resolver, abort };
}

  describe('request dispatch (R-REQ1)', () => {
    it('Request() uppercases the method and dispatches', () => {
      const { pipeline } = make([
        { url: `${BASE}/a`, status: 200, body: 'A', method: 'PUT' },
      ]);
      expect(pipeline.request('put', `${BASE}/a`)).toBe(true);
      expect(pipeline.resultCode).toBe(200);
    });

    it('empty method ⇒ GET; unknown method passes through', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/a`, status: 200, body: 'x' },
      ]);
      expect(pipeline.request('', `${BASE}/a`)).toBe(true);
      expect(resolver.requests[0]?.method).toBe('GET');
      expect(pipeline.request('DELETE', `${BASE}/a`)).toBe(true);
      expect(resolver.requests[1]?.method).toBe('DELETE');
    });

    it('URL massaging applies on every request method (strip :/ + scheme)', () => {
      const { pipeline, resolver } = make([
        { url: `https://${'mock.test'}/m`, status: 200, body: 'x' },
      ]);
      expect(pipeline.get(`://mock.test/m`)).toBe(true);
      expect(resolver.requests[0]?.url).toBe('https://mock.test/m');
    });
  });

  describe('redirects (R-RED1..R-RED4)', () => {
    it.each([301, 302, 303, 307])('%i is followed AS GET with Referer', (status) => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/start`, status, body: '', headers: { Location: `${BASE}/final` } },
        { url: `${BASE}/final`, status: 200, body: 'final-body' },
      ]);
      expect(pipeline.get(`${BASE}/start`)).toBe(true);
      const final = resolver.requests.find((r) => r.url === `${BASE}/final`);
      expect(final?.method).toBe('GET');
      expect(final?.headers['Referer']).toBe(`${BASE}/start`);
      expect(pipeline.resultCode).toBe(200);
      expect(pipeline.lastURL).toBe(`${BASE}/final`);
    });

    it('304 is not followed (ResultCode-300 ∉ {1,2,3,7})', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/s`, status: 304, body: '', headers: { Location: `${BASE}/f` } },
      ]);
      expect(pipeline.get(`${BASE}/s`)).toBe(false);
      expect(resolver.requests).toHaveLength(1);
      expect(pipeline.resultCode).toBe(304);
    });

    it('caps at MaxRedirect (5 default) and fails with the redirect code', () => {
      const entries = [];
      for (let i = 0; i < 8; i++) {
        entries.push({
          url: `${BASE}/r${i}`,
          status: 302,
          body: '',
          headers: { Location: `${BASE}/r${i + 1}` },
        });
      }
      const { pipeline, resolver } = make(entries);
      expect(pipeline.get(`${BASE}/r0`)).toBe(false);
      expect(resolver.requests).toHaveLength(6); // 5 redirects + 1
      expect(pipeline.resultCode).toBe(302);
    });

    it('a custom MaxRedirect raises the cap', () => {
      const entries = [];
      for (let i = 0; i < 8; i++) {
        entries.push({
          url: `${BASE}/r${i}`,
          status: 302,
          body: '',
          headers: { Location: `${BASE}/r${i + 1}` },
        });
      }
      entries.push({ url: `${BASE}/r8`, status: 200, body: 'landed' });
      const { pipeline } = make(entries);
      pipeline.maxRedirect = 8;
      expect(pipeline.get(`${BASE}/r0`)).toBe(true);
    });

    it('FollowRedirection=false stops immediately', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/s`, status: 302, body: '', headers: { Location: `${BASE}/f` } },
      ]);
      pipeline.followRedirection = false;
      expect(pipeline.get(`${BASE}/s`)).toBe(false);
      expect(resolver.requests).toHaveLength(1);
      expect(pipeline.resultCode).toBe(302);
    });

    it('relative Location merges onto the current host', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/dir/page`, status: 302, body: '', headers: { Location: '/next' } },
        { url: `${BASE}/next`, status: 200, body: 'ok' },
      ]);
      expect(pipeline.get(`${BASE}/dir/page`)).toBe(true);
      expect(resolver.requests.some((r) => r.url === `${BASE}/next`)).toBe(true);
    });

    it('Referer is added once (the snapshot keeps it for later hops)', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/s`, status: 302, body: '', headers: { Location: `${BASE}/m` } },
        { url: `${BASE}/m`, status: 302, body: '', headers: { Location: `${BASE}/f` } },
        { url: `${BASE}/f`, status: 200, body: 'ok' },
      ]);
      expect(pipeline.get(`${BASE}/s`)).toBe(true);
      expect(resolver.requests.find((r) => r.url === `${BASE}/m`)?.headers['Referer']).toBe(`${BASE}/s`);
      expect(resolver.requests.find((r) => r.url === `${BASE}/f`)?.headers['Referer']).toBe(`${BASE}/s`);
    });

    it('POST redirects to GET (R-RED1 with POST)', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/post`, status: 303, body: '', headers: { Location: `${BASE}/done` } },
        { url: `${BASE}/done`, status: 200, body: 'done' },
      ]);
      expect(pipeline.post(`${BASE}/post`, 'a=1')).toBe(true);
      expect(resolver.requests.find((r) => r.url === `${BASE}/done`)?.method).toBe('GET');
    });
  });

  describe('retry (R-RET1..R-RET3)', () => {
    it('RetryCount default 0 ⇒ single attempt on 503', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/flaky`, status: 503, body: '' },
      ]);
      expect(pipeline.get(`${BASE}/flaky`)).toBe(false);
      expect(resolver.requests).toHaveLength(1);
      expect(pipeline.resultCode).toBe(503);
    });

    it('retries >500 bounded by RetryCount, no delay, then succeeds', () => {
      const { pipeline, resolver } = make(
        [
          { url: `${BASE}/rec`, status: 502, body: '' },
          { url: `${BASE}/rec`, status: 503, body: '' },
          { url: `${BASE}/rec`, status: 200, body: 'finally' },
        ],
        { consume: true },
      );
      pipeline.retryCount = 2;
      const started = Date.now();
      expect(pipeline.get(`${BASE}/rec`)).toBe(true);
      expect(resolver.requests).toHaveLength(3);
      expect(Date.now() - started).toBeLessThan(500); // no delay
      expect(pipeline.resultCode).toBe(200);
    });

    it('exactly-500 does not trigger the retry loop (ResultCode > 500 is strict)', () => {
      const { pipeline, resolver } = make([{ url: `${BASE}/e500`, status: 500, body: '' }]);
      pipeline.retryCount = 3;
      expect(pipeline.get(`${BASE}/e500`)).toBe(false);
      expect(resolver.requests).toHaveLength(1);
      expect(pipeline.resultCode).toBe(500);
    });

    it('exhausting RetryCount leaves the >500 code in place', () => {
      const { pipeline, resolver } = make(
        [
          { url: `${BASE}/bad`, status: 502, body: '' },
          { url: `${BASE}/bad`, status: 503, body: '' },
          { url: `${BASE}/bad`, status: 504, body: '' },
        ],
        { consume: true },
      );
      pipeline.retryCount = 2; // 3 attempts
      expect(pipeline.get(`${BASE}/bad`)).toBe(false);
      expect(resolver.requests).toHaveLength(3);
      expect(pipeline.resultCode).toBe(504);
    });

    it('4xx is never retried', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/nf`, status: 404, body: '' },
      ]);
      pipeline.retryCount = 3;
      expect(pipeline.get(`${BASE}/nf`)).toBe(false);
      expect(resolver.requests).toHaveLength(1);
    });

    it('AllowServerErrorResponse=true passes 5xx through without retry', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/err`, status: 503, body: 'server-body' },
      ]);
      pipeline.allowServerErrorResponse = true;
      expect(pipeline.get(`${BASE}/err`)).toBe(true); // body > 0 ⇒ success
      expect(resolver.requests).toHaveLength(1);
      expect(pipeline.document.toString()).toBe('server-body');
    });

    it('each redirect hop gets a fresh retry budget', () => {
      const { pipeline, resolver } = make(
        [
          { url: `${BASE}/s`, status: 302, body: '', headers: { Location: `${BASE}/t` } },
          { url: `${BASE}/t`, status: 503, body: '' },
          { url: `${BASE}/t`, status: 200, body: 'ok' },
        ],
        { consume: true },
      );
      pipeline.retryCount = 1;
      expect(pipeline.get(`${BASE}/s`)).toBe(true);
      expect(resolver.requests.filter((r) => r.url === `${BASE}/t`)).toHaveLength(2);
    });
  });

  describe('success semantics (R-OK1)', () => {
    it('empty 200 body ⇒ false', () => {
      const { pipeline } = make([{ url: `${BASE}/empty`, status: 200, body: '' }]);
      expect(pipeline.get(`${BASE}/empty`)).toBe(false);
      expect(pipeline.resultCode).toBe(200);
    });

    it('non-empty body ⇒ true', () => {
      const { pipeline } = make([{ url: `${BASE}/body`, status: 200, body: 'x' }]);
      expect(pipeline.get(`${BASE}/body`)).toBe(true);
    });

    it('HEAD succeeds with ResultCode but no body ⇒ false (parity quirk)', () => {
      const { pipeline } = make([{ url: `${BASE}/h`, status: 200, body: '' }]);
      expect(pipeline.head(`${BASE}/h`)).toBe(false);
      expect(pipeline.resultCode).toBe(200);
    });
  });

  describe('decompression (R-DEC1)', () => {
    it('gzip Content-Encoding is decoded into the Document', () => {
      const gz = gzipSync(Buffer.from('compressed-payload'));
      const pipeline = new HttpPipeline({
        transport: {
          send: () => ({
            ok: true,
            error: '',
            status: 200,
            statusText: 'OK',
            headers: [['Content-Encoding', 'gzip'] as const],
            setCookie: [],
            body: new Uint8Array(gz),
          }),
        },
        egress: new EgressPolicy({ allow: [] }),
        cookies: new CookieStore(new CookieJar()),
        isTerminated: () => false,
      });
      expect(pipeline.get(`${BASE}/gz`)).toBe(true);
      expect(pipeline.document.toString()).toBe('compressed-payload');
    });

    it('brotli Content-Encoding is decoded into the Document (gzip/deflate/brotli parity)', () => {
      const br = brotliCompressSync(Buffer.from('brotli-payload'));
      const pipeline = new HttpPipeline({
        transport: {
          send: () => ({
            ok: true,
            error: '',
            status: 200,
            statusText: 'OK',
            headers: [['Content-Encoding', 'br'] as const],
            setCookie: [],
            body: new Uint8Array(br),
          }),
        },
        egress: new EgressPolicy({ allow: [] }),
        cookies: new CookieStore(new CookieJar()),
        isTerminated: () => false,
      });
      expect(pipeline.get(`${BASE}/br`)).toBe(true);
      expect(pipeline.document.toString()).toBe('brotli-payload');
    });
  });

  describe('termination (R-TERM1/R-TERM2)', () => {
    it('pre-aborted request fails fast without sending (R-TERM1)', () => {
      const { pipeline, resolver } = make(
        [{ url: `${BASE}/x`, status: 200, body: 'x' }],
        { terminated: true },
      );
      expect(pipeline.get(`${BASE}/x`)).toBe(false);
      expect(resolver.requests).toHaveLength(0);
    });

    it('Terminated mid-run stops between hops', () => {
      const { pipeline, resolver, abort } = make([
        { url: `${BASE}/s`, status: 302, body: '', headers: { Location: `${BASE}/f` } },
        { url: `${BASE}/f`, status: 302, body: '', headers: { Location: `${BASE}/g` } },
        { url: `${BASE}/g`, status: 200, body: 'x' },
      ]);
      const originalSend = resolver.resolve.bind(resolver);
      resolver.resolve = (...args) => {
        if (args[1] === `${BASE}/f`) {
          abort.abort('mid-run'); // abort lands before the third hop sends
        }
        return originalSend(...args);
      };
      expect(pipeline.get(`${BASE}/s`)).toBe(false);
      expect(resolver.requests.some((r) => r.url === `${BASE}/g`)).toBe(false);
    });

    it('queued-but-unstarted requests fail fast on abort (R-TERM2)', () => {
      // gate at limit 1 with the slot pre-held: the pipeline is "queued";
      // aborting before the send must fail fast (nothing hits the wire)
      const gate = new SyncHostGate({ limit: 1, chunkMs: 5 });
      const held = gate.acquire(`${BASE}/q`, () => false);
      expect(held).not.toBeNull();
      const { pipeline, resolver } = make(
        [{ url: `${BASE}/q`, status: 200, body: 'x' }],
        { terminated: true, gate },
      );
      const started = Date.now();
      expect(pipeline.get(`${BASE}/q`)).toBe(false);
      expect(Date.now() - started).toBeLessThan(50);
      expect(resolver.requests).toHaveLength(0);
      held?.();
    });
  });

  describe('egress hook (R-EG1)', () => {
    it('private target denied before any send', () => {
      const { pipeline, resolver } = make([{ url: 'http://10.0.0.9/x', status: 200, body: 'x' }]);
      expect(pipeline.get('http://10.0.0.9/x')).toBe(false);
      expect(resolver.requests).toHaveLength(0);
      expect(pipeline.resultString).toContain('10.0.0.9');
    });

    it('denied redirect targets stop the chain', () => {
      const { pipeline, resolver } = make([
        { url: `${BASE}/s`, status: 302, body: '', headers: { Location: 'http://192.168.0.5/x' } },
      ]);
      expect(pipeline.get(`${BASE}/s`)).toBe(false);
      expect(resolver.requests).toHaveLength(1);
    });
  });

  describe('per-hop response state (R-HOP1/R-HOP2/R-QUIRK1)', () => {
    it('response headers replace request Headers (Location readable)', () => {
      const { pipeline } = make([
        { url: `${BASE}/s`, status: 302, body: '', headers: { Location: `${BASE}/f` } },
        { url: `${BASE}/f`, status: 200, body: 'ok', headers: { 'X-Tag': 'resp' } },
      ]);
      pipeline.headers.set('X-Custom', 'req');
      expect(pipeline.get(`${BASE}/s`)).toBe(true);
      expect(pipeline.headers.get('X-Custom')).toBe('');
      expect(pipeline.headers.get('X-Tag')).toBe('resp');
    });

    it('MimeType follows the response Content-Type; default text/html when absent', () => {
      const { pipeline } = make([
        { url: `${BASE}/json`, status: 200, body: '{}', headers: { 'Content-Type': 'application/json' } },
      ]);
      expect(pipeline.get(`${BASE}/json`)).toBe(true);
      expect(pipeline.mimeType).toBe('application/json');
    });

    it('no received Content-Type ⇒ MimeType stays the text/html default', () => {
      const pipeline = new HttpPipeline({
        transport: {
          send: () => ({
            ok: true,
            error: '',
            status: 200,
            statusText: 'OK',
            headers: [] as ReadonlyArray<readonly [string, string]>,
            setCookie: [],
            body: new Uint8Array(Buffer.from('plain')),
          }),
        },
        egress: new EgressPolicy({ allow: [] }),
        cookies: new CookieStore(new CookieJar()),
        isTerminated: () => false,
      });
      expect(pipeline.get(`${BASE}/plain`)).toBe(true);
      expect(pipeline.mimeType).toBe('text/html');
    });

    it("first header line 'HTTP/…' triggers Reset (:618-620 quirk)", () => {
      const { pipeline, resolver } = make([{ url: `${BASE}/x`, status: 200, body: 'x' }]);
      pipeline.headers.clear();
      pipeline.headers.set('HTTP/1.1 200 OK', '');
      pipeline.headers.set('X-Keep', 'nope');
      expect(pipeline.get(`${BASE}/x`)).toBe(true);
      // the REQUEST carried the Reset default set, not the manual lines
      expect(resolver.requests[0]?.headers['DNT']).toBe('1');
      expect(resolver.requests[0]?.headers['X-Keep']).toBeUndefined();
    });
  });

  describe('POST normalization on the pipeline (R-POST)', () => {
    it('body rides in Document; Content-Type moves out of Headers into the request', () => {
      const { pipeline, resolver } = make([{ url: `${BASE}/p`, status: 200, body: 'ok' }]);
      pipeline.headers.set('Content-Type', 'application/json');
      expect(pipeline.post(`${BASE}/p`, 'q=1')).toBe(true);
      const req = resolver.requests[0];
      expect(req?.body).toBe('q=1');
      expect(req?.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('host gate (per-host limits + delays)', () => {
    it('start-interval delay spaces consecutive starts to one host', () => {
      const gate = new SyncHostGate({ delayMs: 60, chunkMs: 10 });
      const { pipeline, resolver } = make(
        [
          { url: `${BASE}/d1`, status: 200, body: '1' },
          { url: `${BASE}/d2`, status: 200, body: '2' },
        ],
        { gate },
      );
      const started = Date.now();
      expect(pipeline.get(`${BASE}/d1`)).toBe(true);
      expect(pipeline.get(`${BASE}/d2`)).toBe(true);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(resolver.requests).toHaveLength(2);
    });

    it('limit 0 (default) never gates', () => {
      const gate = new SyncHostGate({});
      const { pipeline } = make([{ url: `${BASE}/u`, status: 200, body: 'u' }], { gate });
      expect(pipeline.get(`${BASE}/u`)).toBe(true);
      expect(gate.activeFor(`${BASE}/u`)).toBe(0);
    });
  });
});
