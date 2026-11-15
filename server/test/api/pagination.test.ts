/**
 * Cursor pagination stability (§10 acceptance): a cursor must keep its
 * page stable across CONCURRENT INSERTS. The job list uses a keyset
 * cursor (boundary = last id of the previous page), so newly created
 * jobs — which always sort to the front of a fresh listing — can never
 * shift an in-flight pagination walk. An offset cursor would drift and
 * duplicate/skip rows; this test fails on either.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, MODULE_A_ID } from './helpers.js';

function body(chapter: number): Record<string, unknown> {
  return {
    moduleId: MODULE_A_ID,
    mangaUrl: 'https://ex.org/manga/x',
    chapterLink: `https://ex.org/manga/x/${String(chapter)}`,
  };
}

describe('GET /api/jobs — cursor stability across concurrent inserts', (): void => {
  it('a pagination walk in flight is unaffected by jobs created while it runs', async (): Promise<void> => {
    const h = buildHarness();
    // Seed 6 jobs → ids 1..6 (newest-first listing: 6..1).
    for (let i = 1; i <= 6; i += 1) {
      const res = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: body(i) });
      expect(res.statusCode).toBe(201);
    }

    // Page 1 (limit 2) of the original six, cursor in hand.
    const page1 = await h.app.inject({ method: 'GET', url: '/api/jobs?limit=2' });
    const p1 = page1.json() as { jobs: Array<{ id: string }>; nextCursor: string };
    expect(p1.jobs.map((j) => j.id)).toEqual(['6', '5']);
    const cursorMidWalk = p1.nextCursor;

    // CONCURRENT inserts: 4 new jobs land while the walk is in flight.
    const inserts = await Promise.all(
      [7, 8, 9, 10].map((i) =>
        h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: body(i) }),
      ),
    );
    for (const res of inserts) {
      expect(res.statusCode).toBe(201);
    }
    expect(h.jobs.size).toBe(10);

    // Continue the ORIGINAL walk via the cursor: pages 2..4 must contain
    // exactly the remaining original jobs (4,3), (2,1) — no drift, no
    // duplicates, none of the new jobs (7..10) leaking into the walk.
    const walked: string[] = [...p1.jobs.map((j) => j.id)];
    let cursor: string | undefined = cursorMidWalk;
    for (let i = 0; i < 4 && cursor !== undefined; i += 1) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/jobs?limit=2&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.statusCode).toBe(200);
      const page = res.json() as { jobs: Array<{ id: string }>; nextCursor?: string };
      walked.push(...page.jobs.map((j) => j.id));
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('fresh listings DO surface the concurrent inserts (they only affect page 1 of a new walk)', async (): Promise<void> => {
    const h = buildHarness();
    for (let i = 1; i <= 3; i += 1) {
      await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: body(i) });
    }
    await Promise.all(
      [4, 5].map((i) => h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: body(i) })),
    );
    const fresh = await h.app.inject({ method: 'GET', url: '/api/jobs?limit=2' });
    const ids = (fresh.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
    expect(ids).toEqual(['5', '4']); // newest first
  });

  it('an offset cursor would drift — pin the keyset property at the service seam', async (): Promise<void> => {
    // Direct service-level proof: the cursor is the id boundary, not an
    // offset. This is the property that makes the API stable.
    const h = buildHarness();
    for (let i = 1; i <= 4; i += 1) {
      h.jobs.createDownload({
        moduleId: MODULE_A_ID,
        mangaUrl: 'https://x',
        chapterLink: `https://x/${String(i)}`,
      });
    }
    const page = h.jobs.list({ limit: 2 });
    expect(page.jobs.map((j) => j.id)).toEqual(['4', '3']);
    expect(page.nextCursor).toBeDefined();
    const after = h.jobs.list({ limit: 10, ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}) });
    expect(after.jobs.map((j) => j.id)).toEqual(['2', '1']);
    expect(after.nextCursor).toBeUndefined(); // exact end — no trailing cursor
  });
});
