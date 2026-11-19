/**
 * Site-availability classification unit (dead-site discovery): the ONE
 * conservative classifier every traffic path + the manual Check probe
 * share. Table-driven over the §5.2 readback surface
 * (HTTP.ResultCode/ResultString):
 *  - transport-class failures (the pipeline's synthetic 500 + transport
 *    error text) and the real 5xx/523 family → unreachable + reason;
 *  - 2xx/3xx → reachable;
 *  - 4xx / 0 / unreadable → NO verdict (record unchanged);
 *  - the engine's own policy refusals (loopback gating etc.) are
 *    platform, never site health → NO verdict even at code 500.
 */
import { describe, expect, it } from 'vitest';
import { classifyHttpOutcome, readHttpOutcome } from '../../../src/engine/services/availability.js';
import { runRootUrlProbe } from '../../../src/engine/services/availability.js';
import { ApiError } from '@fmd/contract';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import type { HttpTransportPort, RawHttpRequest, RawHttpResult } from '../../../src/engine/shims/http-transport.js';
import type { RegistrationRecord } from '../../../src/engine/registry/capabilities.js';

const MODULE_ID = 'd'.repeat(32);

function okResult(status: number, statusText: string, body = '<html><body>x</body></html>'): RawHttpResult {
  return {
    ok: true,
    error: '',
    status,
    statusText,
    headers: [['Content-Type', 'text/html']],
    setCookie: [],
    body: new TextEncoder().encode(body),
  };
}

function failResult(error: string): RawHttpResult {
  return { ok: false, error, status: 0, statusText: '', headers: [], setCookie: [], body: new Uint8Array(0) };
}

function scriptedTransport(results: RawHttpResult[]): HttpTransportPort & { requests: RawHttpRequest[] } {
  const requests: RawHttpRequest[] = [];
  let index = 0;
  return {
    requests,
    send(request: RawHttpRequest): RawHttpResult {
      requests.push(request);
      const result = results[Math.min(index, results.length - 1)] ?? failResult('exhausted');
      index += 1;
      return result;
    },
  };
}

function registration(rootURL: string): RegistrationRecord {
  return {
    id: MODULE_ID,
    name: 'ProbeTarget',
    rootURL,
    category: 'English',
    accountSupport: false,
    options: [],
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: [],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
    file: 'ProbeTarget.lua',
  };
}

describe('classifyHttpOutcome (the one conservative seam)', (): void => {
  it('transport-class failures → unreachable + the transport reason', (): void => {
    expect(classifyHttpOutcome(500, 'timeout after 15000ms')).toEqual({
      verdict: 'unreachable',
      reason: 'timeout after 15000ms',
    });
    expect(classifyHttpOutcome(500, 'getaddrinfo ENOTFOUND mangapark.me')).toEqual({
      verdict: 'unreachable',
      reason: 'getaddrinfo ENOTFOUND mangapark.me',
    });
    expect(classifyHttpOutcome(500, 'connect ECONNREFUSED 127.0.0.1:443')).toEqual({
      verdict: 'unreachable',
      reason: 'connect ECONNREFUSED 127.0.0.1:443',
    });
    expect(classifyHttpOutcome(500, 'unable to verify the first certificate')).toEqual({
      verdict: 'unreachable',
      reason: 'unable to verify the first certificate',
    });
  });

  it('the HTTP 5xx/523 family → unreachable (Cloudflare origin-unreachable included)', (): void => {
    expect(classifyHttpOutcome(523, 'Origin Unreachable')).toEqual({
      verdict: 'unreachable',
      reason: 'Origin Unreachable',
    });
    expect(classifyHttpOutcome(503, 'Service Temporarily Unavailable')).toEqual({
      verdict: 'unreachable',
      reason: 'Service Temporarily Unavailable',
    });
    expect(classifyHttpOutcome(500, '')).toEqual({ verdict: 'unreachable', reason: 'HTTP 500' });
  });

  it('long reasons are capped (a short string, never a stack)', (): void => {
    const outcome = classifyHttpOutcome(500, 'x'.repeat(500));
    expect(outcome).toBeDefined();
    expect((outcome?.reason ?? '').length).toBeLessThanOrEqual(160);
  });

  it('2xx/3xx → reachable (the self-healing direction)', (): void => {
    expect(classifyHttpOutcome(200, 'OK')).toEqual({ verdict: 'reachable' });
    expect(classifyHttpOutcome(204, 'No Content')).toEqual({ verdict: 'reachable' });
    expect(classifyHttpOutcome(302, 'Found')).toEqual({ verdict: 'reachable' });
  });

  it('HTTP 4xx → NO verdict (origin alive but possibly blocking — record untouched)', (): void => {
    expect(classifyHttpOutcome(403, 'Forbidden')).toBeUndefined();
    expect(classifyHttpOutcome(429, 'Too Many Requests')).toBeUndefined();
    // the parked-domain live flavor: a 405 lander is an ALIVE origin
    expect(classifyHttpOutcome(405, 'Method Not Allowed')).toBeUndefined();
  });

  it('code 0 / unreadable → NO verdict (abort, egress deny, no HTTP use)', (): void => {
    expect(classifyHttpOutcome(0, '')).toBeUndefined();
    expect(classifyHttpOutcome(Number.NaN, 'x')).toBeUndefined();
  });

  it('engine policy refusals never mark a site dead (platform, not origin)', (): void => {
    expect(classifyHttpOutcome(500, 'loopback transport refuses non-loopback host: example.org')).toBeUndefined();
    expect(classifyHttpOutcome(500, 'transport supports http/https only: ftp://x')).toBeUndefined();
    expect(classifyHttpOutcome(500, 'response exceeds the loopback result buffer')).toBeUndefined();
  });
});

describe('readHttpOutcome (the §5.2 readback seam, factored)', (): void => {
  it('reads ResultCode/ResultString when the HTTP global survives', (): void => {
    const read = readHttpOutcome((code: string): unknown =>
      code === 'return HTTP.ResultCode' ? 523 : 'Origin Unreachable',
    );
    expect(read).toEqual({ resultCode: 523, resultString: 'Origin Unreachable' });
  });

  it('a module that never touched HTTP reads non-numeric → undefined (nil global)', (): void => {
    expect(readHttpOutcome((): unknown => undefined)).toBeUndefined();
  });

  it('a Lua nil reading as Number 0 abstains downstream (the classifier never writes on 0)', (): void => {
    // engines may surface nil as null — Number(null) === 0, a finite
    // but meaningless code: the READBACK yields it, the CLASSIFIER
    // abstains (0 is neither 2xx/3xx nor >= 500).
    expect(readHttpOutcome((): unknown => null)).toEqual({ resultCode: 0, resultString: '' });
    expect(classifyHttpOutcome(0, '')).toBeUndefined();
  });

  it('a throwing engine read is best-effort undefined, never a crash', (): void => {
    expect(readHttpOutcome((): unknown => {
      throw new Error('engine disposed');
    })).toBeUndefined();
  });
});

describe('runRootUrlProbe (the manual Check probe mechanism)', (): void => {
  const egress = new EgressPolicy({ allow: ['*'] });

  it('2xx answer returns the raw outcome for the caller to classify reachable', (): void => {
    const transport = scriptedTransport([okResult(200, 'OK')]);
    const probe = runRootUrlProbe({
      transport,
      egress,
      modules: [registration('https://alive.test/')],
      moduleId: MODULE_ID,
    });
    expect(probe.resultCode).toBe(200);
    expect(classifyHttpOutcome(probe.resultCode, probe.resultString)).toEqual({ verdict: 'reachable' });
    // module-appropriate posture: the engine UA + Referer = RootURL
    const sent = transport.requests[0];
    expect(sent?.headers['Referer']).toBe('https://alive.test/');
    expect(typeof sent?.headers['User-Agent'] === 'string' && sent.headers['User-Agent'] !== '').toBe(true);
  });

  it('transport failure returns the synthetic 500 + transport text', (): void => {
    const probe = runRootUrlProbe({
      transport: scriptedTransport([failResult('connect ECONNREFUSED 127.0.0.1:9')]),
      egress,
      modules: [registration('https://dead.test/')],
      moduleId: MODULE_ID,
    });
    expect(probe.resultCode).toBe(500);
    expect(probe.resultString).toBe('connect ECONNREFUSED 127.0.0.1:9');
    expect(classifyHttpOutcome(probe.resultCode, probe.resultString)?.verdict).toBe('unreachable');
  });

  it('a 523-with-body origin reads its status line (Cloudflare family)', (): void => {
    const probe = runRootUrlProbe({
      transport: scriptedTransport([okResult(523, 'Origin Unreachable', '<html>cf error</html>')]),
      egress,
      modules: [registration('https://slow.test/')],
      moduleId: MODULE_ID,
    });
    expect(probe.resultCode).toBe(523);
    expect(classifyHttpOutcome(probe.resultCode, probe.resultString)?.verdict).toBe('unreachable');
  });

  it('a 403 anti-bot answer stays a no-verdict 4xx', (): void => {
    const probe = runRootUrlProbe({
      transport: scriptedTransport([okResult(403, 'Forbidden', '<html>challenge</html>')]),
      egress,
      modules: [registration('https://guarded.test/')],
      moduleId: MODULE_ID,
    });
    expect(probe.resultCode).toBe(403);
    expect(classifyHttpOutcome(probe.resultCode, probe.resultString)).toBeUndefined();
  });

  it('unknown module → the typed 404 envelope', (): void => {
    expect((): unknown =>
      runRootUrlProbe({
        transport: scriptedTransport([]),
        egress,
        modules: [registration('https://x.test/')],
        moduleId: 'f'.repeat(32),
      }),
    ).toThrow(expect.objectContaining({ status: 404, code: 'not_found' }) as unknown as ApiError);
  });

  it('a non-http(s) RootURL → the typed 400 (nothing to probe)', (): void => {
    expect((): unknown =>
      runRootUrlProbe({
        transport: scriptedTransport([]),
        egress,
        modules: [registration('ftp://x.test/')],
        moduleId: MODULE_ID,
      }),
    ).toThrow(expect.objectContaining({ status: 400, code: 'validation_error' }) as unknown as ApiError);
  });
});
