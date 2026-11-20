// @vitest-environment jsdom

/**
 * Inbox page (D1 §2 INBOX — tsk-acidic-oxbow-waits): the Home
 * feed's UI contract —
 *
 * - the NEW view renders the unacknowledged arrivals mobile-first:
 *   cover thumb, title, chapter label, site badge (the /api/modules
 *   name join) per row, plus the Caught-up bulk action;
 * - the per-row Seen button fires POST /api/inbox/ack with EXACTLY
 *   that chapter's key;
 * - Caught up fires POST /api/inbox/caught-up;
 * - the ARCHIVE view renders acknowledged entries (no ack buttons);
 * - ?view= is URL-as-truth: the view comes from the route query and
 *   the tabs target ?view=new|archive hashes;
 * - the healthy empty state celebrates being caught up.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, autoCleanup, mockFetch, type MockRoute } from './helpers';
import { InboxPage } from '../src/pages/InboxPage';
import { parseHash } from '../src/router';

autoCleanup();

const NOW = new Date().toISOString();

const MODULE_ID = 'a'.repeat(32);

function entry(overrides: Partial<{
  chapterKey: string;
  chapterLink: string;
  chapterLabel: string;
  mangaTitle: string;
  moduleId: string;
  seenAt: string | null;
}>): Record<string, unknown> {
  return {
    chapterKey: 'key-1',
    moduleId: MODULE_ID,
    mangaKey: 'manga-key-1',
    mangaUrl: 'https://site.example/manga/x',
    mangaTitle: 'Fixture Manga',
    coverLink: 'https://cdn.example/cover.jpg',
    chapterLink: 'https://site.example/ch/1',
    chapterLabel: 'Ch. 1',
    detectedAt: NOW,
    seenAt: null,
    ...overrides,
  };
}

function feedRoute(view: string, body: object): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/inbox' && (url.searchParams.get('view') ?? 'new') === view,
    respond: (): { body: object } => ({ body }),
  };
}

function modulesRoute(): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/modules',
    respond: (): { body: object } => ({
      body: { modules: [{ id: MODULE_ID, name: 'ExampleScan' }] },
    }),
  };
}

const NEW_FEED: object = {
  view: 'new',
  newCount: 2,
  entries: [
    entry({ chapterKey: 'key-1', chapterLink: 'https://site.example/ch/1', chapterLabel: 'Ch. 1' }),
    entry({
      chapterKey: 'key-2',
      chapterLink: 'https://site.example/ch/2',
      chapterLabel: 'Ch. 2',
      mangaTitle: 'Second Series',
      moduleId: 'b'.repeat(32),
    }),
  ],
};

const ARCHIVE_FEED: object = {
  view: 'archive',
  newCount: 0,
  entries: [entry({ chapterKey: 'key-1', seenAt: NOW })],
};

/** The mock fetch ALWAYS rides the providers (the helpers' contract). */
function renderPage(hash: string, fetchImpl: typeof fetch): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<InboxPage route={parseHash(hash)} />, { fetch: fetchImpl });
}

describe('InboxPage — the new feed', () => {
  it('renders arrivals with cover, title, chapter label and site badge (mobile-first rows)', async () => {
    const { fetch } = mockFetch([feedRoute('new', NEW_FEED), modulesRoute()]);
    renderPage('#/inbox', fetch);

    expect(await screen.findByTestId('inbox-feed')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-cover-key-1')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-title-key-1')).toHaveTextContent('Fixture Manga');
    expect(screen.getByTestId('inbox-chapter-key-1')).toHaveTextContent('Ch. 1');
    expect(screen.getByText('ExampleScan')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-tab-new-count')).toHaveTextContent('2');
    expect(screen.getByTestId('inbox-caught-up')).toBeEnabled();
  });

  it('the healthy empty state celebrates being caught up', async () => {
    const { fetch } = mockFetch([feedRoute('new', { view: 'new', newCount: 0, entries: [] }), modulesRoute()]);
    renderPage('#/inbox?view=new', fetch);

    expect(await screen.findByTestId('inbox-empty')).toBeInTheDocument();
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-feed')).toBeNull();
  });

  it('the per-row Seen button acknowledges EXACTLY that chapter', async () => {
    const ackRoute: MockRoute = {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/inbox/ack',
      respond: (): { body: object } => ({ body: { acknowledged: 1 } }),
    };
    const mock = mockFetch([feedRoute('new', NEW_FEED), modulesRoute(), ackRoute]);
    renderPage('#/inbox', mock.fetch);

    await screen.findByTestId('inbox-feed');
    await userEvent.click(screen.getByTestId('inbox-ack-key-2'));

    await waitFor((): void => {
      const call = mock.requests.find((c) => c.method === 'POST' && c.path.includes('/api/inbox/ack'));
      expect(call).toBeDefined();
    });
    const call = mock.requests.find((c) => c.method === 'POST' && c.path.includes('/api/inbox/ack'))!;
    expect(call.body).toEqual({ chapterKeys: ['key-2'] });
  });

  it('Caught up fires POST /api/inbox/caught-up', async () => {
    const caughtUpRoute: MockRoute = {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/inbox/caught-up',
      respond: (): { body: object } => ({ body: { acknowledged: 2 } }),
    };
    const mock = mockFetch([feedRoute('new', NEW_FEED), modulesRoute(), caughtUpRoute]);
    renderPage('#/inbox', mock.fetch);

    await screen.findByTestId('inbox-feed');
    await userEvent.click(screen.getByTestId('inbox-caught-up'));

    await waitFor((): void => {
      expect(
        mock.requests.some((c) => c.method === 'POST' && c.path.includes('/api/inbox/caught-up')),
      ).toBe(true);
    });
  });
});

describe('InboxPage — the archive view (?view= URL-as-truth)', () => {
  it('renders acknowledged entries without ack buttons, from the ?view=archive route', async () => {
    const mock = mockFetch([feedRoute('archive', ARCHIVE_FEED), modulesRoute()]);
    renderPage('#/inbox?view=archive', mock.fetch);

    expect(await screen.findByTestId('inbox-feed')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-title-key-1')).toHaveTextContent('Fixture Manga');
    expect(screen.queryByTestId('inbox-ack-key-1')).toBeNull();
    expect(screen.queryByTestId('inbox-caught-up')).toBeNull();
    // URL-as-truth: the feed call carried view=archive — never the new view
    expect(mock.requests.some((c) => c.path.includes('/api/inbox?view=archive'))).toBe(true);
    expect(mock.requests.some((c) => c.path.includes('/api/inbox?view=new'))).toBe(false);
  });

  it('the view tabs target the ?view= hashes (shareable URL truth)', async () => {
    const { fetch } = mockFetch([feedRoute('new', NEW_FEED), modulesRoute()]);
    renderPage('#/inbox', fetch);

    await screen.findByTestId('inbox-feed');
    expect(screen.getByTestId('inbox-tab-new')).toHaveAttribute('href', '#/inbox');
    expect(screen.getByTestId('inbox-tab-archive')).toHaveAttribute('href', '#/inbox?view=archive');
    expect(screen.getByTestId('inbox-tab-archive')).not.toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('inbox-tab-new')).toHaveAttribute('aria-current', 'page');
  });

  it('an unknown ?view= value renders the NEW feed (the default view)', async () => {
    const { fetch } = mockFetch([feedRoute('new', NEW_FEED), modulesRoute()]);
    renderPage('#/inbox?view=sideways', fetch);

    expect(await screen.findByTestId('inbox-feed')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-tab-new')).toHaveAttribute('aria-current', 'page');
  });

  it('the archive empty state explains itself', async () => {
    const { fetch } = mockFetch([feedRoute('archive', { view: 'archive', newCount: 0, entries: [] }), modulesRoute()]);
    renderPage('#/inbox?view=archive', fetch);

    expect(await screen.findByText('Nothing in the archive.')).toBeInTheDocument();
  });
});
