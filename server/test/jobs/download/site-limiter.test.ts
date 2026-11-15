import { describe, expect, it } from 'vitest';
import { PerHostSiteLimiter } from '../../../src/jobs/download/site-limiter.js';

/**
 * Per-site connection limiter (DESIGN §7.1 "per-site limiter", §4
 * queued-requests fail fast; mirrors FMD2 `THTTPQueue` /
 * `MaxConnectionLimit` — WebsiteModules.pas). Limits are per host;
 * queued waiters hand off directly; cancellation resolves queued
 * waiters with null (fail fast — §4 deadline semantics).
 */
const never = (): boolean => false;

describe('PerHostSiteLimiter — acquisition', () => {
  it('grants immediately while under the host limit', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 2);
    const r1 = await limiter.acquire('http://site.example/a.jpg', never);
    const r2 = await limiter.acquire('http://site.example/b.jpg', never);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(limiter.activeFor('http://site.example/a.jpg')).toBe(2);
    r1?.();
    expect(limiter.activeFor('http://site.example/a.jpg')).toBe(1);
    r2?.();
    expect(limiter.activeFor('http://site.example/a.jpg')).toBe(0);
  });

  it('queues beyond the limit and hands the slot off on release (FIFO)', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 1);
    const r1 = await limiter.acquire('http://site.example/1.jpg', never);
    expect(r1).not.toBeNull();

    let r2: (() => void) | null | undefined;
    const p2 = limiter.acquire('http://site.example/2.jpg', never).then((r) => {
      r2 = r;
    });
    let r3: (() => void) | null | undefined;
    const p3 = limiter.acquire('http://site.example/3.jpg', never).then((r) => {
      r3 = r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(r2).toBeUndefined(); // still queued
    expect(limiter.activeFor('http://site.example/1.jpg')).toBe(1);

    r1?.(); // FIFO handoff → waiter 2
    await Promise.resolve();
    await p2;
    expect(r2).not.toBeNull();
    expect(r3).toBeUndefined(); // waiter 3 still queued
    expect(limiter.activeFor('http://site.example/1.jpg')).toBe(1); // handoff keeps count

    r2?.();
    await Promise.resolve();
    await p3;
    expect(r3).not.toBeNull();

    await Promise.all([p2, p3]);
  });

  it('limits are per host (hosts are independent)', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('a.example', 1);
    limiter.setHostLimit('b.example', 1);
    const ra = await limiter.acquire('http://a.example/x', never);
    const rb = await limiter.acquire('http://b.example/x', never);
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    expect(limiter.activeFor('http://a.example/x')).toBe(1);
    expect(limiter.activeFor('http://b.example/x')).toBe(1);
  });

  it('a limit of 0 means unlimited (FMD2 MaxConnectionLimit=0)', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 0);
    const releases = [];
    for (let i = 0; i < 10; i += 1) {
      releases.push(await limiter.acquire(`http://site.example/${i}.jpg`, never));
    }
    expect(limiter.activeFor('http://site.example/0.jpg')).toBe(0); // unlimited: no counting
    for (const r of releases) {
      r?.();
    }
  });

  it('limitFor reports host limits with a configurable default', () => {
    const limiter = new PerHostSiteLimiter(3);
    expect(limiter.limitFor('http://unknown.example/x')).toBe(3);
    limiter.setHostLimit('known.example', 1);
    expect(limiter.limitFor('http://known.example/x')).toBe(1);
  });
});

describe('PerHostSiteLimiter — cancellation fail fast (§4)', () => {
  it('acquire resolves null immediately when already cancelled', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 1);
    limiter.cancelAll();
    const r = await limiter.acquire('http://site.example/x.jpg', () => true);
    expect(r).toBeNull();
    expect(limiter.activeFor('http://site.example/x.jpg')).toBe(0);
  });

  it('queued waiters resolve null on cancelAll while holding slots are untouched', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 1);
    const holder = await limiter.acquire('http://site.example/hold.jpg', never);

    let queuedResult: (() => void) | null | undefined;
    const queued = limiter
      .acquire('http://site.example/queued.jpg', never)
      .then((r) => {
        queuedResult = r;
      });

    await Promise.resolve();
    await Promise.resolve();
    expect(queuedResult).toBeUndefined();

    limiter.cancelAll();
    await queued;
    expect(queuedResult).toBeNull(); // queued-but-unstarted → fail fast
    expect(limiter.activeFor('http://site.example/hold.jpg')).toBe(1); // holder untouched

    holder?.();
  });

  it('a waiter released before cancelAll still gets a real slot', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 1);
    const holder = await limiter.acquire('http://site.example/1.jpg', never);

    let queuedResult: (() => void) | null | undefined;
    const queued = limiter
      .acquire('http://site.example/2.jpg', never)
      .then((r) => {
        queuedResult = r;
      });
    await Promise.resolve();
    await Promise.resolve();

    holder?.(); // release first…
    await queued;
    expect(queuedResult).not.toBeNull();

    limiter.cancelAll(); // …then cancel: the granted slot is unaffected
    (queuedResult as () => void)();
    expect(limiter.activeFor('http://site.example/1.jpg')).toBe(0);
  });

  it('a granted slot releases normally after cancelAll; double release is a no-op', async () => {
    const limiter = new PerHostSiteLimiter();
    limiter.setHostLimit('site.example', 1);
    const holder = await limiter.acquire('http://site.example/x.jpg', never);
    limiter.cancelAll();
    expect(limiter.activeFor('http://site.example/x.jpg')).toBe(1); // grant survives
    holder?.();
    expect(limiter.activeFor('http://site.example/x.jpg')).toBe(0);
    holder?.(); // double release: no-op
    expect(limiter.activeFor('http://site.example/x.jpg')).toBe(0);
  });
});
