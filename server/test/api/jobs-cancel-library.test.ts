/**
 * Job get/cancel + library listing/download route integration tests
 * (§10 additions, §7.1): the cancel transition over the §10 port
 * (queued → cancelled; terminal → 409), the job snapshot route, and
 * the library listing + artifact download surface.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function createJob(
  h: ReturnType<typeof buildHarness>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: downloadBody(overrides) });
  expect(res.statusCode).toBe(201);
  return (res.json().job as { id: string }).id;
}

describe('GET /api/jobs/:id — one job snapshot', (): void => {
  it('returns the created job', async (): Promise<void> => {
    const h = buildHarness();
    const id = await createJob(h, { chapterLink: 'https://ex.org/manga/x/get' });
    const res = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}` });
    expect(res.statusCode).toBe(200);
    const job = res.json().job as Record<string, unknown>;
    expect(job.id).toBe(id);
    expect(job.state).toBe('queued');
    expect(job.type).toBe('download');
  });

  it('404s unknown ids and 400s malformed ones', async (): Promise<void> => {
    const h = buildHarness();
    const missing = await h.app.inject({ method: 'GET', url: '/api/jobs/999' });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.json(), 'not_found');
    const malformed = await h.app.inject({ method: 'GET', url: '/api/jobs/not-a-number' });
    expect(malformed.statusCode).toBe(400);
    expectEnvelope(malformed.json(), 'validation_error');
  });
});

describe('POST /api/jobs/:id/cancel — §7.1 user cancellation', (): void => {
  it('cancels a queued job → cancelled (snapshot echoed)', async (): Promise<void> => {
    const h = buildHarness();
    const id = await createJob(h, { chapterLink: 'https://ex.org/manga/x/cancel' });
    const res = await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, payload: {} });
    expect(res.statusCode).toBe(200);
    const job = res.json().job as Record<string, unknown>;
    expect(job.id).toBe(id);
    expect(job.state).toBe('cancelled');
    // visible in the state-filtered listing
    const list = await h.app.inject({ method: 'GET', url: '/api/jobs?state=cancelled' });
    expect((list.json().jobs as { id: string }[]).map((j) => j.id)).toContain(id);
  });

  it('409s a terminal row and 404s unknown ids', async (): Promise<void> => {
    const h = buildHarness();
    const id = await createJob(h, { chapterLink: 'https://ex.org/manga/x/term' });
    const first = await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, payload: {} });
    expect(second.statusCode).toBe(409);
    expectEnvelope(second.json(), 'conflict');
    const unknown = await h.app.inject({ method: 'POST', url: '/api/jobs/424242/cancel', payload: {} });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('GET /api/library — listing + artifact download (§7.1)', (): void => {
  it('empty listing → {files: []}', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/library' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: [] });
  });

  it('lists recorded artifacts newest-first with cursor pagination', async (): Promise<void> => {
    const h = buildHarness();
    const dir = mkdtempSync(join(tmpdir(), 'fmd-library-api-'));
    try {
      for (const name of ['ch1.zip', 'ch2.zip', 'ch3.zip']) {
        const file = join(dir, name);
        writeFileSync(file, Buffer.from(`artifact-${name}`));
        h.library.put({
          moduleId: MODULE_A_ID,
          manga: 'Fixture Manga',
          fileName: name,
          bytes: 8 + name.length,
          path: file,
        });
      }
      const page1 = await h.app.inject({ method: 'GET', url: '/api/library?limit=2' });
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json() as { files: { fileName: string }[]; nextCursor?: string };
      expect(body1.files.map((f) => f.fileName)).toEqual(['ch3.zip', 'ch2.zip']);
      expect(body1.nextCursor).toBeDefined();
      const page2 = await h.app.inject({
        method: 'GET',
        url: `/api/library?limit=2${body1.nextCursor !== undefined ? `&cursor=${encodeURIComponent(body1.nextCursor)}` : ''}`,
      });
      const body2 = page2.json() as { files: { fileName: string }[]; nextCursor?: string };
      expect(body2.files.map((f) => f.fileName)).toEqual(['ch1.zip']);
      expect(body2.nextCursor).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams the artifact bytes with an attachment disposition', async (): Promise<void> => {
    const h = buildHarness();
    const dir = mkdtempSync(join(tmpdir(), 'fmd-library-api-'));
    try {
      const file = join(dir, 'Chapter 1 The Beginning.zip');
      writeFileSync(file, Buffer.from('PK\x03\x04fake-zip-bytes'));
      h.library.put({ moduleId: MODULE_A_ID, manga: 'Fixture Manga', fileName: 'Chapter 1 The Beginning.zip', bytes: 18, path: file });
      const list = await h.app.inject({ method: 'GET', url: '/api/library' });
      const id = (list.json().files as { id: string }[])[0]?.id;
      expect(id).toBeDefined();
      const res = await h.app.inject({ method: 'GET', url: `/api/library/${String(id)}/file` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('Chapter 1 The Beginning.zip');
      expect(res.body).toBe('PK\x03\x04fake-zip-bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('404s unknown ids and missing files', async (): Promise<void> => {
    const h = buildHarness();
    const missing = await h.app.inject({ method: 'GET', url: '/api/library/999/file' });
    expect(missing.statusCode).toBe(404);
    const dir = mkdtempSync(join(tmpdir(), 'fmd-library-api-'));
    try {
      // row present, file gone → 404 (the resolveFile fs check)
      h.library.put({ moduleId: MODULE_A_ID, manga: 'M', fileName: 'gone.zip', bytes: 1, path: join(dir, 'deleted.zip') });
      const list = await h.app.inject({ method: 'GET', url: '/api/library' });
      const id = (list.json().files as { id: string }[])[0]?.id;
      const gone = await h.app.inject({ method: 'GET', url: `/api/library/${String(id)}/file` });
      expect(gone.statusCode).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/library/:id — delete one artifact (UX-AUDIT L-2)', (): void => {
  it('removes the file from disk and the row from the listing', async (): Promise<void> => {
    const h = buildHarness();
    const dir = mkdtempSync(join(tmpdir(), 'fmd-library-del-'));
    try {
      const file = join(dir, 'ch1.zip');
      writeFileSync(file, Buffer.from('artifact-ch1'));
      h.library.put({ moduleId: MODULE_A_ID, manga: 'Fixture Manga', fileName: 'ch1.zip', bytes: 12, path: file });
      const list = await h.app.inject({ method: 'GET', url: '/api/library' });
      const id = (list.json().files as { id: string }[])[0]?.id;
      expect(id).toBeDefined();
      const res = await h.app.inject({ method: 'DELETE', url: `/api/library/${String(id)}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // the file is gone from disk AND the listing is empty again
      expect(existsSync(file)).toBe(false);
      const after = await h.app.inject({ method: 'GET', url: '/api/library' });
      expect(after.json()).toEqual({ files: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the row even when the file is already gone; 404s unknown ids, 400s malformed', async (): Promise<void> => {
    const h = buildHarness();
    const dir = mkdtempSync(join(tmpdir(), 'fmd-library-del2-'));
    try {
      const file = join(dir, 'ghost.zip');
      h.library.put({ moduleId: MODULE_A_ID, manga: 'M', fileName: 'ghost.zip', bytes: 5, path: file });
      const list = await h.app.inject({ method: 'GET', url: '/api/library' });
      const id = (list.json().files as { id: string }[])[0]?.id;
      const res = await h.app.inject({ method: 'DELETE', url: `/api/library/${String(id)}` });
      expect(res.statusCode).toBe(200);
      const after = await h.app.inject({ method: 'GET', url: '/api/library' });
      expect(after.json()).toEqual({ files: [] });
      // second delete of the same id → 404 (row gone)
      const again = await h.app.inject({ method: 'DELETE', url: `/api/library/${String(id)}` });
      expect(again.statusCode).toBe(404);
      expectEnvelope(again.json(), 'not_found');
      const malformed = await h.app.inject({ method: 'DELETE', url: '/api/library/not-a-number' });
      expect(malformed.statusCode).toBe(400);
      expectEnvelope(malformed.json(), 'validation_error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
