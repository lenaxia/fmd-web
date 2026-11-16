import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AntiBotInterceptor,
  StubBypassExecutor,
  checkAntiBot,
  type BypassContext,
  type BypassExecutor,
  type InterceptableRequest,
} from '../../../src/engine/state/antibot.js';
import { ModuleStateService } from '../../../src/engine/state/module-state.js';
import type { ModuleSharedState } from '../../../src/engine/state/module-state.js';
import { InMemoryModuleStatePersistence } from '../../../src/engine/state/persistence.js';

/** Race a promise against a watchdog — a miss reads as a deadlock/hang. */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DEADLOCK/HANG: ${what} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Step {
  status: number;
  contentType?: string;
  server?: string;
}

/** Scripted request object (THTTPSendThread stand-in for unit flows). */
class FakeRequest implements InterceptableRequest {
  userAgent = 'DefaultUA/1.0';
  terminated = false;
  resets = 0;
  asr = false;
  readonly executions: Array<{ asr: boolean; userAgent: string; cookieHeader: string }> = [];
  private lastView = { resultCode: 0, contentType: '', server: '' };

  constructor(
    private readonly module: ModuleSharedState,
    private readonly steps: readonly Step[],
    private readonly executeDelayMs = 5,
  ) {}

  get method(): string {
    return 'GET';
  }

  get url(): string {
    return 'https://example.com/chapter/1/page-1.webp';
  }

  setAllowServerErrorResponse(value: boolean): void {
    this.asr = value;
  }

  reset(): void {
    this.resets += 1;
  }

  view(): { resultCode: number; contentType: string; server: string } {
    return this.lastView;
  }

  async execute(): Promise<boolean> {
    const step = this.steps[Math.min(this.executions.length, this.steps.length - 1)]!;
    this.executions.push({
      asr: this.asr,
      userAgent: this.userAgent,
      cookieHeader: this.module.cookies.snapshotSync().requestHeader,
    });
    if (this.executeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.executeDelayMs));
    }
    this.lastView = {
      resultCode: step.status,
      contentType: step.contentType ?? 'text/html',
      server: step.server ?? 'cloudflare',
    };
    return step.status === 200; // success ⇔ Document.Size > 0
  }
}

/** Pluggable bypass executor stand-in (sidecar/`____WebsiteBypass`). */
class FakeBypassExecutor implements BypassExecutor {
  readonly entries: Array<{ host: string; settingsCookiesAtEntry: string }> = [];
  /** When set, every bypass blocks until released (single-flight tests). */
  gate: Promise<void> | null = null;
  entered = false;
  private letEnter!: () => void;
  readonly firstEntry: Promise<void> = new Promise((r) => {
    this.letEnter = r;
  });
  released = true;
  private releaseGate!: () => void;
  setGate(): void {
    this.gate = new Promise<void>((r) => {
      this.releaseGate = r;
    });
    this.released = false;
  }
  release(): void {
    this.releaseGate?.();
    this.released = true;
  }

  constructor(
    private readonly options: {
      readonly ok?: boolean;
      readonly jarCookie?: string;
      readonly ua?: string;
      readonly onEntry?: () => void;
    } = {},
  ) {}

  get available(): boolean {
    return true;
  }

  async bypass(ctx: BypassContext): Promise<boolean> {
    this.entries.push({
      host: ctx.host,
      settingsCookiesAtEntry: ctx.module.settings.snapshotSync().cookies,
    });
    this.entered = true;
    this.letEnter();
    this.options.onEntry?.();
    if (this.gate !== null) {
      await this.gate;
    }
    if (this.options.jarCookie !== undefined) {
      ctx.module.cookies.set('cf_clearance', 'bypassed');
    }
    if (this.options.ua !== undefined) {
      (ctx.request as FakeRequest).userAgent = this.options.ua;
    }
    return this.options.ok ?? true;
  }
}

/** Loopback mock 403-server: antibot page until the clearance cookie exists. */
class MockAntiBotServer {
  private server: http.Server | null = null;
  readonly requests: Array<{ path: string; cookieHeader: string }> = [];
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const cookieHeader = String(req.headers.cookie ?? '');
      this.requests.push({ path: String(req.url), cookieHeader });
      if (cookieHeader.includes('cf_clearance=bypassed')) {
        res.writeHead(200, { 'Content-Type': 'image/png', Server: 'cloudflare' });
        res.end('PNGDATA');
        return;
      }
      res.writeHead(403, {
        'Content-Type': 'text/html; charset=utf-8',
        Server: 'cloudflare',
        'Set-Cookie': 'anon=seed; Path=/',
      });
      res.end('<html>Just a moment...</html>');
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server!.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

/** Real request object against the loopback server (node fetch). */
class LoopbackRequest implements InterceptableRequest {
  userAgent = 'DefaultUA/1.0';
  terminated = false;
  asr = false;
  resets = 0;
  private lastView = { resultCode: 0, contentType: '', server: '' };

  constructor(
    private readonly module: ModuleSharedState,
    private readonly port: number,
    private readonly path: string,
  ) {}

  get method(): string {
    return 'GET';
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}${this.path}`;
  }

  setAllowServerErrorResponse(value: boolean): void {
    this.asr = value;
  }

  reset(): void {
    this.resets += 1;
  }

  view(): { resultCode: number; contentType: string; server: string } {
    return this.lastView;
  }

  async execute(): Promise<boolean> {
    const headers: Record<string, string> = { 'User-Agent': this.userAgent };
    const cookieHeader = this.module.cookies.snapshotSync().requestHeader;
    if (cookieHeader !== '') {
      headers.Cookie = cookieHeader;
    }
    const res = await fetch(this.url, { headers });
    this.lastView = {
      resultCode: res.status,
      contentType: res.headers.get('content-type') ?? '',
      server: res.headers.get('server') ?? '',
    };
    for (const sc of res.headers.getSetCookie()) {
      this.module.cookies.addServerCookie(sc);
    }
    const body = await res.text();
    return body.length > 0;
  }
}

async function makeModule(persistence?: InMemoryModuleStatePersistence): Promise<{
  service: ModuleStateService;
  module: ModuleSharedState;
}> {
  const service = new ModuleStateService(persistence !== undefined ? { persistence } : {});
  const module = await service.forModule('webtoon');
  return { service, module };
}

describe('____CheckAntiBot heuristics (checkantibot.lua:5-12)', () => {
  const hit = (status: number, contentType: string, server: string) =>
    checkAntiBot({ resultCode: status, contentType, server });

  it('403/429/503 + text/html + cloudflare/ddos-guard → hit', () => {
    expect(hit(403, 'text/html; charset=utf-8', 'cloudflare')).toBe(true);
    expect(hit(429, 'text/html', 'ddos-guard')).toBe(true);
    expect(hit(503, 'text/html; charset=iso-8859-1', 'cloudflare')).toBe(true);
  });

  it('case-insensitive sniffing', () => {
    expect(hit(403, 'TEXT/HTML', 'CloudFlare')).toBe(true);
    expect(hit(403, 'Text/HTML', 'DDOS-Guard')).toBe(true);
  });

  it('non-antibot shapes → no hit', () => {
    expect(hit(403, 'application/json', 'cloudflare')).toBe(false); // not html
    expect(hit(200, 'text/html', 'cloudflare')).toBe(false); // not 403/429/503
    expect(hit(403, 'text/html', 'nginx')).toBe(false); // not cf/ddos-guard
    expect(hit(404, 'text/html', 'cloudflare')).toBe(false);
  });
});

describe('interceptor flow (LuaWebsiteBypass.pas:142-209)', () => {
  const antibotStep: Step = { status: 403, contentType: 'text/html', server: 'cloudflare' };
  const okStep: Step = { status: 200, contentType: 'text/html', server: 'cloudflare' };

  it('reload=true: bypass persists cookies+UA and re-issues the original request (:184-188)', async () => {
    const { service, module } = await makeModule();
    module.storage.set('reload', 'true');
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed', ua: 'BypassUA/1.0' });
    const request = new FakeRequest(module, [antibotStep, okStep]);
    const interceptor = new AntiBotInterceptor();

    const outcome = await withDeadline(
      interceptor.intercept(request, module, { bypassExecutor: executor }),
      5000,
      'reload re-issue flow',
    );

    expect(outcome).toEqual({ result: true, antibotHit: true, path: 'bypass' });
    expect(executor.entries).toHaveLength(1);
    expect(executor.entries[0]!.host).toBe('example.com');
    expect(request.resets).toBe(1); // Reset() before the re-issue (:186)
    expect(request.executions).toHaveLength(2); // initial + re-issue
    expect(request.executions[0]!.asr).toBe(true); // forced for the check (:156)
    expect(request.executions[1]!.asr).toBe(true);
    expect(request.executions[1]!.cookieHeader).toContain('cf_clearance=bypassed'); // re-issue carries clearance
    const settings = await module.settings.snapshot();
    expect(settings.cookies).toContain('cf_clearance=bypassed'); // persisted into settings (:182)
    expect(settings.userAgent).toBe('BypassUA/1.0'); // (:183)
    expect(settings.enabled).toBe(true); // (:181)
    expect(module.bypass.busy).toBe(false); // gate released (:191)
    expect(service.tracker.activeCount()).toBe(0);
  });

  it('without reload the original request is NOT re-issued', async () => {
    const { module } = await makeModule();
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    const request = new FakeRequest(module, [antibotStep]);
    const interceptor = new AntiBotInterceptor();

    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });
    expect(outcome.path).toBe('bypass');
    expect(outcome.result).toBe(true); // Result := WebsiteBypassGetAnswer (:178)
    expect(request.executions).toHaveLength(1); // no re-issue
    expect(request.resets).toBe(0);
  });

  it('AllowServerErrorResponse is forced true for the checked request (:156)', async () => {
    const { module } = await makeModule();
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    const request = new FakeRequest(module, [antibotStep]);
    request.asr = false; // caller had it off
    const interceptor = new AntiBotInterceptor();

    await interceptor.intercept(request, module, { bypassExecutor: executor });
    expect(request.executions[0]!.asr).toBe(true); // forced ON for the initial request
  });

  it('module-settings cookies are cleared BEFORE the bypass attempt (:177)', async () => {
    const { module } = await makeModule();
    await module.settings.setCookies('a=1; b=2'); // stale settings cookies
    await module.cookies.write((jar) => {
      jar.set('a', '1');
      jar.set('b', '2');
    });
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    const request = new FakeRequest(module, [antibotStep]);
    const interceptor = new AntiBotInterceptor();

    await interceptor.intercept(request, module, { bypassExecutor: executor });
    expect(executor.entries[0]!.settingsCookiesAtEntry).toBe(''); // cleared first
    const settings = await module.settings.snapshot();
    expect(settings.cookies).toContain('cf_clearance=bypassed'); // then persisted
  });

  it('ONE global antibot check at a time (:94-115) across concurrent requests', async () => {
    const { module } = await makeModule();
    let inside = 0;
    let maxInside = 0;
    const interceptor = new AntiBotInterceptor({
      check: async (view) => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 10)); // widen the race window
        inside -= 1;
        return checkAntiBot(view);
      },
    });
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    executor.setGate(); // hold the winner so the second request becomes the loser
    const p1 = interceptor.intercept(new FakeRequest(module, [antibotStep]), module, { bypassExecutor: executor });
    const p2 = interceptor.intercept(new FakeRequest(module, [antibotStep]), module, { bypassExecutor: executor });
    // Both checks queue on the global lock; without it they would overlap.
    const loserOutcome = await withDeadline(p2, 5000, 'loser of the global-check race');

    expect(maxInside).toBe(1); // serialized globally
    expect(interceptor.maxObservedCheckConcurrency).toBe(1);
    expect(loserOutcome.path).toBe('fallthrough'); // one winner, one loser
    expect(executor.entries).toHaveLength(1); // single-flight: ONE bypass
    executor.release();
    const winnerOutcome = await withDeadline(p1, 5000, 'winner of the global-check race');
    expect(winnerOutcome.path).toBe('bypass');
  });

  it('single-flight fallthrough: the loser proceeds with the plain request and is NOT delayed (:161,197-200)', async () => {
    const { service, module } = await makeModule();
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    executor.setGate(); // winner's bypass blocks on the test
    const interceptor = new AntiBotInterceptor();

    const winnerRequest = new FakeRequest(module, [antibotStep]);
    const winner = interceptor.intercept(winnerRequest, module, { bypassExecutor: executor });
    await executor.firstEntry; // winner holds the module gate now
    expect(executor.released).toBe(false);

    const loserRequest = new FakeRequest(module, [antibotStep]);
    const loser = interceptor.intercept(loserRequest, module, { bypassExecutor: executor });

    const loserOutcome = await withDeadline(loser, 3000, 'loser fallthrough');
    expect(executor.released).toBe(false); // bypass STILL pending …
    expect(loserOutcome).toEqual({ result: false, antibotHit: true, path: 'fallthrough' });
    expect(loserRequest.executions).toHaveLength(2); // initial + plain re-issue
    expect(loserRequest.resets).toBe(0); // no reset on the loser path
    // the loser's plain re-issue went out while the winner was inside the bypass
    expect(service.tracker.activeCount()).toBe(0);

    executor.release();
    const winnerOutcome = await withDeadline(winner, 3000, 'winner bypass');
    expect(winnerOutcome).toEqual({ result: true, antibotHit: true, path: 'bypass' });
    expect(module.bypass.entries).toBe(1); // exactly one single-flight entry
  });

  it('terminated loser skips the plain re-issue (:198)', async () => {
    const { module } = await makeModule();
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    executor.setGate();
    const interceptor = new AntiBotInterceptor();

    const winner = interceptor.intercept(new FakeRequest(module, [antibotStep]), module, { bypassExecutor: executor });
    await executor.firstEntry;
    const loserRequest = new FakeRequest(module, [antibotStep]);
    loserRequest.terminated = true;
    const loserOutcome = await interceptor.intercept(loserRequest, module, { bypassExecutor: executor });
    expect(loserOutcome).toEqual({ result: false, antibotHit: true, path: 'fallthrough' });
    expect(loserRequest.executions).toHaveLength(1); // no re-issue when terminated
    executor.release();
    await winner;
  });

  it('failed bypass: result is the bypass result and settings stay cleared (:135-138)', async () => {
    const { module } = await makeModule();
    await module.settings.setCookies('a=1');
    const executor = new FakeBypassExecutor({ ok: false });
    const request = new FakeRequest(module, [antibotStep]);
    const interceptor = new AntiBotInterceptor();

    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });
    expect(outcome).toEqual({ result: false, antibotHit: true, path: 'bypass' });
    const settings = await module.settings.snapshot();
    expect(settings.cookies).toBe(''); // cleared before the attempt, not restored on failure
    expect(settings.userAgent).toBe(''); // UA untouched
  });

  it('a throwing bypass executor degrades to a failed bypass', async () => {
    const { module } = await makeModule();
    const executor: BypassExecutor = {
      available: true,
      bypass: async () => {
        throw new Error('sidecar exploded');
      },
    };
    const outcome = await new AntiBotInterceptor().intercept(new FakeRequest(module, [antibotStep]), module, {
      bypassExecutor: executor,
    });
    expect(outcome.result).toBe(false);
    expect(module.bypass.busy).toBe(false);
  });

  it('a throwing pluggable CHECK is log-and-continue, not a crash (N-4, :112-114)', async () => {
    const { module } = await makeModule();
    let checks = 0;
    const interceptor = new AntiBotInterceptor({
      check: () => {
        checks += 1;
        throw new Error('hostile injected check exploded');
      },
    });
    const executor = new FakeBypassExecutor({ ok: false });
    const request = new FakeRequest(module, [antibotStep]);
    // Pre-fix this propagated out of intercept(); the hardening treats the
    // fault as "not an antibot page" — the plain result stands, the check
    // lock releases (a later request still runs the check), no gate entry.
    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });
    expect(checks).toBe(1);
    expect(outcome).toEqual({ result: false, antibotHit: false, path: 'plain' });
    expect(module.bypass.busy).toBe(false);
    expect(module.bypass.entries).toBe(0);
    const outcome2 = await interceptor.intercept(new FakeRequest(module, [antibotStep]), module, {
      bypassExecutor: executor,
    });
    expect(checks).toBe(2);
    expect(outcome2.antibotHit).toBe(false);
  });

  it('stub / known-broken executor short-circuits to the plain request (:149-153)', async () => {
    const { module } = await makeModule();
    let checks = 0;
    const interceptor = new AntiBotInterceptor({ check: () => (checks += 1) > 0 });
    const request = new FakeRequest(module, [antibotStep]);

    const viaStub = await interceptor.intercept(request, module, { bypassExecutor: new StubBypassExecutor() });
    expect(viaStub).toEqual({ result: false, antibotHit: false, path: 'plain' });
    expect(request.executions).toHaveLength(1);

    const plainRequest = new FakeRequest(module, [antibotStep]);
    const defaultPath = await interceptor.intercept(plainRequest, module); // no executor wired
    expect(defaultPath).toEqual({ result: false, antibotHit: false, path: 'plain' });
    expect(plainRequest.executions).toHaveLength(1);
    expect(checks).toBe(0); // heuristics never ran — chunks absent path
    expect(module.bypass.busy).toBe(false);
  });

  it('no antibot hit: plain single request, no gate entry', async () => {
    const { module } = await makeModule();
    const executor = new FakeBypassExecutor({});
    const request = new FakeRequest(module, [okStep]);
    const interceptor = new AntiBotInterceptor();

    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });
    expect(outcome).toEqual({ result: true, antibotHit: false, path: 'plain' });
    expect(executor.entries).toHaveLength(0);
    expect(module.bypass.entries).toBe(0);
  });

  it('bypass-internal HTTP re-enters the interceptor without deadlock (:94-115 vs :159)', async () => {
    const { service, module } = await makeModule();
    module.storage.set('reload', 'true');
    const interceptor = new AntiBotInterceptor();
    const innerExecutor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    // The bypass performs its own HTTP through the SAME interceptor —
    // legal only because the global check lock is released before bypass
    // execution. If a lock were held this would deadlock (deadline fails).
    const executor: BypassExecutor = {
      available: true,
      bypass: async (ctx) => {
        service.tracker.assertIdle('bypass-internal-intercept');
        const inner = new FakeRequest(module, [okStep]);
        const innerOutcome = await interceptor.intercept(inner, module, { bypassExecutor: innerExecutor });
        expect(innerOutcome.result).toBe(true);
        ctx.module.cookies.set('cf_clearance', 'bypassed');
        return true;
      },
    };
    const outcome = await withDeadline(
      interceptor.intercept(new FakeRequest(module, [antibotStep, okStep]), module, { bypassExecutor: executor }),
      5000,
      're-entrant bypass',
    );
    expect(outcome.result).toBe(true);
    expect(outcome.path).toBe('bypass');
  });
});

describe('mock 403-server integration (loopback)', () => {
  const server = new MockAntiBotServer();

  beforeAll(() => server.start());
  afterAll(() => server.stop());

  it('first request triggers the bypass executor; the re-issue succeeds with clearance', async () => {
    const { service, module } = await makeModule();
    module.storage.set('reload', 'true');
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed', ua: 'BypassUA/1.0' });
    const request = new LoopbackRequest(module, server.port, '/img-0.webp');
    const interceptor = new AntiBotInterceptor();

    const outcome = await withDeadline(
      interceptor.intercept(request, module, { bypassExecutor: executor }),
      5000,
      'loopback bypass flow',
    );

    expect(outcome).toEqual({ result: true, antibotHit: true, path: 'bypass' });
    expect(executor.entries).toHaveLength(1);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.cookieHeader).not.toContain('cf_clearance'); // 403 on first hit
    expect(server.requests[1]!.cookieHeader).toContain('cf_clearance=bypassed'); // re-issue cleared it
    expect(request.view().resultCode).toBe(200);
    expect(service.tracker.activeCount()).toBe(0);
  });

  it('≥8 parallel same-module image downloads share cookies/Storage without deadlock (AC1)', async () => {
    const { service, module } = await makeModule();
    module.storage.set('reload', 'true');
    module.limiter.setHostLimit('127.0.0.1', 4); // bounded slots under load
    const interceptor = new AntiBotInterceptor();
    // Bypass sets the shared clearance cookie; concurrent downloads pick it
    // up from the shared jar — ordering-agnostic (whoever bypasses wins).
    const executor = new FakeBypassExecutor({ jarCookie: 'cf_clearance=bypassed' });
    executor.setGate();

    // Deterministic phases: the first wave runs while the bypass gate is
    // held — exactly one worker wins the single-flight, the other 7 fall
    // through. Release happens only after all 7 fallthroughs resolved.
    const fallthroughsTarget = 7;
    let fallthroughs = 0;
    const allFallthroughs = defer();
    const download = async (i: number): Promise<boolean> =>
      // per-event detector context: the lock-held-during-callback check is
      // per execution path (a concurrent worker's hold is legitimate — D12)
      service.tracker.inContext(async () => {
        const request = new LoopbackRequest(module, server.port, `/img-${i}.webp`);
        // Download-manager-style retries: losers fall through to a plain
        // request that 403s until the (single) bypass lands, then succeed.
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });
          if (outcome.path === 'fallthrough') {
            fallthroughs += 1;
            if (fallthroughs === fallthroughsTarget) {
              allFallthroughs.resolve();
            }
          }
          if (outcome.result) {
            service.tracker.assertIdle(`download-${i}`); // no lock held at completion
            await module.cookies.write((jar) => jar.set(`w${i}`, '1')); // mark: this worker ran
            await module.storage.transact('hits', (current) => String(Number(current ?? '0') + 1));
            return true;
          }
          await new Promise((r) => setTimeout(r, 2));
        }
        return false;
      });

    const workers = Array.from({ length: 8 }, (_, i) => download(i));
    await executor.firstEntry; // one worker holds the bypass …
    await allFallthroughs.promise; // … the other 7 proceeded, none waited
    expect(executor.released).toBe(false);
    executor.release();

    const results = await withDeadline(Promise.all(workers), 15000, '8 parallel image downloads');
    expect(results).toEqual([true, true, true, true, true, true, true, true]);

    const jar = await module.cookies.snapshot();
    expect(jar.entries['cf_clearance']).toBe('bypassed'); // shared clearance
    expect(jar.entries['anon']).toBe('seed'); // 403-page cookie shared too
    expect(jar.count).toBe(10); // clearance + anon + 8 worker markers
    expect(module.storage.get('hits')).toBe('8'); // exact per-key mutex accounting
    expect(executor.entries).toHaveLength(1); // exactly ONE bypass for all 8
    expect(module.bypass.entries).toBe(1);
    service.tracker.assertGloballyIdle('after 8 parallel downloads'); // no lock leaked
    expect(service.tracker.activeCount()).toBe(0);
  });
});
