import { describe, expect, it } from 'vitest';
import { listSeedModules, rotateSample, utcDayNumber } from '../../tools/smoke/rotation.js';
import {
  buildCurlArgs,
  parseHeaderDump,
  LiveResponseResolver,
  DEFAULT_LIVE_OPTIONS,
} from '../../tools/smoke/live-resolver.js';
import { parseArgs, type SmokeCliArgs } from '../../tools/smoke/run.js';
import { runSmokeModules, locateModuleFile, type SmokeRunOptions } from '../../tools/smoke/smoke.js';
import { FMD2_LUA_ROOT } from '../../src/engine/shims/install.js';

/**
 * Nightly smoke harness unit tests (all OFFLINE — no resolver is ever
 * invoked; the network gate itself is asserted). Contract → test matrix:
 * | Row     | Contract                                                   | Test                                  |
 * |---------|------------------------------------------------------------|---------------------------------------|
 * | R-SMK1  | rotating window advances one slot per rotation index       | rotateSample windowing + wrap         |
 * | R-SMK2  | sample clamps to the corpus size; ≥1                       | rotateSample clamping                 |
 * | R-SMK3  | CLI parses --live/--module/--sample/--rotation-index/--url | parseArgs matrix                      |
 * | R-SMK4  | curl argv: -L redirect cap, temp files, POST body, url     | buildCurlArgs matrix                  |
 * | R-SMK5  | header dump: last hop wins, Set-Cookie via append, folds   | parseHeaderDump matrix                |
 * | R-SMK6  | runSmokeModules REFUSES without { live: true, resolver }   | network gate                          |
 * | R-SMK7  | module files located under modules/ then templates/        | locateModuleFile (real FMD2 tree)     |
 */

describe('smoke rotation (R-SMK1/R-SMK2)', () => {
  const corpus = listSeedModules('/workspace/fmd-web/corpus/fixtures/seed');
  const names = corpus.map((m) => m.name);

  it('lists the seed corpus sorted with manifests present', () => {
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain('AsuraScans');
  });

  it('advances the window one slot per rotation index, wrapping', () => {
    const one = rotateSample(corpus, 3, 0).map((m) => m.name);
    const two = rotateSample(corpus, 3, 1).map((m) => m.name);
    expect(one).toEqual(names.slice(0, 3));
    expect(two).toEqual(names.slice(3, 6));
    // wrap: total windows of size 3 over N modules — index N walks back around
    const wrapped = rotateSample(corpus, 3, corpus.length).map((m) => m.name);
    expect(wrapped).toEqual(one);
  });

  it('clamps sample size to [1, corpus]', () => {
    expect(rotateSample(corpus, 0, 5)).toHaveLength(1);
    expect(rotateSample(corpus, 9999, 5)).toHaveLength(corpus.length);
    expect(rotateSample([], 3, 0)).toEqual([]);
  });

  it('rotation clock is the UTC day number (stable within a day)', () => {
    expect(utcDayNumber(new Date('2026-11-13T00:00:00Z'))).toBe(
      utcDayNumber(new Date('2026-11-13T23:59:59Z')),
    );
  });
});

describe('smoke CLI parsing (R-SMK3)', () => {
  it('defaults: plan mode, sample 5, day-number rotation', () => {
    const args = parseArgs([]);
    expect(args.live).toBe(false);
    expect(args.sampleSize).toBe(5);
    expect(args.rotationIndex).toBe(utcDayNumber());
    expect(args.url).toBeUndefined();
  });

  it('parses the full flag set incl. comma-separated --module and --url', () => {
    const args = parseArgs([
      '--live',
      '--module',
      'AsuraScans,MangaDex',
      '--sample',
      '3',
      '--rotation-index',
      '11',
      '--url',
      'https://example.com/manga/x/',
      '--out',
      '/tmp/opencode/r.json',
    ]);
    expect(args.live).toBe(true);
    expect(args.modules).toEqual(['AsuraScans', 'MangaDex']);
    expect(args.sampleSize).toBe(3);
    expect(args.rotationIndex).toBe(11);
    expect(args.url).toBe('https://example.com/manga/x/');
    expect(args.out).toBe('/tmp/opencode/r.json');
  });

  it('rejects unknown args and missing values with usage errors', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument: --nope');
    expect(() => parseArgs(['--module'])).toThrow('--module requires a value');
    expect(() => parseArgs(['--sample'])).toThrow('--sample requires a number');
    expect(() => parseArgs(['--url'])).toThrow('--url requires a value');
  });
});

describe('curl argv building (R-SMK4)', () => {
  const opts = { ...DEFAULT_LIVE_OPTIONS, maxTimeSeconds: 7 };

  it('GET single hop: timing, size cap, temp files, trailing url after -- (no -L: the pipeline owns redirects)', () => {
    const args = buildCurlArgs('GET', 'https://h/x', '', '', { 'User-Agent': 'UA/1' }, 'b', 'hf', opts);
    expect(args.slice(0, 14)).toEqual([
      '-sS',
      '--max-time',
      '7',
      '--connect-timeout',
      String(opts.connectTimeoutSeconds),
      '--compressed',
      '--max-filesize',
      String(opts.maxBytes),
      '-o',
      'b',
      '-D',
      'hf',
      '-w',
      '%{http_code}',
    ]);
    expect(args[args.length - 1]).toBe('https://h/x');
    expect(args[args.length - 2]).toBe('--');
    expect(args.join(' ')).toContain('User-Agent: UA/1');
    expect(args.join(' ')).not.toContain('-X'); // no explicit method for GET
    expect(args.join(' ')).not.toContain(' -L'); // single hop — pipeline follows redirects
    expect(args.join(' ')).not.toContain('--data-binary');
  });

  it('POST: -X POST, --data-binary body, Content-Type from negotiated MimeType', () => {
    const args = buildCurlArgs(
      'POST',
      'https://h/login',
      'user=a&pass=b',
      'application/x-www-form-urlencoded; charset=UTF-8',
      { 'Content-Type': 'text/html', Cookie: 'k=v' },
      'b',
      'hf',
      opts,
    );
    const joined = args.join(' ');
    expect(joined).toContain('-X POST');
    expect(joined).toContain('--data-binary user=a&pass=b');
    // Content-Type rides the POST MimeType; the header-map's text/html is dropped
    expect(joined).toContain('Content-Type: application/x-www-form-urlencoded; charset=UTF-8');
    expect(joined).not.toContain('Content-Type: text/html');
    expect(joined).toContain('Cookie: k=v');
  });

  it('HEAD and other methods ride -X', () => {
    const head = buildCurlArgs('HEAD', 'https://h/x', '', '', {}, 'b', 'hf', opts);
    expect(head.join(' ')).toContain('-X HEAD');
  });
});

describe('header dump parsing (R-SMK5)', () => {
  it('redirect dump: the LAST hop block wins', () => {
    const dump = [
      'HTTP/1.1 301 Moved Permanently',
      'Location: https://h/new',
      'Set-Cookie: a=1',
      '',
      'HTTP/1.1 200 OK',
      'Content-Type: text/html; charset=utf-8',
      'Set-Cookie: b=2',
      'X-Folded: first',
      '  continued',
      '',
      '',
    ].join('\r\n');
    const parsed = parseHeaderDump(dump);
    expect(parsed.status).toBe(200);
    expect(parsed.statusText).toBe('OK');
    expect(parsed.headers.get('location')).toBeNull(); // 301's Location gone
    expect(parsed.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(parsed.headers.getSetCookie()).toEqual(['b=2']);
    expect(parsed.headers.get('x-folded')).toBe('first, continued');
  });

  it('single block parses status + statusText; empty dump → status 0', () => {
    const parsed = parseHeaderDump('HTTP/2 404 Not Found\r\nServer: x\r\n\r\n');
    expect(parsed.status).toBe(404);
    expect(parsed.statusText).toBe('Not Found');
    expect(parseHeaderDump('').status).toBe(0);
  });
});

describe('network gate (R-SMK6)', () => {
  it('runSmokeModules refuses to run without live:true + resolver', async () => {
    const bad = { live: false } as unknown as SmokeRunOptions;
    await expect(runSmokeModules([], bad)).rejects.toThrow('network-gated');
    const noResolver = { live: true } as unknown as SmokeRunOptions;
    await expect(runSmokeModules([], noResolver)).rejects.toThrow('network-gated');
  });

  it('the CLI default is plan mode (live:false) — --live is explicit', () => {
    const args: SmokeCliArgs = parseArgs([]);
    expect(args.live).toBe(false);
    expect(parseArgs(['--live']).live).toBe(true);
  });

  it('the live resolver is only constructible for real runs; its gate is the CLI', () => {
    // Constructing the resolver is inert (no socket opens until resolve());
    // this asserts the default options stay conservative.
    expect(DEFAULT_LIVE_OPTIONS.maxTimeSeconds).toBeLessThanOrEqual(60);
    expect(DEFAULT_LIVE_OPTIONS.maxBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    void new LiveResponseResolver().dispose();
  });
});

describe('module file location (R-SMK7)', () => {
  it('finds real modules under modules/ and templates under templates/', () => {
    expect(locateModuleFile(FMD2_LUA_ROOT, 'AsuraScans')).toBe('modules/AsuraScans.lua');
    expect(locateModuleFile(FMD2_LUA_ROOT, 'Madara')).toBe('templates/Madara.lua');
    expect(locateModuleFile(FMD2_LUA_ROOT, 'NoSuchModule')).toBeUndefined();
  });
});
