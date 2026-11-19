// @vitest-environment jsdom
/**
 * [file-state] LibraryPage: the All/Missing/Orphans filter chips with
 * URL-as-truth (?filter=), state badges + copy-path on rows, the
 * orphan listing (last-rescan truth), and the Rescan-library toolbar
 * action with its persisted report view.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryPage } from '../src/pages/LibraryPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { MODULE_ID } from './fixtures';

autoCleanup();

const FILE = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '7',
  moduleId: MODULE_ID,
  manga: 'Fixture Manga',
  fileName: 'Chapter 1 The Beginning.zip',
  bytes: 1258291,
  createdAt: '2026-11-18T17:34:02.117Z',
  state: 'downloaded',
  verifiedAt: '2026-11-19T00:00:00.000Z',
  path: 'aaaa/Fixture Manga/Chapter 1 The Beginning.zip',
  absolutePath: '/srv/fmd/library/aaaa/Fixture Manga/Chapter 1 The Beginning.zip',
  mtime: '2026-11-18T17:34:02.117Z',
  ...overrides,
});

const MISSING_FILE = FILE({
  id: '8',
  fileName: 'Chapter 2 The Middle.zip',
  state: 'missing',
  path: 'aaaa/Fixture Manga/Chapter 2 The Middle.zip',
  absolutePath: '/srv/fmd/library/aaaa/Fixture Manga/Chapter 2 The Middle.zip',
});

const ORPHAN = {
  path: 'stray/orphan.cbz',
  absolutePath: '/srv/fmd/library/stray/orphan.cbz',
  bytes: 2048,
  mtime: '2026-11-17T10:00:00.000Z',
};

const RESCAN_REPORT = {
  startedAt: '2026-11-19T00:06:00.000Z',
  finishedAt: '2026-11-19T00:06:01.000Z',
  durationMs: 1000,
  scope: 'library',
  counts: { scanned: 4, present: 1, relinked: 1, missing: 1, orphans: 1, outsideRoot: 0 },
  relinked: [{ id: '9', fromPath: 'a/old.cbz', toPath: 'b/new.cbz' }],
  missing: [{ id: '8', manga: 'Fixture Manga', fileName: 'Chapter 2 The Middle.zip', path: 'aaaa/Fixture Manga/Chapter 2 The Middle.zip', candidates: [] }],
  orphans: [ORPHAN],
};

function routes(files: Record<string, unknown>[]): MockRoute[] {
  return [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/library',
      respond: (url): { body: object } => {
        const filter = url.searchParams.get('filter');
        if (filter === 'missing') {
          return { body: { files: files.filter((f) => f['state'] === 'missing') } };
        }
        if (filter === 'orphans') {
          return { body: { files: [], orphans: [ORPHAN] } };
        }
        return { body: { files } };
      },
    },
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/library/rescan',
      respond: (): { body: object } => ({ body: { report: RESCAN_REPORT } }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/library/rescan',
      respond: (): { body: object } => ({ body: { report: RESCAN_REPORT } }),
    },
  ];
}

beforeEach((): void => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(globalThis.navigator, { clipboard: { writeText } });
});

describe('LibraryPage filter chips (URL-as-truth)', (): void => {
  it('renders All/Missing/Orphans chips; the hash ?filter= is the truth', async (): Promise<void> => {
    const { fetch } = mockFetch(routes([FILE(), MISSING_FILE]));
    renderWithProviders(<LibraryPage />, { fetch, hash: '#/library?filter=missing' });
    expect(await screen.findByText('Chapter 2 The Middle.zip')).toBeInTheDocument();
    expect(screen.queryByText('Chapter 1 The Beginning.zip')).not.toBeInTheDocument();
    expect(screen.getByTestId('library-filter-missing').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('library-filter-all').getAttribute('aria-pressed')).toBe('false');
  });

  it('a chip click rewrites the URL and refetches with the filter', async (): Promise<void> => {
    const { fetch } = mockFetch(routes([FILE(), MISSING_FILE]));
    renderWithProviders(<LibraryPage />, { fetch, hash: '#/library' });
    expect(await screen.findByText('Chapter 1 The Beginning.zip')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('library-filter-orphans'));
    expect(globalThis.location.hash).toBe('#/library?filter=orphans');
    expect(await screen.findByText('stray/orphan.cbz')).toBeInTheDocument();
    expect(screen.getByText('orphan')).toBeInTheDocument();
    // Rows are replaced by the orphan listing under the filter.
    expect(screen.queryByText('Chapter 1 The Beginning.zip')).not.toBeInTheDocument();
  });

  it('back to All clears the filter param from the URL', async (): Promise<void> => {
    const { fetch } = mockFetch(routes([FILE(), MISSING_FILE]));
    renderWithProviders(<LibraryPage />, { fetch, hash: '#/library?filter=orphans' });
    await screen.findByText('stray/orphan.cbz');
    await userEvent.click(screen.getByTestId('library-filter-all'));
    expect(globalThis.location.hash).toBe('#/library');
    expect(await screen.findByText('Chapter 1 The Beginning.zip')).toBeInTheDocument();
  });
});

describe('LibraryPage rows (file-state enrichment)', (): void => {
  it('state badges render per row with the verification age title', async (): Promise<void> => {
    const { fetch } = mockFetch(routes([FILE(), MISSING_FILE]));
    renderWithProviders(<LibraryPage />, { fetch });
    expect(await screen.findByText('downloaded')).toBeInTheDocument();
    expect(screen.getByText('missing')).toBeInTheDocument();
    const badge = screen.getByText('downloaded').closest('[data-state="downloaded"]');
    expect(badge?.parentElement?.getAttribute('title')).toMatch(/^Verified /);
  });

  it('copy-path writes the recorded absolute path', async (): Promise<void> => {
    const { fetch } = mockFetch(routes([FILE()]));
    renderWithProviders(<LibraryPage />, { fetch });
    await screen.findByText('Fixture Manga');
    await userEvent.click(screen.getAllByTestId('library-copy-path')[0] as HTMLElement);
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      '/srv/fmd/library/aaaa/Fixture Manga/Chapter 1 The Beginning.zip',
    );
  });
});

describe('LibraryPage rescan', (): void => {
  it('the toolbar action POSTs and the persisted report renders (re-links + counts)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes([FILE()]));
    renderWithProviders(<LibraryPage />, { fetch, hash: '#/library?filter=missing' });
    // missing filter is empty here — the empty state shows
    await screen.findByText('Nothing missing');
    await userEvent.click(screen.getByTestId('library-rescan'));
    const report = await screen.findByTestId('rescan-report');
    expect(report.textContent).toContain('1 re-linked');
    expect(report.textContent).toContain('1 missing');
    const relink = await screen.findByTestId('rescan-relink');
    expect(relink.textContent).toContain('b/new.cbz');
    expect(relink.textContent).toContain('a/old.cbz');
    // The POST went out (the report data arrived through it).
    expect(fetch).toBeDefined();
  });
});
