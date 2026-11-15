import { describe, expect, it } from 'vitest';
import { CATALOG_RATE_BUDGET, FakeClock, TokenBucket } from '../../../src/sync/db/rate-budget.js';
import { SyncHttpClient } from '../../../src/sync/db/http-client.js';

/**
 * §6.1 rate budget under a FAKE CLOCK — the acceptance proof that blob
 * fetches are gated at 10 requests/s with burst 50: 50 requests pass
 * instantly, the 51st waits exactly one token interval, refill accrues
 * continuously and caps at the burst size.
 */
describe('TokenBucket with the fake clock (§6.1: 10 r/s, burst 50)', () => {
  it('exposes the design constants', () => {
    expect(CATALOG_RATE_BUDGET.requestsPerSecond).toBe(10);
    expect(CATALOG_RATE_BUDGET.burst).toBe(50);
  });

  it('starts full: the whole burst passes without any time passing', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(CATALOG_RATE_BUDGET.burst, CATALOG_RATE_BUDGET.requestsPerSecond, clock);
    for (let i = 0; i < 50; i += 1) {
      await bucket.acquire(1);
    }
    expect(clock.now()).toBe(0);
    expect(bucket.available()).toBe(0);
  });

  it('the 51st request waits exactly one token interval (100 ms)', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    for (let i = 0; i < 50; i += 1) {
      await bucket.acquire(1);
    }
    const pending: Promise<void> = bucket.acquire(1);
    let resolved: boolean = false;
    void pending.then(() => {
      resolved = true;
    });
    await clock.drain();
    expect(resolved).toBe(false);
    await clock.advance(99);
    expect(resolved).toBe(false); // fractional token — not enough yet
    await clock.advance(1);
    await clock.drain();
    expect(resolved).toBe(true);
    expect(clock.now()).toBe(100);
  });

  it('refills at 10 tokens per virtual second, capped at burst 50', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    for (let i = 0; i < 50; i += 1) {
      bucket.tryTake(1);
    }
    expect(bucket.available()).toBe(0);
    await clock.advance(1_000);
    expect(bucket.available()).toBeCloseTo(10, 6);
    await clock.advance(2_000);
    expect(bucket.available()).toBeCloseTo(30, 6);
    await clock.advance(100_000);
    expect(bucket.available()).toBe(50); // capped, never exceeds burst
  });

  it('a cost-25 acquire after a full drain waits 2.5 virtual seconds', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    bucket.tryTake(50);
    let done: boolean = false;
    void bucket.acquire(25).then(() => {
      done = true;
    });
    await clock.drain();
    await clock.advance(2_499);
    expect(done).toBe(false);
    await clock.advance(1);
    await clock.drain();
    expect(done).toBe(true);
    expect(clock.now()).toBe(2_500);
    expect(bucket.available()).toBeCloseTo(0, 6);
  });

  it('serves concurrent acquires strictly FIFO across the gate', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(2, 10, clock);
    const order: string[] = [];
    const p1: Promise<void> = bucket.acquire(1).then(() => {
      order.push('first');
    });
    const p2: Promise<void> = bucket.acquire(1).then(() => {
      order.push('second');
    });
    const p3: Promise<void> = bucket.acquire(1).then(() => {
      order.push('third');
    });
    await clock.advance(10_000);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('tryTake is the synchronous fast path (burst consumed instantly)', () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    expect(bucket.tryTake(50)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
    expect(clock.now()).toBe(0);
  });

  it('rejects invalid configuration and oversized costs', async () => {
    const clock: FakeClock = new FakeClock();
    expect(() => new TokenBucket(0, 10, clock)).toThrow();
    expect(() => new TokenBucket(50, 0, clock)).toThrow();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    expect(() => bucket.tryTake(51)).toThrow(/exceeds bucket capacity/);
    await expect(bucket.acquire(51)).rejects.toThrow(/exceeds bucket capacity/);
  });
});

/**
 * §6.2 conditional GET semantics of the HTTP layer — ETag flows into
 * If-None-Match, a 304 is surfaced unchanged (typed result), a 403
 * rate-limit body becomes a typed error that stops the batch cleanly.
 */
describe('SyncHttpClient ETag/304 + rate-limit handling', () => {
  it('sends If-None-Match and reports 304 without a body', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    const seen: RequestInit[] = [];
    const client: SyncHttpClient = new SyncHttpClient(bucket, clock, {}, async (_url, init) => {
      seen.push(init);
      const inm: string | undefined = (init.headers as Record<string, string>)?.['If-None-Match'];
      if (inm === '"v1"') {
        return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      }
      return new Response('payload', { status: 200, headers: { ETag: '"v1"' } });
    });
    const first = await client.getBlob('http://mock/7z/x.7z', '');
    expect(first.status).toBe(200);
    expect(first.etag).toBe('"v1"');
    expect(first.body.toString('utf8')).toBe('payload');
    const second = await client.getBlob('http://mock/7z/x.7z', '"v1"');
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
    expect((seen[1]?.headers as Record<string, string>)?.['If-None-Match']).toBe('"v1"');
  });

  it('maps 403/429 to RateLimitedError (batch stop, resumable)', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    const client: SyncHttpClient = new SyncHttpClient(
      bucket,
      clock,
      {},
      async () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 }),
    );
    await expect(client.getBlob('http://mock/7z/x.7z', '')).rejects.toThrow(/rate limited/);
    await expect(client.getBlob('http://mock/7z/y.7z', '')).rejects.toMatchObject({ status: 403 });
  });

  it('surface HTTP 500 as a plain fetch failure', async () => {
    const clock: FakeClock = new FakeClock();
    const bucket: TokenBucket = new TokenBucket(50, 10, clock);
    const client: SyncHttpClient = new SyncHttpClient(
      bucket,
      clock,
      {},
      async () => new Response('boom', { status: 500 }),
    );
    await expect(client.getBlob('http://mock/7z/x.7z', '')).rejects.toThrow(/HTTP 500/);
  });
});
