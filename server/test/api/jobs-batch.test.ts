/**
 * Batch download-all route integration tests (§10 + browse row menu,
 * FMD2 pmMangaList miMangaListDownloadAll parity): one request per
 * manga, REQUIRED batch idempotency key deriving per-chapter keys
 * `<key>:<index>` — whole-batch replay while live returns the SAME
 * jobs (200 + replayed), a changed chapter sequence under the same key
 * is a 409, selections enqueue verbatim without an info fetch, and
 * paused/saveTo carry through to every chapter job.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, MODULE_A_ID } from './helpers.js';

const MANGA_URL = 'https://ex.org/manga/x';

function batchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    moduleId: MODULE_A_ID,
    mangaUrl: MANGA_URL,
    mangaTitle: 'Fixture Manga',
    chapters: 'all',
    idempotencyKey: 'batch-1',
    ...overrides,
  };
}

async function postBatch(
  h: ReturnType<typeof buildHarness>,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/jobs/download/batch',
    payload,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('POST /api/jobs/download/batch', (): void => {
  it('chapters:"all" resolves the live info chapter list and enqueues one job per chapter (201)', async (): Promise<void> => {
    const h = buildHarness();
    const { status, body } = await postBatch(h, batchBody());
    expect(status).toBe(201);
    expect(body.replayed).toBe(false);
    const jobs = body.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2); // FakeInfoService chapterLinks
    expect(jobs.map((j): string => String(j.id))).toEqual(['1', '2']);
    const payload0 = jobs[0]?.payload as Record<string, unknown>;
    expect(payload0.chapterLink).toBe('https://ex.org/ch/1');
    expect(payload0.chapterName).toBe('Ch. 1'); // names resolved from info
    expect(payload0.mangaTitle).toBe('Fixture Manga');
    // D1 §7: the resolved list IS the numbering authority — each job
    // carries its 1-based list ordinal for the %NUMBERING% filename.
    expect(payload0.chapterPosition).toBe(1);
    expect((jobs[1]?.payload as Record<string, unknown>).chapterPosition).toBe(2);
    // Every derived per-chapter key rides the row (§10 traceability).
    expect(jobs[0]?.idempotencyKey).toBe('batch-1:0');
    expect(jobs[1]?.idempotencyKey).toBe('batch-1:1');
    expect(h.jobs.size).toBe(2);
  });

  it('identical-key replay returns the SAME jobs with 200 + replayed:true (no new jobs)', async (): Promise<void> => {
    const h = buildHarness();
    const first = await postBatch(h, batchBody());
    expect(first.status).toBe(201);
    const originalIds = (first.body.jobs as Array<{ id: string }>).map((j): string => j.id);

    const replay = await postBatch(h, batchBody());
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((replay.body.jobs as Array<{ id: string }>).map((j): string => j.id)).toEqual(
      originalIds,
    );
    expect(h.jobs.size).toBe(2); // nothing new — the double-submit guard
    // The replay is served from the info cache (one engine call total).
    expect(h.info.calls).toHaveLength(1);
  });

  it('key reuse with a different chapter sequence is a 409 different-payload conflict', async (): Promise<void> => {
    const h = buildHarness();
    await postBatch(h, batchBody({ idempotencyKey: 'shared' }));
    const changed = await postBatch(
      h,
      batchBody({ idempotencyKey: 'shared', mangaUrl: 'https://ex.org/manga/y' }),
    );
    expect(changed.status).toBe(409);
    const err = expectEnvelope(JSON.stringify(changed.body), 'conflict');
    expect(err.message).toContain('different payload');
    expect(h.jobs.size).toBe(2); // the conflicting create added nothing
  });

  it('explicit selection enqueues verbatim WITHOUT an info fetch', async (): Promise<void> => {
    const h = buildHarness();
    const { status, body } = await postBatch(
      h,
      batchBody({
        chapters: ['https://ex.org/manga/x/late', 'https://ex.org/manga/x/early'],
        idempotencyKey: 'sel-1',
      }),
    );
    expect(status).toBe(201);
    const jobs = body.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect((jobs[0]?.payload as Record<string, unknown>).chapterLink).toBe(
      'https://ex.org/manga/x/late',
    ); // selection order preserved
    expect((jobs[0]?.payload as Record<string, unknown>).chapterName).toBeUndefined();
    expect(h.info.calls).toHaveLength(0); // no GetInfo for selections
  });

  it('paused + saveTo parity options apply to EVERY chapter job', async (): Promise<void> => {
    const h = buildHarness();
    const { body } = await postBatch(
      h,
      batchBody({ idempotencyKey: 'paused-1', paused: true, saveTo: 'custom/dir' }),
    );
    for (const job of body.jobs as Array<Record<string, unknown>>) {
      expect(job.paused).toBe(true);
      expect((job.payload as Record<string, unknown>).saveTo).toBe('custom/dir');
    }
  });

  it('unknown module is the typed 404 from the info seam; empty selection is a 400', async (): Promise<void> => {
    const h = buildHarness();
    const unknown = await postBatch(
      h,
      batchBody({ moduleId: 'f'.repeat(32), idempotencyKey: 'unknown' }),
    );
    expect(unknown.status).toBe(404);
    expectEnvelope(JSON.stringify(unknown.body), 'not_found');

    const empty = await postBatch(h, batchBody({ chapters: [], idempotencyKey: 'empty' }));
    expect(empty.status).toBe(400);
  });

  it('idempotencyKey is required (400 when absent)', async (): Promise<void> => {
    const h = buildHarness();
    const { idempotencyKey: _absent, ...withoutKey } = batchBody();
    void _absent;
    const res = await postBatch(h, withoutKey);
    expect(res.status).toBe(400);
  });
});
