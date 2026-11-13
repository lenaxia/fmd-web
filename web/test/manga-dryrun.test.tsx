// @vitest-environment jsdom
/**
 * Manga detail page: info display + chapter list + enqueue dry-run.
 * The dry-run preview shows the EXACT `POST /api/jobs/download` body
 * (with deterministic idempotency key) without sending anything;
 * enqueue POSTs the same shape.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MangaPage } from '../src/pages/MangaPage';
import { buildDownloadJobBody, dryRunJson, idempotencyKeyFor } from '../src/api/dry-run';
import { parseHash } from '../src/router';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, MODULE_ID, infoFixture } from './fixtures';

autoCleanup();

const QUERY = {
  catalog: CATALOG_ID,
  module: MODULE_ID,
  url: infoFixture().url,
  title: infoFixture().title,
};

function infoRoutes(posted: unknown[]): MockRoute[] {
  return [
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/info',
      respond: (): { body: object } => ({ body: infoFixture() }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/jobs/download',
      respond: (_url, body): { status: number; body: object } => {
        posted.push(body);
        return { status: 201, body: { job: { id: 'job-1', type: 'download', moduleId: MODULE_ID, payload: {}, state: 'queued', priority: 0, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' } } };
      },
    },
  ];
}

describe('dry-run pure builders', (): void => {
  it('builds the body with a deterministic idempotency key', (): void => {
    const input = { moduleId: MODULE_ID, mangaUrl: 'https://x.example/m/1', chapterLink: '/m/1/c1', mangaTitle: 'T', chapterName: 'C1' };
    expect(idempotencyKeyFor(input)).toBe(idempotencyKeyFor({ ...input }));
    expect(idempotencyKeyFor(input)).toMatch(/^dl-[0-9a-f]{8}$/);
    const body = buildDownloadJobBody(input);
    expect(body).toEqual({ ...input, idempotencyKey: idempotencyKeyFor(input) });
  });

  it('renders stable JSON for the preview', (): void => {
    const json = dryRunJson({ moduleId: MODULE_ID, mangaUrl: 'https://x.example/m/1', chapterLink: '/m/1/c1' });
    expect(JSON.parse(json)).toEqual({
      moduleId: MODULE_ID,
      mangaUrl: 'https://x.example/m/1',
      chapterLink: '/m/1/c1',
      idempotencyKey: idempotencyKeyFor({ moduleId: MODULE_ID, mangaUrl: 'https://x.example/m/1', chapterLink: '/m/1/c1' }),
    });
  });
});

describe('MangaPage', (): void => {
  it('renders info + chapters, previews the enqueue body (dry-run), then POSTs it', async (): Promise<void> => {
    const posted: unknown[] = [];
    const { fetch, requests } = mockFetch(infoRoutes(posted));
    renderWithProviders(<MangaPage route={parseHash(`#/manga?${new URLSearchParams(QUERY).toString()}`)} />, { fetch });

    // Info display (§5.8 normalized)
    expect(await screen.findByRole('heading', { name: 'Fixture Manga' })).toBeInTheDocument();
    expect(screen.getByText('Action, Comedy')).toBeInTheDocument();
    expect(screen.getByText('Ongoing')).toBeInTheDocument();

    // Chapter list
    expect(screen.getByText(/Chapters \(3\)/)).toBeInTheDocument();

    // Dry-run: select chapter 1 → preview shows the exact body, nothing POSTed
    expect(screen.getByText(/nothing is sent/i)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Chapter 1'));
    const preview = screen.getByLabelText('Enqueue request preview');
    expect(preview.textContent).toContain(`"moduleId": "${MODULE_ID}"`);
    expect(preview.textContent).toContain('"chapterLink": "/manga/fixture/ch-1"');
    expect(preview.textContent).toContain('"idempotencyKey"');
    expect(requests.filter((r): boolean => r.path === '/api/jobs/download')).toHaveLength(0);

    // Enqueue POSTs the same shape
    await userEvent.click(screen.getByRole('button', { name: /Enqueue 1 chapter/ }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/Job .* queued/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      moduleId: MODULE_ID,
      mangaUrl: QUERY.url,
      mangaTitle: 'Fixture Manga',
      chapterLink: '/manga/fixture/ch-1',
      chapterName: 'Chapter 1',
    });
  });

  it('guides to Browse when the route lacks module/url', (): void => {
    const { fetch, requests } = mockFetch([]);
    renderWithProviders(<MangaPage route={parseHash('#/manga')} />, { fetch });
    expect(screen.getByText('No manga selected')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});
