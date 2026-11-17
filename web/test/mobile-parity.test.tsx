// @vitest-environment jsdom
/**
 * Mobile parity unit surface (R3 — tsk-verdant-manger-hovers):
 *
 * - EntryMetadataPopover DUAL ACTIVATION: the default (hover-capable)
 *   pointer keeps the HoverCard; the touch surface (no hover) opens
 *   the SAME metadata via Radix Popover semantics on row tap, with the
 *   popover's own Open button carrying the row's navigation.
 * - BottomTabNav pattern: five destinations, aria-current on the
 *   active route, one shared route set with the top nav.
 * - NewChaptersSheet drag-dismiss grabber: present, labelled, and the
 *   keyboard path (Escape) closes (the pointer drag itself is e2e —
 *   jsdom has no layout).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { BrowsePage } from '../src/pages/BrowsePage';
import { parseHash } from '../src/router';
import { BottomTabNav } from '../src/components/patterns/BottomTabNav';
import { NewChaptersSheet, type NewChapterRow } from '../src/components/favorites/NewChaptersSheet';
import { autoCleanup, mockFetch, renderWithProviders, stubTouchMedia, type MockRoute, type MockRouteResult } from './helpers';
import { MODULE_ID, entryFixture, moduleFixture } from './fixtures';

autoCleanup();

/** The helpers' desktop default ((hover: hover) matches) — restored per suite. */
const desktopMatchMedia: (query: string) => MediaQueryList = globalThis.matchMedia.bind(globalThis);

const routes: MockRoute[] = [
  { method: 'GET', match: (url): boolean => url.pathname === '/api/modules', respond: (): MockRouteResult => ({ body: { modules: [moduleFixture()], count: 1 } }) },
  { method: 'GET', match: (url): boolean => url.pathname === `/api/catalog/${MODULE_ID}/latest`, respond: (): MockRouteResult => ({ body: { entries: [entryFixture('/manga/alpha', 'Alpha Quest', { authors: 'Author A' })], total: 1 } }) },
  { method: 'GET', match: (url): boolean => url.pathname === '/api/favorites', respond: (): MockRouteResult => ({ body: { favorites: [] } }) },
];

describe('EntryMetadataPopover activation (R3a)', (): void => {
  afterEach((): void => {
    globalThis.matchMedia = desktopMatchMedia;
  });

  it('touch surface: row TAP opens the metadata popover; its Open button navigates', async (): Promise<void> => {
    stubTouchMedia();
    const fetch = mockFetch(routes).fetch;
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?site=${MODULE_ID}`)} />, { fetch, hash: `#/browse?site=${MODULE_ID}` });

    // Tap = click on the row button (the touch branch's activation).
    // The settle lets the media query flip the row onto the touch
    // branch (one remount after mount — desktop is the stable default).
    await screen.findByText('Alpha Quest');
    await new Promise((resolve): void => {
      setTimeout(resolve, 20);
    });
    fireEvent.click(screen.getByText('Alpha Quest'));

    const popover = await screen.findByTestId('entry-metadata');
    expect(popover).toBeVisible();
    expect(popover).toHaveAttribute('data-entry-link', '/manga/alpha');
    expect(screen.getByText('Author A')).toBeVisible();

    // The navigation affordance lives INSIDE the popover now.
    const open = screen.getByTestId('entry-metadata-open');
    expect(open).toHaveAttribute('aria-label', 'Open manga page for Alpha Quest');
    fireEvent.click(open);
    expect(globalThis.location.hash).toContain('#/manga?');
    expect(globalThis.location.hash).toContain(encodeURIComponent('/manga/alpha'));
  });

  it('hover surface (desktop default): the row tap navigates, no popover button', async (): Promise<void> => {
    const fetch = mockFetch(routes).fetch;
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?site=${MODULE_ID}`)} />, { fetch, hash: `#/browse?site=${MODULE_ID}` });

    // Desktop semantics unchanged: clicking the row navigates.
    fireEvent.click(await screen.findByText('Alpha Quest'));
    expect(globalThis.location.hash).toContain('#/manga?');
    expect(screen.queryByTestId('entry-metadata-open')).toBeNull();
  });
});

describe('BottomTabNav pattern (R3 shell)', (): void => {
  const destinations = [
    { name: 'browse', label: 'Browse', icon: <span aria-hidden="true" /> },
    { name: 'favorites', label: 'Favorites', icon: <span aria-hidden="true" /> },
    { name: 'downloads', label: 'Downloads', icon: <span aria-hidden="true" /> },
    { name: 'library', label: 'Library', icon: <span aria-hidden="true" /> },
    { name: 'settings', label: 'Settings', icon: <span aria-hidden="true" /> },
  ];

  it('renders the five destinations with aria-current on the active route only', (): void => {
    const { container } = renderWithProviders(
      <BottomTabNav destinations={destinations} current="favorites" />,
    );
    const nav = container.querySelector('[data-testid="bottom-nav"]');
    expect(nav).not.toBeNull();
    const links = nav?.querySelectorAll('a') ?? [];
    expect(links).toHaveLength(5);
    const current = nav?.querySelector('a[aria-current="page"]');
    expect(current?.getAttribute('data-testid')).toBe('bottom-nav-favorites');
    expect(current?.textContent).toContain('Favorites');
  });

  it('every destination targets the same hash routes as the top nav', (): void => {
    const { container } = renderWithProviders(
      <BottomTabNav destinations={destinations} current="browse" />,
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a): string => a.getAttribute('href') ?? '');
    expect(hrefs).toEqual(['#/browse', '#/favorites', '#/downloads', '#/library', '#/settings']);
  });
});

describe('NewChaptersSheet drag-dismiss grabber (R3)', (): void => {
  const rows: NewChapterRow[] = [
    {
      favoriteId: `${MODULE_ID}alpha`,
      title: 'Alpha Quest',
      website: 'FixtureSite',
      count: 2,
      autoDownload: false,
      preQueued: false,
      newChapters: [{ position: 1, link: '/manga/alpha/ch-1', name: 'Chapter 1' }],
    },
  ];

  it('renders the grabber; Escape dismisses exactly once (Radix dialog path)', async (): Promise<void> => {
    let closed = 0;
    renderWithProviders(
      <NewChaptersSheet
        open
        onClose={(): void => {
          closed += 1;
        }}
        rows={rows}
        onDownload={(): void => undefined}
        onQueue={(): void => undefined}
      />,
    );
    const handle = await screen.findByTestId('new-chapters-drag-handle');
    expect(handle).toHaveAttribute('aria-hidden', 'true');
    // Radix Dialog owns the Escape path (document-level).
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toBe(1);
    cleanup();
  });
});
