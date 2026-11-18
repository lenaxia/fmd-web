// @vitest-environment jsdom
/**
 * Back-context (UX audit M-1): the manga detail page's Back button
 * must restore the ORIGINATING view, not dump the user on the search
 * home. Three layered behaviors pinned here:
 *
 *   1. fresh deep link (no `from`, no in-app history) → the legacy
 *      fallback: the catalog site list / browse home;
 *   2. `from=` present (every entry row stamps it) → Back returns to
 *      the exact origin hash — full list state restored;
 *   3. navigateToManga stamps the current hash as `from` and CHAINS
 *      it across manga→manga hops (back always lands on a list).
 *
 * Test order matters for (1): the in-app-history flag is router
 * module state that flips on the first hashchange, so the no-history
 * case runs FIRST (pristine module), before any hash assignment.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MangaPage } from '../src/pages/MangaPage';
import { navigateToManga, parseHash } from '../src/router';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, MODULE_ID, favoriteFixture, infoFixture, jobFixture } from './fixtures';

autoCleanup();

function routes(): MockRoute[] {
  return [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/favorites',
      respond: (): { body: object } => ({ body: { favorites: [] } }),
    },
    {
      method: 'GET',
      match: (url): boolean => url.pathname.startsWith('/api/favorites/'),
      respond: (): { body: object } => ({ body: { favorite: favoriteFixture() } }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/info',
      respond: (): { body: object } => ({ body: infoFixture() }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/jobs/download',
      respond: (): { status: number; body: object } => ({ status: 201, body: { job: jobFixture('job-1') } }),
    },
  ];
}

describe('MangaPage back-context (M-1)', (): void => {
  it('fresh deep link without from= falls back to the catalog site list (no history to restore)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(
      <MangaPage
        route={parseHash(`#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent(infoFixture().url)}&title=Fixture+Manga`)}
      />,
      { fetch },
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: /Back to browse/ }));
    expect(globalThis.location.hash).toBe(`#/browse?catalog=${CATALOG_ID}`);
  });

  it('Back restores the recorded origin list verbatim (from= wins over every fallback)', async (): Promise<void> => {
    const origin: string = `#/browse?site=${MODULE_ID}&q=frieren`;
    const { fetch } = mockFetch(routes());
    renderWithProviders(
      <MangaPage
        route={parseHash(
          `#/manga?module=${MODULE_ID}&url=${encodeURIComponent(infoFixture().url)}&from=${encodeURIComponent(origin)}`,
        )}
      />,
      { fetch },
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: /Back to browse/ }));
    expect(globalThis.location.hash).toBe(origin);
  });

  it('an invalid from= never navigates off-app (malformed values fall through to the safe chain)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(
      <MangaPage
        route={parseHash(
          `#/manga?module=${MODULE_ID}&url=${encodeURIComponent(infoFixture().url)}&from=${encodeURIComponent('https://example.org/phish')}`,
        )}
      />,
      { fetch },
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: /Back to browse/ }));
    // In-app history exists by now (earlier tests navigated), so the
    // malformed origin is refused and history.back() applies — the
    // hash stays an in-app route, never the injected absolute URL.
    expect(globalThis.location.hash.startsWith('#/')).toBe(true);
    expect(globalThis.location.hash).not.toContain('example.org');
  });
});

describe('navigateToManga origin stamping (M-1)', (): void => {
  it('stamps the current hash as from= so Back can restore the full list state', (): void => {
    globalThis.location.hash = `#/browse?site=${MODULE_ID}&q=one+piece`;
    navigateToManga({ module: MODULE_ID, url: 'https://ex.org/manga/1', title: 'One Piece' });
    const route = parseHash(globalThis.location.hash);
    expect(route.name).toBe('manga');
    expect(route.query['module']).toBe(MODULE_ID);
    expect(route.query['from']).toBe(`#/browse?site=${MODULE_ID}&q=one+piece`);
  });

  it('chained manga→manga navigation preserves the ORIGINAL origin (back always reaches a list)', (): void => {
    const origin: string = `#/browse?sites=1`;
    globalThis.location.hash = `#/manga?module=${MODULE_ID}&url=https://ex.org/manga/1&from=${encodeURIComponent(origin)}`;
    navigateToManga({ module: MODULE_ID, url: 'https://ex.org/manga/2', title: 'Second' });
    const route = parseHash(globalThis.location.hash);
    expect(route.query['url']).toBe('https://ex.org/manga/2');
    expect(route.query['from']).toBe(origin);
  });
});
