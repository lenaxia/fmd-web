// @vitest-environment jsdom
/**
 * [crystal-nectar-pricks] PasteUrlAdd — the paste-URL universal front
 * door: resolve-by-host preview (title / cover via the proxy seam /
 * alt titles), the ONE-decision follow (plain vs auto-download — the
 * POSTed body is the ONLY difference), typed error guidance for
 * no_site_match / ambiguous_site (never a bare 500 page), and the
 * palette arm channel (armPasteUrl consumed at mount auto-resolves).
 */
import { fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PasteUrlAdd } from '../src/components/catalog/PasteUrlAdd';
import { armPasteUrl, normalizePastedUrl } from '../src/state/paste-url-arm';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';

autoCleanup();

const INFO = {
  moduleId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  title: 'Alpha Quest',
  url: 'https://fixtures.example/manga/alpha',
  altTitles: 'Alpha Quest (Alt)',
  authors: 'Author A',
  artists: 'Artist B',
  genres: 'Action',
  status: 'Ongoing',
  summary: 'The alpha fixture manga.',
  coverLink: 'https://cdn.example/cover.jpg',
  link: '/manga/alpha',
  chapterLinks: ['/manga/alpha/ch-1'],
  chapterNames: ['Chapter 1'],
  numChapter: 1,
  downloaded: [],
};

const FAVORITE = {
  id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  moduleId: INFO.moduleId,
  url: INFO.url,
  title: INFO.title,
  status: 'Ongoing',
  currentChapter: 1,
  newChapterCount: 0,
  autoDownload: false,
  lastCheck: null,
  lastUpdated: null,
  saveTo: null,
  enabled: true,
  dateAdded: '2026-11-19T00:00:00Z',
  coverLink: null,
};

/** The registry join feeding the preview's Website badge. */
const MODULES = {
  modules: [
    {
      id: INFO.moduleId,
      name: 'FixtureSite',
      rootURL: 'https://fixtures.example',
      category: 'Fixtures',
      accountSupport: false,
      file: 'modules/FixtureSite.lua',
      enabled: true,
      proxy: null,
      catalogInstalled: true,
      availability: { status: 'unknown', checkedAt: null, reason: null },
      options: [],
      capabilities: {
        requires_subprocess: false,
        requires_browser: false,
        bypass_python_gated: false,
        requires_imagepuzzle: false,
        requires_mangafoxwatermark: false,
        events: [],
        known_broken_flags: [],
        live_scrape_fallback: false,
      },
    },
  ],
  count: 1,
};

type MockRouteResult = { status?: number; body: unknown };

const route = (
  method: string,
  path: string,
  respond: (body: unknown) => MockRouteResult,
): MockRoute => ({
  method,
  match: (url): boolean => url.pathname === path,
  respond: (_url, body): MockRouteResult => respond(body),
});

const modulesRoute = route('GET', '/api/modules', (): MockRouteResult => ({ body: MODULES }));
const favoritesListRoute = route('GET', '/api/favorites', (): MockRouteResult => ({
  body: { favorites: [FAVORITE] },
}));
const emptyFavoritesRoute = route('GET', '/api/favorites', (): MockRouteResult => ({
  body: { favorites: [] },
}));
const createFavoriteRoute = route('POST', '/api/favorites', (body): MockRouteResult => {
  const input = body as { autoDownload?: boolean };
  return {
    status: 201,
    body: { favorite: { ...FAVORITE, ...(input.autoDownload === true ? { autoDownload: true } : {}) } },
  };
});
const infoRoute = route('POST', '/api/info', (): MockRouteResult => ({ body: INFO }));

describe('normalizePastedUrl', (): void => {
  it('keeps absolute http(s) urls and upgrades scheme-less hosts', (): void => {
    expect(normalizePastedUrl('  https://fixtures.example/manga/alpha ')).toBe(
      'https://fixtures.example/manga/alpha',
    );
    expect(normalizePastedUrl('fixtures.example/manga/alpha')).toBe(
      'https://fixtures.example/manga/alpha',
    );
    expect(normalizePastedUrl('www.mangadex.org/title/x')).toBe('https://www.mangadex.org/title/x');
  });

  it('rejects non-url text', (): void => {
    expect(normalizePastedUrl('one piece')).toBeUndefined();
    expect(normalizePastedUrl('')).toBeUndefined();
  });
});

describe('PasteUrlAdd — paste-URL front door', (): void => {
  beforeEach((): void => {
    globalThis.location.hash = '';
  });

  it('resolves by host and previews title, cover (proxy) and alt titles', async (): Promise<void> => {
    const { fetch } = mockFetch([infoRoute, modulesRoute, emptyFavoritesRoute]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'https://fixtures.example/manga/alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-preview')).toBeInTheDocument();
    });
    // The url-only body: the SERVER resolves the module by host (the
    // POST body assertion lives in the Follow tests' requests log).
    expect(screen.getByText('Alpha Quest')).toBeInTheDocument();
    expect(screen.getByTestId('paste-url-alt-titles')).toHaveTextContent('Alpha Quest (Alt)');
    // Cover routes through the same-origin proxy seam, never the CDN.
    expect(screen.getByTestId('paste-url-cover').querySelector('img')?.getAttribute('src')).toBe(
      `/api/cover?moduleId=${INFO.moduleId}&url=${encodeURIComponent(INFO.coverLink)}`,
    );
    expect(screen.getByText('FixtureSite')).toBeInTheDocument();
    expect(screen.getByTestId('paste-url-follow')).toBeEnabled();
  });

  it('Follow posts the favorite and flips to the done state (one decision, no wizard)', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([
      infoRoute,
      modulesRoute,
      emptyFavoritesRoute,
      createFavoriteRoute,
    ]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'https://fixtures.example/manga/alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-preview')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('paste-url-follow'));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-done')).toBeInTheDocument();
    });
    const posted = requests.find((r): boolean => r.method === 'POST' && r.path === '/api/favorites');
    expect(posted?.body).toEqual({
      moduleId: INFO.moduleId,
      url: INFO.url,
      title: INFO.title,
    });
  });

  it('Follow + auto-download posts autoDownload: true — the only difference', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([
      infoRoute,
      modulesRoute,
      emptyFavoritesRoute,
      createFavoriteRoute,
    ]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'https://fixtures.example/manga/alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-preview')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('paste-url-follow-auto'));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-done')).toHaveTextContent('download automatically');
    });
    const posted = requests.find((r): boolean => r.method === 'POST' && r.path === '/api/favorites');
    expect(posted?.body).toEqual({
      moduleId: INFO.moduleId,
      url: INFO.url,
      title: INFO.title,
      autoDownload: true,
    });
  });

  it('already-favorited manga shows the done state without a second add', async (): Promise<void> => {
    const { fetch } = mockFetch([infoRoute, modulesRoute, favoritesListRoute]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'https://fixtures.example/manga/alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-done')).toBeInTheDocument();
    });
    expect(screen.getByTestId('paste-url-done')).toHaveTextContent('Already in your Favorites');
  });

  it('unknown host surfaces no_site_match with human guidance, never a 500 page', async (): Promise<void> => {
    const noMatch = route('POST', '/api/info', (): MockRouteResult => ({
      status: 400,
      body: { error: { code: 'no_site_match', message: 'no site matches this URL' } },
    }));
    const { fetch, requests } = mockFetch([noMatch, modulesRoute, emptyFavoritesRoute]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'https://nowhere.example/manga/x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-error')).toBeInTheDocument();
    });
    const alert = screen.getByTestId('paste-url-error');
    expect(alert.getAttribute('data-error-code')).toBe('no_site_match');
    expect(alert).toHaveTextContent('No site matches this URL');
    expect(alert).toHaveTextContent("module for");
    expect(
      screen.getByRole('button', { name: 'Browse supported sites' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('paste-url-preview')).not.toBeInTheDocument();
    expect(requests.filter((r): boolean => r.path === '/api/favorites' && r.method === 'POST')).toHaveLength(0);
  });

  it('ambiguous host names the candidate sites', async (): Promise<void> => {
    const ambiguous = route('POST', '/api/info', (): MockRouteResult => ({
      status: 400,
      body: {
        error: {
          code: 'ambiguous_site',
          message: 'host shared by: MangaDexA, MangaDexB',
        },
      },
    }));
    const { fetch } = mockFetch([ambiguous, modulesRoute, emptyFavoritesRoute]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'https://ambiguous.example/manga/x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-error')).toBeInTheDocument();
    });
    const alert = screen.getByTestId('paste-url-error');
    expect(alert.getAttribute('data-error-code')).toBe('ambiguous_site');
    expect(alert).toHaveTextContent('MangaDexA, MangaDexB');
    expect(alert).toHaveTextContent('more than one site');
  });

  it('non-url input is guidance, not a request', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([infoRoute, modulesRoute, emptyFavoritesRoute]);
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    fireEvent.change(screen.getByLabelText('Add by URL'), {
      target: { value: 'just some words' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('paste-url-error')).toHaveTextContent("doesn't look like a web address");
    expect(requests.filter((r): boolean => r.path === '/api/info')).toHaveLength(0);
  });

  it('a pending palette arm is consumed at mount and auto-resolves', async (): Promise<void> => {
    const { fetch } = mockFetch([infoRoute, modulesRoute, emptyFavoritesRoute]);
    armPasteUrl('https://fixtures.example/manga/alpha');
    const screen = renderWithProviders(<PasteUrlAdd />, { fetch });
    await waitFor((): void => {
      expect(screen.getByTestId('paste-url-preview')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Add by URL')).toHaveValue('https://fixtures.example/manga/alpha');
    // Exactly-once: a second mount (no new arm) resolves nothing.
    expect(screen.queryByTestId('paste-url-error')).not.toBeInTheDocument();
  });
});
