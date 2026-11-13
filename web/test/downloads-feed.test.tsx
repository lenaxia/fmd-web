// @vitest-environment jsdom
/**
 * Downloads page: job list cursor pagination + the D19 live feed —
 * WS events patch the rendered rows; a reconnecting socket surfaces
 * the reconnect status; `resync` triggers a refetch.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadsPage } from '../src/pages/DownloadsPage';
import { patchJobsPage } from '../src/state/use-jobs-feed';
import type { JobsPageT } from '../src/api/hooks';
import type { WsLike } from '../src/state/ws-backfill';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { jobFixture } from './fixtures';

autoCleanup();

function jobsRoutes(state: string, jobs: ReturnType<typeof jobFixture>[], opts?: { nextCursor?: string; page?: number }): MockRoute {
  const page = opts?.page ?? 1;
  return {
    method: 'GET',
    match: (url): boolean =>
      url.pathname === '/api/jobs' &&
      (state === '' ? url.searchParams.get('state') === null : url.searchParams.get('state') === state) &&
      (page === 1 ? url.searchParams.get('cursor') === null : url.searchParams.get('cursor') === 'c9'),
    respond: (): { body: object } => ({
      body: {
        jobs,
        ...(opts?.nextCursor !== undefined ? { nextCursor: opts.nextCursor } : {}),
      },
    }),
  };
}

describe('patchJobsPage (cache patch)', (): void => {
  it('replaces a matching job and prepends unknown ones', (): void => {
    const base: JobsPageT = { jobs: [jobFixture('j1', { state: 'running' })] };
    const updated = patchJobsPage(base, jobFixture('j1', { state: 'done' }));
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0]?.state).toBe('done');
    const added = patchJobsPage(updated, jobFixture('j2'));
    expect(added.jobs.map((j): string => j.id)).toEqual(['j2', 'j1']);
  });
});

describe('DownloadsPage', (): void => {
  it('renders jobs, filters by state, and loads more via cursor', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([
      jobsRoutes('', [jobFixture('j1')], { nextCursor: 'c9' }),
      jobsRoutes('', [jobFixture('j2')], { page: 2 }),
      jobsRoutes('done', [jobFixture('j3', { state: 'done' })]),
    ]);
    renderWithProviders(<DownloadsPage />, { fetch });

    expect(await screen.findByText('Fixture Manga — Chapter 1')).toBeInTheDocument();
    expect(screen.getByText(/Event stream:/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findAllByText('Fixture Manga — Chapter 1')).toHaveLength(2);
    // both pages' rows are in the DOM (appended, not replaced)
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await userEvent.selectOptions(screen.getByLabelText('Filter by state'), 'done');
    expect(requests.some((r): boolean => r.path.includes('state=done'))).toBe(true);
    expect(requests.filter((r): boolean => r.path.startsWith('/api/jobs')).map((r): string => r.path)).toEqual([
      '/api/jobs?limit=20',
      '/api/jobs?limit=20&cursor=c9',
      '/api/jobs?limit=20&state=done',
    ]);
  });

  it('shows the empty-state guidance when there are no jobs', async (): Promise<void> => {
    const { fetch } = mockFetch([jobsRoutes('', [])]);
    renderWithProviders(<DownloadsPage />, { fetch });
    expect(await screen.findByText('No download jobs')).toBeInTheDocument();
    expect(screen.getByText(/Enqueue chapters from a/)).toBeInTheDocument();
  });

  it('surfaces WS reconnect attempts and still lists jobs (offline degrade)', async (): Promise<void> => {
    const attempts = { count: 0 };
    // No WebSocket in this env: the controller stays 'connecting', the
    // job list still renders (REST) — graceful degrade.
    class NoSocket implements WsLike {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      constructor() {
        attempts.count += 1;
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', NoSocket);
    try {
      const { fetch } = mockFetch([jobsRoutes('', [jobFixture('j1')])]);
      renderWithProviders(<DownloadsPage />, { fetch });
      expect(await screen.findByText('Fixture Manga — Chapter 1')).toBeInTheDocument();
      expect(attempts.count).toBe(1);
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
