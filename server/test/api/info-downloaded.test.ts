/**
 * The downloaded-chapter set embedded in POST /api/info (MangaPage
 * tint/hide parity): served from the §9 ledger seam at RESPONSE time —
 * never cached with the info snapshot — so a ledger change flips the
 * set on the very next call, cache hit or not.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, MODULE_A_ID } from './helpers.js';

const BODY = { moduleId: MODULE_A_ID, url: 'https://ex.org/manga/x' };

describe('POST /api/info — embedded downloaded set', (): void => {
  it('carries the ledger links (empty when nothing downloaded)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).downloaded).toEqual([]);
  });

  it('projects the ledger rows for this (moduleId, url)', async (): Promise<void> => {
    const h = buildHarness();
    h.library.setDownloadedChapters(MODULE_A_ID, BODY.url, ['https://ex.org/ch/1']);
    const res = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect((res.json() as Record<string, unknown>).downloaded).toEqual(['https://ex.org/ch/1']);
  });

  it('is computed at response time: a ledger change surfaces on a CACHE HIT (info engine not re-run)', async (): Promise<void> => {
    const h = buildHarness({ infoTtlMs: 10_000 });
    h.library.setDownloadedChapters(MODULE_A_ID, BODY.url, ['https://ex.org/ch/1']);
    const first = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect((first.json() as Record<string, unknown>).downloaded).toEqual(['https://ex.org/ch/1']);
    expect(h.info.calls).toHaveLength(1);

    // The ledger grows (a download finished) while the info snapshot is
    // still cached — the NEXT response must carry the fresh set WITHOUT
    // re-running the module engine.
    h.library.setDownloadedChapters(MODULE_A_ID, BODY.url, ['https://ex.org/ch/1', 'https://ex.org/ch/2']);
    const second = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect((second.json() as Record<string, unknown>).downloaded).toEqual([
      'https://ex.org/ch/1',
      'https://ex.org/ch/2',
    ]);
    expect(h.info.calls).toHaveLength(1); // cache hit — the set is not cached
  });

  it('keys the ledger per manga (a different url reads its own row)', async (): Promise<void> => {
    const h = buildHarness();
    h.library.setDownloadedChapters(MODULE_A_ID, BODY.url, ['https://ex.org/ch/1']);
    h.library.setDownloadedChapters(MODULE_A_ID, 'https://ex.org/manga/y', ['https://ex.org/y/9']);
    const y = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: 'https://ex.org/manga/y' },
    });
    expect((y.json() as Record<string, unknown>).downloaded).toEqual(['https://ex.org/y/9']);
  });
});
