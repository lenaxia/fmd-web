/**
 * cbAddAsStopped + edSaveTo parity (MangaPage story): POST
 * /api/jobs/download `paused` flag (job created queued-but-held until
 * POST /api/jobs/:id/resume lifts it) and the `saveTo` payload echo.
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

describe('POST /api/jobs/download — paused (cbAddAsStopped parity)', (): void => {
  it('paused:true creates the job queued + held (paused reflected on the wire)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ paused: true }),
    });
    expect(res.statusCode).toBe(201);
    const job = res.json().job as Record<string, unknown>;
    expect(job.state).toBe('queued');
    expect(job.paused).toBe(true);
  });

  it('default create carries no hold (paused absent)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    expect(res.statusCode).toBe(201);
    expect((res.json().job as Record<string, unknown>).paused).toBeUndefined();
  });

  it('paused participates in the idempotency fingerprint (key reuse with a different hold → 409)', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'hold-key', paused: true }),
    });
    const conflict = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ idempotencyKey: 'hold-key' }),
    });
    expect(conflict.statusCode).toBe(409);
    expectEnvelope(conflict.body, 'conflict');
  });
});

describe('POST /api/jobs/:id/resume — lift the add-as-stopped hold', (): void => {
  it('queued+paused → hold lifted, state stays queued; second resume is an idempotent no-op', async (): Promise<void> => {
    const h = buildHarness();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ paused: true }),
    });
    const id = (created.json().job as { id: string }).id;

    const resumed = await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/resume`, payload: {} });
    expect(resumed.statusCode).toBe(200);
    const job = resumed.json().job as Record<string, unknown>;
    expect(job.state).toBe('queued');
    expect(job.paused).toBeUndefined();

    const again = await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/resume`, payload: {} });
    expect(again.statusCode).toBe(200);
    expect((again.json().job as Record<string, unknown>).paused).toBeUndefined();
  });

  it('terminal rows are 409 (nothing to resume); unknown ids are 404', async (): Promise<void> => {
    const h = buildHarness();
    const created = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    const id = (created.json().job as { id: string }).id;
    await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, payload: {} });

    const terminal = await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/resume`, payload: {} });
    expect(terminal.statusCode).toBe(409);
    expectEnvelope(terminal.body, 'conflict');

    const unknown = await h.app.inject({ method: 'POST', url: '/api/jobs/999/resume', payload: {} });
    expect(unknown.statusCode).toBe(404);
    expectEnvelope(unknown.body, 'not_found');
  });
});

describe('POST /api/jobs/download — saveTo (edSaveTo parity)', (): void => {
  it('saveTo rides the payload verbatim; absent by default', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ saveTo: 'custom/dir' }),
    });
    expect(res.statusCode).toBe(201);
    const payload = (res.json().job as { payload: Record<string, unknown> }).payload;
    expect(payload.saveTo).toBe('custom/dir');

    const plain = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody() });
    expect(((plain.json().job as { payload: Record<string, unknown> }).payload).saveTo).toBeUndefined();
  });

  it('paused + saveTo compose on one create', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: downloadBody({ paused: true, saveTo: '/abs/save' }),
    });
    const job = res.json().job as { paused: boolean; payload: Record<string, unknown> };
    expect(job.paused).toBe(true);
    expect(job.payload.saveTo).toBe('/abs/save');
  });
});
