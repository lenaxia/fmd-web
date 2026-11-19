/**
 * Job route integration tests (§10): idempotent download create
 * (replay → ORIGINAL job with 200; key reuse with a different payload
 * → 409), job listing with state filter + keyset cursor.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, FakeInfoService, MODULE_A_ID } from './helpers.js';

function downloadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    moduleId: MODULE_A_ID,
    mangaUrl: 'https://ex.org/manga/x',
    mangaTitle: 'Fixture Manga',
    chapterLink: 'https://ex.org/manga/x/1',
    chapterName: 'Ch. 1',
    ...overrides,
  };
}

/** An info seam that always fails like a dead origin (plain error). */
function failingInfo(): FakeInfoService {
  return new (class extends FakeInfoService {
    public override async getInfo(): Promise<never> {
      await Promise.resolve();
      throw new Error('origin unreachable');
    }
  })([MODULE_A_ID]);
}

describe('POST /api/jobs/download — chapterPosition (D1 §7 numbering source)', (): void => {
  it('an omitted position resolves through the cached info seam: 1-based list ordinal rides the payload', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      // FakeInfoService lists https://ex.org/ch/1 then /ch/2 — the
      // second entry is ordinal 2.
      payload: downloadBody({
        idempotencyKey: 'pos-replay',
        chapterLink: 'https://ex.org/ch/2',
        chapterName: 'Ch. 2',
      }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().job.payload as Record<string, unknown>).chapterPosition).toBe(2);
    // the info seam was consulted for the canonical manga url
    expect(h.info.calls.some((call): boolean => call.url === 'https://ex.org/manga/x')).toBe(true);
    // an identical keyed replay resolves the SAME position
    // (cache-consistent) → the ORIGINAL job with 200, no fingerprint
    // drift.
    const replay = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({
        idempotencyKey: 'pos-replay',
        chapterLink: 'https://ex.org/ch/2',
        chapterName: 'Ch. 2',
      }),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().job).toEqual(res.json().job);
  });

  it('an explicit chapterPosition is honored verbatim and skips the info seam entirely', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ chapterPosition: 7 }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().job.payload as Record<string, unknown>).chapterPosition).toBe(7);
    expect(h.info.calls).toEqual([]);
  });

  it('a link the live list does not carry enqueues WITHOUT a position (201, never blocked)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ chapterLink: 'https://ex.org/manga/x/9' }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().job.payload as Record<string, unknown>).chapterPosition).toBeUndefined();
  });

  it('an info-seam failure is swallowed: the enqueue still lands (numbering is best effort)', async (): Promise<void> => {
    const h = buildHarness({ info: failingInfo() });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody(),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().job.payload as Record<string, unknown>).chapterPosition).toBeUndefined();
  });
});

describe('POST /api/jobs/download — idempotency semantics (§10)', (): void => {
  it('happy path: fresh create returns 201 with the queued job', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'key-1' }),
    });
    expect(res.statusCode).toBe(201);
    const job = res.json().job as Record<string, unknown>;
    expect(job.state).toBe('queued');
    expect(job.type).toBe('download');
    expect(job.idempotencyKey).toBe('key-1');
    expect(job.moduleId).toBe(MODULE_A_ID);
    expect((job.payload as Record<string, unknown>).chapterLink).toBe('https://ex.org/manga/x/1');
    expect(typeof job.createdAt).toBe('string');
    expect(job.createdAt).toBe(job.updatedAt);
  });

  it('identical-key replay returns the ORIGINAL job with 200 (no second job)', async (): Promise<void> => {
    const h = buildHarness();
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'same-key' }),
    });
    expect(first.statusCode).toBe(201);
    const original = first.json().job as { id: string };

    const replay = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'same-key' }),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().job).toEqual(original); // the ORIGINAL job
    expect(h.jobs.size).toBe(1);
  });

  it('replay is payload-fingerprint-bound: reordered keys still replay, a changed field conflicts', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'k', mangaTitle: 'T', chapterName: 'C' }),
    });
    // Same payload, different key ORDER → still identical (canonical JSON).
    const reordered = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: {
        chapterName: 'C',
        mangaTitle: 'T',
        idempotencyKey: 'k',
        chapterLink: 'https://ex.org/manga/x/1',
        mangaUrl: 'https://ex.org/manga/x',
        moduleId: MODULE_A_ID,
      },
    });
    expect(reordered.statusCode).toBe(200);

    // One field changed → 409.
    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'k', chapterLink: 'https://ex.org/manga/x/2' }),
    });
    expect(changed.statusCode).toBe(409);
    const err = expectEnvelope(changed.body, 'conflict');
    expect(err.message).toContain('different payload');
    expect(h.jobs.size).toBe(1);
  });

  it('the same payload under a DIFFERENT key creates a new job (201)', async (): Promise<void> => {
    const h = buildHarness();
    const a = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'a' }),
    });
    const b = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'b' }),
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().job.id).not.toBe(b.json().job.id);
  });

  it('without an idempotencyKey every create is fresh (201)', async (): Promise<void> => {
    const h = buildHarness();
    const a = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    const b = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().job.id).not.toBe(b.json().job.id);
  });

  it('validation failures: bad moduleId, missing chapterLink, empty idempotencyKey', async (): Promise<void> => {
    const h = buildHarness();
    const badModule = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ moduleId: 'zz' }),
    });
    expect(badModule.statusCode).toBe(400);
    expectEnvelope(badModule.body, 'validation_error');

    const missingChapter = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { moduleId: MODULE_A_ID, mangaUrl: 'https://x' },
    });
    expect(missingChapter.statusCode).toBe(400);
    expectEnvelope(missingChapter.body, 'validation_error');

    const emptyKey = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: '' }),
    });
    expect(emptyKey.statusCode).toBe(400);
    expectEnvelope(emptyKey.body, 'validation_error');
    expect(h.jobs.size).toBe(0);
  });
});

describe('GET /api/jobs — state filter + keyset cursor', (): void => {
  it('happy path: newest-first listing with the created jobs', async (): Promise<void> => {
    const h = buildHarness();
    for (let i = 1; i <= 3; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/api/jobs/download',
        payload: downloadBody({ chapterLink: `https://ex.org/manga/x/${String(i)}` }),
      });
    }
    const res = await h.app.inject({ method: 'GET', url: '/api/jobs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobs: Array<{ id: string }>; nextCursor?: string };
    expect(body.jobs.map((j) => j.id)).toEqual(['3', '2', '1']);
    expect(body.nextCursor).toBeUndefined(); // everything fit on one page
  });

  it('state filter returns only matching jobs', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    const created = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    const job = h.jobs.get((created.json().job as { id: string }).id);
    expect(job).toBeDefined();
    (job as unknown as { state: string }).state = 'done';

    const queued = await h.app.inject({ method: 'GET', url: '/api/jobs?state=queued' });
    expect((queued.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toEqual(['1']);

    const done = await h.app.inject({ method: 'GET', url: '/api/jobs?state=done' });
    expect((done.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toEqual(['2']);

    const invalid = await h.app.inject({ method: 'GET', url: '/api/jobs?state=exploded' });
    expect(invalid.statusCode).toBe(400);
    expectEnvelope(invalid.body, 'validation_error');
  });

  it('pagination walks the full list with stable page contents', async (): Promise<void> => {
    const h = buildHarness();
    for (let i = 1; i <= 5; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/api/jobs/download',
        payload: downloadBody({ chapterLink: `https://ex.org/c/${String(i)}` }),
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const url = cursor === undefined ? '/api/jobs?limit=2' : `/api/jobs?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const page = res.json() as { jobs: Array<{ id: string }>; nextCursor?: string };
      seen.push(...page.jobs.map((j) => j.id));
      cursor = page.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }
    expect(seen).toEqual(['5', '4', '3', '2', '1']);
  });

  it('validation failures: bad limit, garbage cursor', async (): Promise<void> => {
    const h = buildHarness();
    const badLimit = await h.app.inject({ method: 'GET', url: '/api/jobs?limit=0' });
    expect(badLimit.statusCode).toBe(400);
    expectEnvelope(badLimit.body, 'validation_error');

    const bigLimit = await h.app.inject({ method: 'GET', url: '/api/jobs?limit=101' });
    expect(bigLimit.statusCode).toBe(400);
    expectEnvelope(bigLimit.body, 'validation_error');

    const badCursor = await h.app.inject({ method: 'GET', url: '/api/jobs?cursor=%21%21junk' });
    expect(badCursor.statusCode).toBe(400);
    expectEnvelope(badCursor.body, 'bad_request');
  });
});

describe('GET /api/jobs — R5 arrival `since` (last-transition floor)', (): void => {
  it('state=done&since returns only rows FINISHED at/after the timestamp', async (): Promise<void> => {
    const h = buildHarness();
    // Two done rows with distinct finished-at stamps + one newer queued
    // row (its updatedAt is "now" but its state is not done — the
    // away-summary call composes state=done + since).
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/jobs/download',
        payload: downloadBody({ chapterLink: `https://ex.org/manga/x/${String(i)}` }),
      });
      ids.push((created.json().job as { id: string }).id);
    }
    const finishedEarly = '2026-11-17T09:00:00.000Z';
    const finishedLate = '2026-11-17T10:30:00.000Z';
    const between = '2026-11-17T10:00:00.000Z';
    Object.assign(h.jobs.get(ids[0] as string) as object, { state: 'done', updatedAt: finishedEarly });
    Object.assign(h.jobs.get(ids[1] as string) as object, { state: 'done', updatedAt: finishedLate });

    const news = await h.app.inject({
      method: 'GET',
      url: `/api/jobs?state=done&since=${encodeURIComponent(between)}`,
    });
    expect(news.statusCode).toBe(200);
    expect((news.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toEqual([ids[1]]);

    // since BEFORE both finishes → both done rows, newest-first.
    const all = await h.app.inject({
      method: 'GET',
      url: `/api/jobs?state=done&since=${encodeURIComponent('2026-11-17T08:00:00.000Z')}`,
    });
    expect((all.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toEqual([ids[1], ids[0]]);

    // since AFTER everything → empty (the 'nothing new' away state).
    // The floor must be computed from the LIVE clock AFTER the rows
    // exist: the queued row keeps its real creation stamp (the two
    // done rows carry the hand-set stamps above), so a hardcoded
    // wall-clock constant time-bombs the suite the moment the local
    // clock passes it.
    const afterEverything = new Date(Date.now() + 60_000).toISOString();
    const none = await h.app.inject({
      method: 'GET',
      url: `/api/jobs?since=${encodeURIComponent(afterEverything)}`,
    });
    expect((none.json() as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it('a malformed since is a typed 400; absence keeps the pre-R5 shape', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    const bad = await h.app.inject({ method: 'GET', url: '/api/jobs?since=not-a-timestamp' });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');

    // Offset-bearing ISO is rejected (TimestampSchema discipline).
    const offset = await h.app.inject({ method: 'GET', url: '/api/jobs?since=2026-11-17T10:00:00%2B01:00' });
    expect(offset.statusCode).toBe(400);
    expectEnvelope(offset.body, 'validation_error');

    const plain = await h.app.inject({ method: 'GET', url: '/api/jobs' });
    expect(plain.statusCode).toBe(200);
    expect((plain.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
  });
});
