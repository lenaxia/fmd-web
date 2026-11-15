import { describe, expect, it, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { Headers } from 'undici';
import { LIVE_SUITE_SITES, validateSuite } from '../../tools/smoke/sites.js';
import {
  bodyLooksLikeText,
  detectD18,
  parseAdvertisedEncodings,
  type D18Observation,
} from '../../tools/smoke/d18.js';
import {
  assertRequestLog,
  hostOf,
  sleepSync,
  SMOKE_USER_AGENT,
  PacedResolver,
  DEFAULT_MIN_GAP_MS,
  type RequestLogEntry,
} from '../../tools/smoke/pacing.js';
import { parseArgs } from '../../tools/smoke/run.js';
import { locateModuleFile } from '../../tools/smoke/smoke.js';
import { runLiveSuite } from '../../tools/smoke/live-suite.js';
import { mockEgress, MockClusterResolver, startMockCluster } from '../../tools/smoke/mock-cluster.js';
import { LiveResponseResolver } from '../../tools/smoke/live-resolver.js';
import { FMD2_LUA_ROOT } from '../../src/engine/shims/install.js';

/**
 * Live-suite unit tests — ALL OFFLINE except the loopback mock cluster
 * (127.0.0.1 only; the vitest zero-network guard permits loopback and
 * the mock resolver never leaves the machine). Contract → test matrix:
 * | Row    | Contract                                                    | Test                                  |
 * |--------|-------------------------------------------------------------|---------------------------------------|
 * | R-LS1  | suite: ≥10 sites, ≥5 families, real seed modules + files    | suite definition                      |
 * | R-LS2  | D18 detector: advertised vs Content-Encoding vs decodability| crafted-observation matrix            |
 * | R-LS3  | request-log assertion: fixed UA + per-host ≥minGap          | synthetic log matrix                  |
 * | R-LS4  | sync pacing primitive blocks ≥ the requested gap            | sleepSync timing                      |
 * | R-LS5  | gates: live refuses without live:true; mock needs note      | suite gates                           |
 * | R-LS6  | CLI: --suite/--mock/--blocker-note/--rate-ms parse + guards | parseArgs matrix                      |
 * | R-LS7  | mock cluster: SAME code path end-to-end on loopback         | cluster integration (skip/fail/D18)   |
 */

const SEED_DIR = '/workspace/fmd-web/corpus/fixtures/seed';

describe('suite definition (R-LS1)', () => {
  it('carries ≥10 heterogeneous sites across ≥5 families', () => {
    expect(LIVE_SUITE_SITES.length).toBeGreaterThanOrEqual(10);
    expect(validateSuite(LIVE_SUITE_SITES)).toEqual([]);
    const families = new Set(LIVE_SUITE_SITES.map((s) => s.category));
    expect(families.size).toBeGreaterThanOrEqual(5);
    expect(families).toContain('json-api');
    expect(families).toContain('protobuf');
    expect(families).toContain('madara-template');
    expect(families).toContain('account-gated');
    expect(families).toContain('imagepuzzle');
  });

  it('every suite site exists in the seed corpus with a real module file', () => {
    for (const site of LIVE_SUITE_SITES) {
      expect(existsSync(`${SEED_DIR}/${site.name}/manifest.json`), site.name).toBe(true);
      expect(locateModuleFile(FMD2_LUA_ROOT, site.name), site.name).toBeDefined();
    }
  });

  it('the account-gated site is marked gated (expected-skip semantics)', () => {
    const gated = LIVE_SUITE_SITES.filter((s) => s.gated === true).map((s) => s.name);
    expect(gated).toContain('EHentai');
  });
});

describe('D18 detector (R-LS2)', () => {
  const obs = (over: Partial<D18Observation>): D18Observation => ({
    url: 'https://site.example/page',
    requestAcceptEncoding: 'gzip, deflate, br',
    responseContentEncoding: '',
    status: 200,
    bodyFirstBytesHex: '3c68746d6',
    bodyLooksText: true,
    bodyLength: 100,
    ...over,
  });

  it('clean responses produce no finding', () => {
    expect(detectD18(obs({}))).toBeUndefined();
    expect(detectD18(obs({ responseContentEncoding: 'gzip', bodyLooksText: true }))).toBeUndefined();
    expect(detectD18(obs({ responseContentEncoding: 'identity' }))).toBeUndefined();
  });

  it('unadvertised Content-Encoding that DECODED anyway is an informational finding (curl handled it)', () => {
    const finding = detectD18(obs({ responseContentEncoding: 'zstd', bodyLooksText: true }));
    expect(finding?.signature).toBe('unadvertised-encoding');
    expect(finding?.severity).toBe('info');
    expect(finding?.decodable).toBe(true);
  });

  it('the zstd undecodable-body shape is a d18-hit (server ignored negotiation, body is garbage)', () => {
    const finding = detectD18(
      obs({
        responseContentEncoding: 'zstd',
        bodyLooksText: false,
        bodyFirstBytesHex: '4b1fd3a902fe8841',
        bodyLength: 4096,
      }),
    );
    expect(finding?.signature).toBe('undecodable-body');
    expect(finding?.severity).toBe('d18-hit');
    expect(finding?.decodable).toBe(false);
  });

  it('an ADVERTISED encoding with an undecodable body is a d18-hit (decode pass failed)', () => {
    const finding = detectD18(obs({ responseContentEncoding: 'gzip', bodyLooksText: false }));
    expect(finding?.signature).toBe('undecodable-body');
    expect(finding?.severity).toBe('d18-hit');
  });

  it('binary body with NO encoding claimed is an integrity anomaly (info)', () => {
    const finding = detectD18(
      obs({ bodyLooksText: false, bodyFirstBytesHex: '4b1fd3a9', bodyLength: 512 }),
    );
    expect(finding?.signature).toBe('binary-body-without-encoding');
    expect(finding?.severity).toBe('info');
  });

  it('empty bodies and unknown advertised lists stay quiet', () => {
    expect(detectD18(obs({ bodyLength: 0, bodyLooksText: false }))).toBeUndefined();
    const finding = detectD18(
      obs({ requestAcceptEncoding: '', responseContentEncoding: 'br', bodyLooksText: true }),
    );
    expect(finding?.signature).toBe('unadvertised-encoding');
  });

  it('parses the advertised list and flags the zstd omission (D13 default)', () => {
    expect(parseAdvertisedEncodings('gzip, deflate, br')).toEqual(['gzip', 'deflate', 'br']);
    expect(parseAdvertisedEncodings('')).toEqual([]);
    expect(parseAdvertisedEncodings('gzip')).not.toContain('zstd');
  });

  it('text heuristic: NUL bytes and non-printable leads read as binary', () => {
    expect(bodyLooksLikeText(Buffer.from('<html><body>ok'))).toBe(true);
    expect(bodyLooksLikeText(Buffer.from('{"json":true}'))).toBe(true);
    expect(bodyLooksLikeText(Buffer.from([0x4b, 0x1f, 0xd3, 0xa9, 0x02, 0xfe, 0x00, 0x41]))).toBe(false);
    expect(bodyLooksLikeText(Buffer.alloc(0))).toBe(false);
  });
});

describe('request-log assertion (R-LS3)', () => {
  const entry = (over: Partial<RequestLogEntry>): RequestLogEntry => ({
    ts: '2026-11-15T00:00:00.000Z',
    method: 'GET',
    url: 'https://a.example/',
    host: 'a.example',
    status: 200,
    userAgent: SMOKE_USER_AGENT,
    durationMs: 10,
    ...over,
  });

  it('a clean log (fixed UA, wide gaps, distinct hosts) has no violations', () => {
    const log = [
      entry({ ts: '2026-11-15T00:00:00.000Z' }),
      entry({ ts: '2026-11-15T00:00:02.000Z', host: 'b.example', url: 'https://b.example/' }),
      entry({ ts: '2026-11-15T00:00:04.000Z' }),
    ];
    expect(assertRequestLog(log, { minGapMs: 1000, userAgent: SMOKE_USER_AGENT })).toEqual([]);
  });

  it('same-host gaps under the minimum violate the 1 req/s contract', () => {
    const log = [
      entry({ ts: '2026-11-15T00:00:00.000Z' }),
      entry({ ts: '2026-11-15T00:00:00.400Z' }),
    ];
    const violations = assertRequestLog(log, { minGapMs: 1000, userAgent: SMOKE_USER_AGENT });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('rate violation');
  });

  it('a non-fixed UA violates', () => {
    const log = [entry({ userAgent: 'Mozilla/5.0 (randomized)' })];
    const violations = assertRequestLog(log, { minGapMs: 1000, userAgent: SMOKE_USER_AGENT });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('UA violation');
  });

  it('boundary gap == minGap is clean', () => {
    const log = [
      entry({ ts: '2026-11-15T00:00:00.000Z' }),
      entry({ ts: '2026-11-15T00:00:01.000Z' }),
    ];
    expect(assertRequestLog(log, { minGapMs: 1000, userAgent: SMOKE_USER_AGENT })).toEqual([]);
  });

  it('host extraction tolerates junk', () => {
    expect(hostOf('https://a.example/x?y=1')).toBe('a.example');
    expect(hostOf('not a url')).toBe('(unparsed)');
  });
});

describe('sync pacing primitive (R-LS4)', () => {
  it('sleepSync blocks at least the requested gap', () => {
    const startedAt = Date.now();
    sleepSync(60);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55);
  });

  it('sleepSync(0) and negatives return immediately', () => {
    const startedAt = Date.now();
    sleepSync(0);
    sleepSync(-5);
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it('the default per-site gap is 1 request per second', () => {
    expect(DEFAULT_MIN_GAP_MS).toBe(1000);
  });
});

describe('suite gates (R-LS5)', () => {
  const paced = new PacedResolver({ resolve: () => ({ status: 200, statusText: '', headers: new Headers(), body: '' }) });

  it('a live suite refuses without live:true (the network gate)', async () => {
    await expect(
      runLiveSuite({ environment: 'live', paced, seedDir: SEED_DIR }),
    ).rejects.toThrow('network-gated');
  });

  it('a mock-cluster suite refuses without a blockerNote', async () => {
    await expect(
      runLiveSuite({ environment: 'mock-cluster', paced, seedDir: SEED_DIR }),
    ).rejects.toThrow('blockerNote');
  });
});

describe('suite CLI parsing (R-LS6)', () => {
  it('parses --suite/--mock/--blocker-note/--rate-ms', () => {
    const args = parseArgs([
      '--suite',
      '--mock',
      '--blocker-note',
      'env offline',
      '--rate-ms',
      '250',
    ]);
    expect(args.suite).toBe(true);
    expect(args.mock).toBe(true);
    expect(args.blockerNote).toBe('env offline');
    expect(args.rateMs).toBe(250);
  });

  it('--mock requires --suite; --mock and --live are exclusive; note is mock-only', () => {
    expect(() => parseArgs(['--mock'])).toThrow('--mock requires --suite');
    expect(() => parseArgs(['--suite', '--mock', '--live'])).toThrow('loopback-only');
    expect(() => parseArgs(['--blocker-note', 'x'])).toThrow('--blocker-note applies to --suite --mock');
    expect(() => parseArgs(['--rate-ms'])).toThrow('--rate-ms requires');
  });
});

describe('mock cluster integration — SAME code path on loopback (R-LS7)', () => {
  const sites = LIVE_SUITE_SITES.filter((s) => ['EHentai', '18Comic', 'ManhwaIndo'].includes(s.name));
  const clusterPending = startMockCluster(SEED_DIR, sites);
  let cluster: Awaited<typeof clusterPending> | undefined;
  const live = new LiveResponseResolver();

  afterAll(() => {
    cluster?.dispose();
    live.dispose();
  });

  it('runs the suite end-to-end: gate/skip, 403/fail, fixture parse — paced + UA-stamped', async () => {
    cluster = await clusterPending;
    const paced = new PacedResolver(new MockClusterResolver(live, cluster.urlMap), 20);
    const report = await runLiveSuite({
      environment: 'mock-cluster',
      paced,
      seedDir: SEED_DIR,
      egress: mockEgress(),
      blockerNote: 'vitest loopback verification',
      sites,
      minGapMs: 20,
    });

    // Report shape: run timestamp + site list + per-module rates.
    expect(report.schema).toBe('live-smoke-report/1');
    expect(report.environment).toBe('mock-cluster');
    expect(report.blockerNote).toBe('vitest loopback verification');
    expect(report.sites).toHaveLength(3);
    expect(report.generatedAt).toBeTruthy();

    // EHentai: login gate 403 → module net_problem → gated expected-skip.
    const ehentai = report.results.find((r) => r.site === 'EHentai');
    expect(ehentai?.status).toBe('skip');
    expect(ehentai?.classification).toBe('skip:account-gated');

    // 18Comic: Cloudflare-style 403 → honest http failure classification.
    const comic = report.results.find((r) => r.site === '18Comic');
    expect(comic?.status).toBe('fail');
    expect(comic?.classification).toBe('http');

    // ManhwaIndo: its own corpus fixture page — parses through the real pipeline.
    const manhwa = report.results.find((r) => r.site === 'ManhwaIndo');
    expect(manhwa).toBeDefined();
    expect(['pass', 'fail']).toContain(manhwa?.status);
    expect(manhwa?.latencyMs).toBeGreaterThanOrEqual(0);

    // Skips stay out of the pass-rate denominator.
    expect(report.totals.skip).toBe(1);
    expect(report.passRate).toBeLessThanOrEqual(1);

    // The harness's own request log: fixed UA on every entry, per-host
    // pacing honored at the run's gap, zero violations. (Each suite
    // site is a distinct host here, so a rate violation is impossible
    // by construction — the violation-detection proof over REAL log
    // entries lives in the D18 probe test below, which fires three
    // requests at one host.)
    expect(paced.requestLog.length).toBeGreaterThanOrEqual(3);
    expect(report.requestLog.violations).toEqual([]);
    expect(report.requestLog.fixedUa).toBe(SMOKE_USER_AGENT);
    expect(
      assertRequestLog(paced.requestLog, {
        minGapMs: 1000,
        userAgent: SMOKE_USER_AGENT,
      }),
    ).toEqual([]);

    // D18 observations rode every response.
    expect(report.d18.observations).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('the D18 probe routes fire the detector END-TO-END through the real resolver', async () => {
    cluster = cluster ?? (await clusterPending);
    const paced = new PacedResolver(new MockClusterResolver(live, cluster.urlMap), DEFAULT_MIN_GAP_MS);
    // 1) advertised gzip + garbage body → curl error 61 → salvaged
    //    headers → undecodable-body d18-hit (the curl-without-zstd
    //    shape of the real D18 zstd scenario).
    paced.resolve('GET', 'http://d18.probe.invalid/undecodable-gzip-claimed', '', '', {
      'Accept-Encoding': 'gzip, deflate, br',
    });
    // 2) valid brotli body while advertising only gzip+deflate →
    //    unadvertised-encoding info (the D13 server-ignores-negotiation
    //    probe signal).
    paced.resolve('GET', 'http://d18.probe.invalid/unadvertised-br', '', '', {
      'Accept-Encoding': 'gzip, deflate',
    });
    // 3) clean gzip under a full advertisement → no finding.
    paced.resolve('GET', 'http://d18.probe.invalid/clean-gzip', '', '', {
      'Accept-Encoding': 'gzip, deflate, br',
    });
    const [undecodable, unadvertised, clean] = paced.d18Observations.slice(-3);
    if (undecodable === undefined || unadvertised === undefined || clean === undefined) {
      throw new Error('probe observations missing');
    }
    expect(undecodable.responseContentEncoding).toBe('gzip');
    expect(undecodable.bodyLooksText).toBe(false);
    expect(detectD18(undecodable)).toMatchObject({
      signature: 'undecodable-body',
      severity: 'd18-hit',
      decodable: false,
    });
    expect(unadvertised.responseContentEncoding).toBe('br');
    expect(unadvertised.bodyLooksText).toBe(true);
    expect(detectD18(unadvertised)).toMatchObject({
      signature: 'unadvertised-encoding',
      severity: 'info',
      decodable: true,
    });
    expect(detectD18(clean)).toBeUndefined();

    // The probe log carries REAL same-host entries — the assertion
    // catches under-paced runs: real gaps are ≥1000ms (the enforced
    // pacing), so a 2000ms threshold flags requests 2 and 3.
    const tightened = assertRequestLog(paced.requestLog, {
      minGapMs: 2000,
      userAgent: SMOKE_USER_AGENT,
    });
    expect(tightened.filter((v) => v.includes('rate violation'))).toHaveLength(2);
    expect(
      assertRequestLog(paced.requestLog, {
        minGapMs: 1000,
        userAgent: SMOKE_USER_AGENT,
      }),
    ).toEqual([]);
  }, 60_000);
});
