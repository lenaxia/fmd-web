/**
 * Job route integration tests (§10): idempotent download create
 * (replay → ORIGINAL job with 200; key reuse with a different payload
 * → 409), job listing with state filter + keyset cursor.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, MODULE_A_ID } from './helpers.js';

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
