// @vitest-environment jsdom
/**
 * MangaPage FMD2-parity behaviors: cover + read-online link, the
 * add-to-favorites round-trip through the real API surface (stateful
 * favorites mock), the chapter toolbar (filter / hide-downloaded /
 * asc-desc / invert / select-new), downloaded tinting, and the
 * enqueue extras (Start paused + Save-to) reaching BOTH the dry-run
 * preview and the POSTed bodies.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MangaPage } from '../src/pages/MangaPage';
import { parseHash } from '../src/router';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, MODULE_ID, favoriteFixture, infoFixture, jobFixture } from './fixtures';

autoCleanup();

const QUERY = {
  catalog: CATALOG_ID,
  module: MODULE_ID,
  url: infoFixture().url,
  title: infoFixture().title,
};

/** Stateful favorites store so the round-trip observes real membership. */
function favoritesStore(): { rows: ReturnType<typeof Array>; routes: MockRoute[] } {
  const rows: unknown[] = [];
  const routes: MockRoute[] = [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/favorites',
      respond: (): { body: object } => ({ body: { favorites: rows } }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/favorites',
      respond: (_url, body): { status: number; body: object } => {
        const input = body as { moduleId: string; url: string; title?: string };
        const favorite = favoriteFixture({
          id: `${input.moduleId}${input.url}`.toLowerCase(),
          moduleId: input.moduleId,
          url: input.url,
          title: input.title ?? null,
        });
        rows.push(favorite);
        return { status: 201, body: { favorite } };
      },
    },
    {
      method: 'DELETE',
      match: (url): boolean => url.pathname.startsWith('/api/favorites/'),
      respond: (url): { body: object } => {
        const id = decodeURIComponent(url.pathname.slice('/api/favorites/'.length));
        const index = rows.findIndex((row): boolean => (row as { id: string }).id === id);
        if (index >= 0) rows.splice(index, 1);
        return { body: { ok: true } };
      },
    },
  ];
  return { rows, routes };
}

function buildRoutes(posted: unknown[]): { favorites: MockRoute[]; info: MockRoute[]; jobs: MockRoute[] } {
  const favorites = favoritesStore().routes;
  const info: MockRoute[] = [
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/info',
      respond: (): { body: object } => ({ body: infoFixture() }),
    },
  ];
  const jobs: MockRoute[] = [
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/jobs/download',
      respond: (_url, body): { status: number; body: object } => {
        posted.push(body);
        return { status: 201, body: { job: jobFixture('job-1') } };
      },
    },
  ];
  return { favorites, info, jobs };
}

function hash(): string {
  return `#/manga?${new URLSearchParams(QUERY).toString()}`;
}

describe('MangaPage parity: cover + read online', (): void => {
  it('renders the cover (lazy, from info.coverLink) and the read-online external link', async (): Promise<void> => {
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    expect(await screen.findByRole('heading', { name: 'Fixture Manga' })).toBeInTheDocument();
    const cover = screen.getByTestId('manga-cover');
    expect(cover).toBeInTheDocument();
    expect(cover.querySelector('img')).toHaveAttribute('src', infoFixture().coverLink);
    expect(cover.querySelector('img')).toHaveAttribute('loading', 'lazy');

    const link = screen.getByRole('link', { name: /Read online/ });
    expect(link).toHaveAttribute('href', infoFixture().url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });

  it('falls back to the placeholder when no cover exists (empty coverLink)', async (): Promise<void> => {
    const { favorites } = buildRoutes([]);
    const noCover: MockRoute[] = [
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/info',
        respond: (): { body: object } => ({ body: { ...infoFixture(), coverLink: '' } }),
      },
    ];
    const { fetch } = mockFetch([...favorites, ...noCover]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    expect(await screen.findByRole('heading', { name: 'Fixture Manga' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /no cover/ })).toBeInTheDocument();
  });
});

describe('MangaPage parity: add-to-favorites round-trip', (): void => {
  it('adds via POST /api/favorites, reflects membership, then removes via DELETE', async (): Promise<void> => {
    const store = favoritesStore();
    const posted: unknown[] = [];
    const { fetch, requests } = mockFetch([
      ...store.routes,
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
    ]);
    void posted;
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    const addButton = await screen.findByRole('button', { name: /Add to favorites/ });
    expect(screen.queryByRole('button', { name: /In favorites/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select new/ })).toBeDisabled();

    await userEvent.click(addButton);
    expect(await screen.findByRole('button', { name: /In favorites/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add to favorites/ })).not.toBeInTheDocument();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ moduleId: MODULE_ID, url: QUERY.url, title: 'Fixture Manga' });
    expect(requests.filter((r): boolean => r.method === 'POST' && r.path === '/api/favorites')).toHaveLength(1);

    // select-new becomes available with membership
    expect(screen.getByRole('button', { name: /Select new/ })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /In favorites/ }));
    expect(await screen.findByRole('button', { name: /Add to favorites/ })).toBeInTheDocument();
    expect(store.rows).toHaveLength(0);
    expect(
      requests.filter((r): boolean => r.method === 'DELETE' && r.path.startsWith('/api/favorites/')),
    ).toHaveLength(1);
  });
});

describe('MangaPage parity: chapter toolbar + tinting', (): void => {
  it('tints downloaded chapters (fixture: ch-1 downloaded)', async (): Promise<void> => {
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Chapter 1').closest('[data-downloaded="true"]')).not.toBeNull();
    expect(screen.getByLabelText('Chapter 2').closest('[data-downloaded="true"]')).toBeNull();
    expect(screen.getByText('downloaded')).toBeInTheDocument();
  });

  it('filter narrows the visible list; clear restores', async (): Promise<void> => {
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });
    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Filter chapters'), '3');
    expect(screen.getByLabelText('Chapter 3')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chapter 1')).not.toBeInTheDocument();
    expect(screen.getByText(/1 shown/)).toBeInTheDocument();
  });

  it('hide-downloaded drops ledger members', async (): Promise<void> => {
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });
    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Hide downloaded/ }));
    expect(screen.queryByLabelText('Chapter 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Chapter 2')).toBeInTheDocument();
    expect(screen.getByText(/2 shown/)).toBeInTheDocument();
  });

  it('descending reverses presentation; ascending restores', async (): Promise<void> => {
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });
    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();

    const order = (): string[] =>
      screen
        .getAllByRole('checkbox', { name: /^Chapter \d/ })
        .map((node): string => (node.parentElement?.textContent ?? '').trim());

    expect(order()).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    // The toggle shows the CURRENT mode; clicking flips to descending.
    await userEvent.click(screen.getByRole('button', { name: /Ascending/ }));
    expect(order()).toEqual(['Chapter 3', 'Chapter 2', 'Chapter 1']);
    expect(screen.getByRole('button', { name: /Descending/ })).toBeInTheDocument();
  });

  it('invert flips the visible selection; select-new picks undownloaded when favorited', async (): Promise<void> => {
    const store = favoritesStore();
    const { fetch } = mockFetch([
      ...store.routes,
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/info',
        respond: (): { body: object } => ({ body: infoFixture() }),
      },
    ]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });
    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();

    // invert with one checked: everything flips
    await userEvent.click(screen.getByLabelText('Chapter 1'));
    await userEvent.click(screen.getByRole('button', { name: /^Invert$/ }));
    expect(screen.getByLabelText('Chapter 1')).not.toBeChecked();
    expect(screen.getByLabelText('Chapter 2')).toBeChecked();
    expect(screen.getByLabelText('Chapter 3')).toBeChecked();

    // select-new without membership: disabled (nothing selected)
    expect(screen.getByRole('button', { name: /Select new/ })).toBeDisabled();

    // favorite the manga, then select-new → ch-2 + ch-3 (ch-1 downloaded)
    await userEvent.click(screen.getByRole('button', { name: /Add to favorites/ }));
    await screen.findByRole('button', { name: /In favorites/ });
    await userEvent.click(screen.getByRole('button', { name: /Select new/ }));
    expect(screen.getByLabelText('Chapter 1')).not.toBeChecked();
    expect(screen.getByLabelText('Chapter 2')).toBeChecked();
    expect(screen.getByLabelText('Chapter 3')).toBeChecked();
  });
});

describe('MangaPage parity: enqueue options (Start paused + Save to)', (): void => {
  it('preview and POST both carry paused + saveTo; defaults omit them', async (): Promise<void> => {
    const posted: unknown[] = [];
    const { favorites, info, jobs } = buildRoutes(posted);
    const { fetch } = mockFetch([...favorites, ...info, ...jobs]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();

    // Default: body carries neither paused nor saveTo
    await userEvent.click(screen.getByLabelText('Chapter 2'));
    const preview = screen.getByLabelText('Enqueue request preview');
    expect(preview.textContent).not.toContain('"paused"');
    expect(preview.textContent).not.toContain('"saveTo"');

    await userEvent.click(screen.getByRole('button', { name: /Enqueue 1 chapter/ }));
    await screen.findByRole('status');
    expect(posted[0]).not.toMatchObject({ paused: expect.anything(), saveTo: expect.anything() });

    // Start paused + Save to appear in BOTH the preview and the POST
    await userEvent.click(screen.getByLabelText('Start paused'));
    await userEvent.type(screen.getByLabelText('Save to directory'), 'custom/dir');
    expect(preview.textContent).toContain('"paused": true');
    expect(preview.textContent).toContain('"saveTo": "custom/dir"');

    await userEvent.click(screen.getByRole('button', { name: /Enqueue 1 chapter/ }));
    await screen.findByRole('status');
    expect(posted[1]).toMatchObject({ paused: true, saveTo: 'custom/dir', chapterLink: '/manga/fixture/ch-2' });
  });

  it('save-to persists per manga (localStorage recall)', async (): Promise<void> => {
    globalThis.localStorage.clear();
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });
    expect(await screen.findByText(/Chapters \(3\)/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Save to directory'), 'kept/dir');
    expect(globalThis.localStorage.getItem(`fmd:saveto:${MODULE_ID}|${QUERY.url}`)).toBe('kept/dir');
  });
});

describe('MangaPage metadata null placeholders (M-2)', (): void => {
  /** All six audited fields empty: altTitles/authors/artists/genres/
   * status/summary — the page must render words or omit the row,
   * never a bare em dash (the "stray em dash" null pattern). */
  const EMPTY_INFO = infoFixture({
    altTitles: '',
    authors: '',
    artists: '',
    genres: '',
    status: '',
    summary: '',
  });

  it('the four data fields show a muted "Unknown" word, not a bare em dash', async (): Promise<void> => {
    const { favorites } = buildRoutes([]);
    const { fetch } = mockFetch([
      ...favorites,
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/info',
        respond: (): { body: object } => ({ body: EMPTY_INFO }),
      },
    ]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    const dl = (await screen.findByText('Authors')).closest('dl');
    expect(dl).not.toBeNull();
    if (dl === null) return;
    // Exactly four "Unknown" placeholder cells — one per empty data
    // field (altTitles/summary rows are OMITTED, see the next test).
    expect(dl.querySelectorAll('dd')).toHaveLength(5); // 4 placeholders + chapter count
    expect(screen.getAllByText('Unknown')).toHaveLength(4);
    // The pinned shape: no <dd> anywhere renders only punctuation.
    for (const dd of [...dl.querySelectorAll('dd')]) {
      expect(dd.textContent?.trim()).not.toBe('—');
      expect(dd.textContent?.trim()).not.toBe('');
    }
  });

  it('empty long-form fields (alternative titles, summary) are omitted entirely', async (): Promise<void> => {
    const { favorites } = buildRoutes([]);
    const { fetch } = mockFetch([
      ...favorites,
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/info',
        respond: (): { body: object } => ({ body: EMPTY_INFO }),
      },
    ]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    await screen.findByText('Authors');
    expect(screen.queryByText('Alternative titles')).toBeNull();
    expect(screen.queryByText('Summary')).toBeNull();
  });

  it('populated fields render verbatim (no regression of the happy path)', async (): Promise<void> => {
    const { favorites, info } = buildRoutes([]);
    const { fetch } = mockFetch([...favorites, ...info]);
    renderWithProviders(<MangaPage route={parseHash(hash())} />, { fetch });

    expect(await screen.findByText('Author A')).toBeInTheDocument();
    expect(screen.getByText('Artist B')).toBeInTheDocument();
    expect(screen.getByText('Action, Comedy')).toBeInTheDocument();
    expect(screen.getByText('Ongoing')).toBeInTheDocument();
    expect(screen.getByText('Fixtue Manhua')).toBeInTheDocument();
    // Summary renders twice by design (PageHeader description + dl row).
    expect(screen.getAllByText('A fixture summary.').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Unknown')).toBeNull();
  });
});
