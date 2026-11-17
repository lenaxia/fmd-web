// @vitest-environment jsdom
/**
 * Browse-list polish (FMD2 manga-list affordances):
 *
 * - EntryMetadataPopover: the FULL §5.8 catalog metadata on hover
 *   (vtMangaListGetHint parity, frmMain.pas:5161-5226) — fixture-driven,
 *   and ZERO network on hover (catalog data only, no /api/info).
 * - Row accents: the new/completed matrix (vtMangaListBeforeCellPaint,
 *   pas:5114-5152) gated by the persisted highlight-new toggle
 *   (miHighlightNewManga, lfm:5817) with the filter's only-new day
 *   window; completed is ungated and overrides new (FMD2 paint order).
 * - EntryRowMenu (pmMangaList, lfm:5787-5812): Open navigates;
 *   Download all POSTs the BATCH endpoint with the deterministic
 *   per-manga idempotency key; Add to favorites is disabled + tooltip
 *   when favorited, POSTs when not.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowsePage } from '../src/pages/BrowsePage';
import { AllSitesSearchPage } from '../src/pages/AllSitesSearchPage';
import { parseHash } from '../src/router';
import { downloadAllBatchKey } from '../src/api/hooks';
import {
  __resetHighlightNewForTest,
  todayJdn,
} from '../src/state/highlight-new';
import { HighlightNewToggle } from '../src/components/catalog/HighlightNewToggle';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { MODULE_ID, entryFixture, favoriteFixture, jobFixture, moduleFixture } from './fixtures';

autoCleanup();

// jsdom lacks ResizeObserver; Radix Tooltip's popper measures with it.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const OLD_JDN = todayJdn() - 400;

/** The accent-matrix quartet: new / completed / both / none. */
function matrixEntries(): Parameters<typeof entryFixture>[0][] {
  return [
    entryFixture('https://ex.org/new-ongoing', 'New Ongoing', {
      jdn: todayJdn(),
      status: 'Ongoing',
      alttitles: 'Alt Title',
      artists: 'Artist A',
      genres: 'Action, Drama',
      summary: 'A fixture summary for the popover.',
    }),
    entryFixture('https://ex.org/completed-old', 'Completed Old', { jdn: OLD_JDN, status: 'Completed' }),
    entryFixture('https://ex.org/completed-new', 'Completed New', { jdn: todayJdn(), status: 'Completed' }),
    entryFixture('https://ex.org/old-ongoing', 'Old Ongoing', { jdn: OLD_JDN, status: 'Ongoing' }),
  ];
}

interface Harness {
  readonly requests: { method: string; path: string; body: unknown }[];
  readonly favoritesRows: unknown[];
  readonly batchCalls: unknown[];
  readonly favoritePosts: unknown[];
}

function buildRoutes(entries: Parameters<typeof entryFixture>[0][], opts: { favorites?: unknown[] } = {}): {
  routes: MockRoute[];
  harness: Omit<Harness, 'requests'>;
} {
  const favoritesRows: unknown[] = [...(opts.favorites ?? [])];
  const batchCalls: unknown[] = [];
  const favoritePosts: unknown[] = [];
  let batchCallsCount = 0;
  const routes: MockRoute[] = [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/modules',
      respond: (): { body: object } => ({ body: { modules: [moduleFixture()], count: 1 } }),
    },
    {
      method: 'GET',
      match: (url): boolean => /^\/api\/catalog\/[0-9a-f]{32}\/(latest|title|search)$/.test(url.pathname),
      respond: (): { body: object } => ({ body: { entries, total: entries.length } }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/info',
      respond: (): { body: object } => {
        throw new Error('popover/menu must never live-fetch info');
      },
    },
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/favorites',
      respond: (): { body: object } => ({ body: { favorites: favoritesRows } }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/favorites',
      respond: (_url, body): { status: number; body: object } => {
        favoritePosts.push(body);
        const input = body as { moduleId: string; url: string };
        const row = favoriteFixture({
          id: `${input.moduleId}${input.url}`.toLowerCase(),
          moduleId: input.moduleId,
          url: input.url,
        });
        favoritesRows.push(row);
        return { status: 201, body: { favorite: row } };
      },
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/jobs/download/batch',
      respond: (_url, body): { status: number; body: object } => {
        batchCalls.push(body);
        batchCallsCount += 1;
        const jobs = [jobFixture('41'), jobFixture('42')];
        // First create 201 fresh; every replay 200 + replayed:true.
        return batchCallsCount === 1
          ? { status: 201, body: { jobs, replayed: false } }
          : { status: 200, body: { jobs, replayed: true } };
      },
    },
  ];
  return { routes, harness: { favoritesRows, batchCalls, favoritePosts } };
}

async function renderBrowse(entries: Parameters<typeof entryFixture>[0][], opts: { favorites?: unknown[]; hash?: string } = {}): Promise<Harness> {
  const { routes, harness } = buildRoutes(entries, { ...(opts.favorites !== undefined ? { favorites: opts.favorites } : {}) });
  const { fetch, requests } = mockFetch(routes);
  const hash = opts.hash ?? `#/browse?site=${MODULE_ID}`;
  renderWithProviders(<BrowsePage route={parseHash(hash)} />, { fetch, hash });
  await screen.findAllByText(/Ongoing|Completed/);
  return { ...harness, requests };
}

function rowLi(title: string): HTMLElement {
  const el = screen.getByText(title);
  return el.closest('li') as HTMLElement;
}

function setStoredHighlightNew(value: boolean): void {
  globalThis.localStorage?.setItem('fmd.highlight-new', value ? '1' : '0');
  __resetHighlightNewForTest();
}

beforeEach((): void => {
  globalThis.localStorage?.clear();
  __resetHighlightNewForTest();
});

describe('EntryMetadataPopover (vtMangaListGetHint parity)', (): void => {
  it('shows the full §5.8 catalog metadata on hover — with ZERO network on hover', async (): Promise<void> => {
    const entries = matrixEntries();
    const harness = await renderBrowse(entries);

    await userEvent.hover(screen.getByText('New Ongoing'));
    const popover = await screen.findByTestId('entry-metadata');
    expect(popover).toHaveAttribute('data-entry-link', 'https://ex.org/new-ongoing');
    const withinPopover = within(popover);
    expect(withinPopover.getByText('Alt Title')).toBeInTheDocument();
    expect(withinPopover.getByText('Author A')).toBeInTheDocument(); // authors fixture value
    expect(withinPopover.getByText('Artist A')).toBeInTheDocument();
    expect(withinPopover.getByText('Action, Drama')).toBeInTheDocument();
    expect(withinPopover.getByText('Ongoing')).toBeInTheDocument();
    expect(withinPopover.getByText('A fixture summary for the popover.')).toBeInTheDocument();
    expect(withinPopover.getByText('New Ongoing')).toBeInTheDocument();

    // NO network on hover: nothing was fetched to render the popover —
    // catalog data only (the /api/info mock route also THROWS, so any
    // live fetch would fail this test loudly).
    expect(harness.requests.filter((r): boolean => r.path.includes('/api/info'))).toEqual([]);
  });

  it('omits empty fields (pas:5172-5226 — only non-empty sections render)', async (): Promise<void> => {
    await renderBrowse(matrixEntries());
    await userEvent.hover(screen.getByText('Completed Old'));
    const popover = await screen.findByTestId('entry-metadata');
    expect(within(popover).queryByText('Alternative titles')).not.toBeInTheDocument();
    expect(within(popover).queryByText('Artists')).not.toBeInTheDocument();
    expect(within(popover).queryByText('Summary')).not.toBeInTheDocument();
    expect(within(popover).getByText('Completed')).toBeInTheDocument(); // status still shows
  });

  it('leads with the Website line in all-sites union mode (pas:5166-5170)', async (): Promise<void> => {
    const unionEntry = {
      ...entryFixture('https://ex.org/union-row', 'Union Row'),
      site: MODULE_ID,
      siteName: 'FixtureSite',
    };
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/search',
        respond: (): { body: object } => ({
          body: { entries: [unionEntry], facets: [], warnings: [], excluded: [] },
        }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/favorites',
        respond: (): { body: object } => ({ body: { favorites: [] } }),
      },
    ];
    const { fetch } = mockFetch(routes);
    const hash = '#/browse?allsites=1&q=union';
    renderWithProviders(<AllSitesSearchPage route={parseHash(hash)} />, { fetch, hash });
    await screen.findByText('Union Row');

    await userEvent.hover(screen.getByText('Union Row'));
    const popover = await screen.findByTestId('entry-metadata');
    // The Website section leads the popover (pas:5166-5170) — the
    // siteName renders inside it, scoped away from the row's badge.
    expect(within(popover).getByText('Website')).toBeInTheDocument();
    expect(within(popover).getByText('FixtureSite')).toBeInTheDocument();
  });
});

describe('row accents (vtMangaListBeforeCellPaint parity, pas:5114-5152)', (): void => {
  it('matrix, toggle ON (default): new → new+badge, completed → completed (ungated), both → completed wins, none → plain', async (): Promise<void> => {
    setStoredHighlightNew(true);
    await renderBrowse(matrixEntries());

    const newOngoing = rowLi('New Ongoing');
    expect(newOngoing).toHaveAttribute('data-accent', 'new');
    expect(newOngoing.querySelector('[data-new-badge]')).not.toBeNull();

    const completedOld = rowLi('Completed Old');
    expect(completedOld).toHaveAttribute('data-accent', 'completed');
    expect(completedOld.querySelector('[data-new-badge]')).toBeNull();

    // BOTH new-window and completed → completed overrides (FMD2 paint order).
    const completedNew = rowLi('Completed New');
    expect(completedNew).toHaveAttribute('data-accent', 'completed');
    expect(completedNew.querySelector('[data-new-badge]')).toBeNull();

    const oldOngoing = rowLi('Old Ongoing');
    expect(oldOngoing).not.toHaveAttribute('data-accent');
    expect(oldOngoing.querySelector('[data-new-badge]')).toBeNull();
  });

  it('toggle OFF: no new accent/badge, completed still accents (ungated in FMD2)', async (): Promise<void> => {
    setStoredHighlightNew(false);
    await renderBrowse(matrixEntries());

    const newOngoing = rowLi('New Ongoing');
    expect(newOngoing).not.toHaveAttribute('data-accent');
    expect(newOngoing.querySelector('[data-new-badge]')).toBeNull();

    expect(rowLi('Completed Old')).toHaveAttribute('data-accent', 'completed');
  });

  it("the filter's only-new day setting widens the window (new=365 → 300-day-old row is new)", async (): Promise<void> => {
    setStoredHighlightNew(true);
    const aged = entryFixture('https://ex.org/aged', 'Aged Ongoing', {
      jdn: todayJdn() - 300,
      status: 'Ongoing',
    });
    await renderBrowse([aged], { hash: `#/browse?site=${MODULE_ID}&new=365` });
    expect(rowLi('Aged Ongoing')).toHaveAttribute('data-accent', 'new');
    // Without the widened window the same row is plain (default 1 day).
  });
});

describe('highlight-new toggle (miHighlightNewManga parity)', (): void => {
  it('the list-level control flips the persisted state and re-renders rows', async (): Promise<void> => {
    setStoredHighlightNew(false);
    await renderBrowse(matrixEntries());

    const toggle = screen.getByTestId('highlight-new-toggle');
    expect(toggle).not.toBeChecked();
    expect(rowLi('New Ongoing')).not.toHaveAttribute('data-accent');

    await userEvent.click(toggle);
    expect(globalThis.localStorage?.getItem('fmd.highlight-new')).toBe('1');
    expect(rowLi('New Ongoing')).toHaveAttribute('data-accent', 'new');
  });

  it('default is ON (FMD2 ReadBool default True) and a stored OFF is honored', async (): Promise<void> => {
    renderWithProviders(<HighlightNewToggle />);
    expect(screen.getByTestId('highlight-new-toggle')).toBeChecked();
    cleanup();
    globalThis.localStorage?.setItem('fmd.highlight-new', '0');
    __resetHighlightNewForTest();
    renderWithProviders(<HighlightNewToggle />);
    expect(screen.getByTestId('highlight-new-toggle')).not.toBeChecked();
  });
});

describe('EntryRowMenu (pmMangaList parity)', (): void => {
  it('Open navigates to the manga page', async (): Promise<void> => {
    await renderBrowse(matrixEntries());
    await userEvent.click(screen.getAllByRole('button', { name: /^Actions for / })[0] as HTMLElement);
    const menu = await screen.findByTestId('entry-row-menu');
    await userEvent.click(within(menu).getByText('Open'));
    expect(globalThis.location.hash).toContain('#/manga');
    expect(globalThis.location.hash).toContain(encodeURIComponent('https://ex.org/new-ongoing'));
  });

  it('Download all POSTs the batch endpoint with the deterministic per-manga key', async (): Promise<void> => {
    const harness = await renderBrowse(matrixEntries());
    await userEvent.click(screen.getAllByRole('button', { name: /^Actions for / })[0] as HTMLElement);
    const menu = await screen.findByTestId('entry-row-menu');
    await userEvent.click(within(menu).getByTestId('menu-download-all'));

    await screen.findByText('New Ongoing'); // settle
    expect(harness.batchCalls).toHaveLength(1);
    const body = harness.batchCalls[0] as Record<string, unknown>;
    expect(body['moduleId']).toBe(MODULE_ID);
    expect(body['mangaUrl']).toBe('https://ex.org/new-ongoing');
    expect(body['mangaTitle']).toBe('New Ongoing');
    expect(body['chapters']).toBe('all');
    expect(body['idempotencyKey']).toBe(downloadAllBatchKey(MODULE_ID, 'https://ex.org/new-ongoing'));
  });

  it('a second Download all replays the SAME batch (idempotent double-submit)', async (): Promise<void> => {
    const harness = await renderBrowse(matrixEntries());
    for (let i = 0; i < 2; i += 1) {
      await userEvent.click(screen.getAllByRole('button', { name: /^Actions for / })[0] as HTMLElement);
      const menu = await screen.findByTestId('entry-row-menu');
      await userEvent.click(within(menu).getByTestId('menu-download-all'));
      await screen.findByText('New Ongoing');
    }
    expect(harness.batchCalls).toHaveLength(2);
    // Same derived key both times — the replay reaches the server as an
    // identical-key request and gets the same jobs back.
    expect(harness.batchCalls[0]).toEqual(harness.batchCalls[1]);
  });

  it('Add to favorites is disabled with a tooltip when already favorited', async (): Promise<void> => {
    const seeded = favoriteFixture({
      moduleId: MODULE_ID,
      url: 'https://ex.org/new-ongoing',
      id: `${MODULE_ID}https://ex.org/new-ongoing`.toLowerCase(),
    });
    const harness = await renderBrowse(matrixEntries(), { favorites: [seeded] });

    await userEvent.click(screen.getAllByRole('button', { name: /^Actions for / })[0] as HTMLElement);
    const menu = await screen.findByTestId('entry-row-menu');
    const item = within(menu).getByTestId('menu-add-favorite');
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await userEvent.hover(item);
    expect(await screen.findByText('Already in favorites')).toBeInTheDocument();
    expect(harness.favoritePosts).toHaveLength(0);
  });

  it('Add to favorites POSTs when not favorited', async (): Promise<void> => {
    const harness = await renderBrowse(matrixEntries());
    await userEvent.click(screen.getAllByRole('button', { name: /^Actions for / })[0] as HTMLElement);
    const menu = await screen.findByTestId('entry-row-menu');
    await userEvent.click(within(menu).getByTestId('menu-add-favorite'));

    await screen.findByText('New Ongoing');
    expect(harness.favoritePosts).toHaveLength(1);
    const body = harness.favoritePosts[0] as Record<string, unknown>;
    expect(body['moduleId']).toBe(MODULE_ID);
    expect(body['url']).toBe('https://ex.org/new-ongoing');
    expect(body['title']).toBe('New Ongoing');
  });
});
