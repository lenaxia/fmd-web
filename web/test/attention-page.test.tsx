// @vitest-environment jsdom

/**
 * Attention page (D1 §2 TRIAGE — tsk-granite-crown-orders): the one
 * attention surface's UI contract —
 *
 * - the HEALTHY state renders an explicit empty state that celebrates
 *   doing nothing (failedTotal 0);
 * - failures render GROUPED BY CAUSE with counts, per-site buckets,
 *   availability chips and job rows;
 * - each group's Retry all fires POST /api/triage/retry with its cause
 *   (the per-host PACING itself is pinned server-side over the real
 *   download lane — triage-retry-pacing.test.ts);
 * - the dead-site group cross-links into the registry availability
 *   column (#/settings?section=websites) and its retry button is
 *   NEVER disabled by the unreachable record (hints never block);
 * - the route is reachable from primary nav (the router carries
 *   'attention'; the App shell's module-level invariant enforces the
 *   tab sets stay in sync with ROUTE_NAMES).
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, autoCleanup, mockFetch, type MockRoute } from './helpers';
import { AttentionPage } from '../src/pages/AttentionPage';
import { parseHash, ROUTE_NAMES } from '../src/router';

autoCleanup();

const NOW = new Date().toISOString();

function snapshotRoute(body: object): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/triage',
    respond: (): { body: object } => ({ body }),
  };
}

const HEALTHY: object = {
  failedTotal: 0,
  generatedAt: NOW,
  groups: [
    { cause: 'site_dead', count: 0, sites: [] },
    { cause: 'antibot', count: 0, sites: [] },
    { cause: 'throttled', count: 0, sites: [] },
    { cause: 'other', count: 0, sites: [] },
  ],
};

const LOADED: object = {
  failedTotal: 3,
  generatedAt: NOW,
  groups: [
    {
      cause: 'site_dead',
      count: 1,
      sites: [
        {
          moduleId: 'dead'.padEnd(32, '0'),
          siteName: 'DeadSource',
          availability: { status: 'unreachable', checkedAt: NOW, reason: 'connect ECONNREFUSED' },
          jobs: [
            {
              id: '11',
              mangaTitle: 'Silent Quest',
              chapterName: 'Ch. 4',
              error: 'connect ECONNREFUSED',
              failureKind: 'net',
              updatedAt: NOW,
            },
          ],
        },
      ],
    },
    { cause: 'antibot', count: 0, sites: [] },
    {
      cause: 'throttled',
      count: 2,
      sites: [
        {
          moduleId: 'throttled'.padEnd(32, '0'),
          siteName: 'ThrottledSource',
          availability: { status: 'unknown', checkedAt: null, reason: null },
          jobs: [
            { id: '21', mangaTitle: 'Paced Quest', chapterName: 'Ch. 1', error: 'HTTP 429 too many requests', failureKind: 'net', updatedAt: NOW },
            { id: '22', mangaTitle: 'Paced Quest', chapterName: 'Ch. 2', error: 'HTTP 429', failureKind: 'net', updatedAt: NOW },
          ],
        },
      ],
    },
    { cause: 'other', count: 0, sites: [] },
  ],
};

describe('AttentionPage — the healthy state', (): void => {
  it('renders an explicit empty state that celebrates doing nothing', async (): Promise<void> => {
    const { fetch } = mockFetch([snapshotRoute(HEALTHY)]);
    renderWithProviders(<AttentionPage />, { fetch });
    expect(await screen.findByTestId('attention-empty')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
    // no group cards render when there is nothing to triage
    expect(screen.queryByTestId('attention-group-site_dead')).toBeNull();
  });
});

describe('AttentionPage — grouped failures', (): void => {
  it('renders only non-empty groups, with counts, site names, availability chips and job rows', async (): Promise<void> => {
    const { fetch } = mockFetch([snapshotRoute(LOADED)]);
    renderWithProviders(<AttentionPage />, { fetch });

    expect(await screen.findByTestId('attention-group-site_dead')).toBeInTheDocument();
    expect(screen.getByTestId('attention-group-throttled')).toBeInTheDocument();
    expect(screen.queryByTestId('attention-group-antibot')).toBeNull();
    expect(screen.queryByTestId('attention-group-other')).toBeNull();

    expect(screen.getByText('DeadSource')).toBeInTheDocument();
    expect(screen.getByText('ThrottledSource')).toBeInTheDocument();
    expect(screen.getByText('2 chapters')).toBeInTheDocument();
    expect(screen.getByText('Silent Quest')).toBeInTheDocument();
    expect(screen.getByText('Ch. 2')).toBeInTheDocument();
  });

  it('Retry all fires POST /api/triage/retry with the group cause', async (): Promise<void> => {
    const retryRoute: MockRoute = {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/triage/retry',
      respond: (): { body: object } => ({
        body: { cause: 'throttled', affected: 2, jobs: [] },
      }),
    };
    const { fetch, requests } = mockFetch([snapshotRoute(LOADED), retryRoute]);
    renderWithProviders(<AttentionPage />, { fetch });

    await userEvent.click(await screen.findByTestId('attention-retry-throttled'));
    await waitFor((): void => {
      expect(requests.some((r): boolean => r.method === 'POST' && r.path === '/api/triage/retry' && r.body !== undefined && (r.body as { cause?: string }).cause === 'throttled')).toBe(true);
    });
  });

  it('dead-site rows: registry cross-link present, and the unreachable record NEVER disables Retry all (D1 §3)', async (): Promise<void> => {
    const { fetch } = mockFetch([snapshotRoute(LOADED)]);
    renderWithProviders(<AttentionPage />, { fetch });

    // the cross-link into the registry availability column
    const link = await screen.findByTestId(`attention-registry-link-${'dead'.padEnd(32, '0')}`);
    expect(link).toHaveAttribute('href', '#/settings?section=websites');

    // hints dim and explain — they never gate the manual action
    const retry = screen.getByTestId('attention-retry-site_dead') as HTMLButtonElement;
    expect(retry).toBeEnabled();
    // the dimming itself: the dead group's site card renders dimmed copy
    expect(screen.getByText(/never blocks a retry/i)).toBeInTheDocument();
  });
});

describe('Attention route reachability', (): void => {
  it("the router carries 'attention' as a primary route (the App shell invariant pins the nav sets)", (): void => {
    expect(ROUTE_NAMES.includes('attention')).toBe(true);
    expect(parseHash('#/attention').name).toBe('attention');
    expect(parseHash('#/attention?cause=site_dead').query['cause']).toBe('site_dead');
  });
});
