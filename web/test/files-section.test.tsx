// @vitest-environment jsdom
/**
 * [file-state] FilesSection (manga detail): renders per-state rows
 * (downloaded with size/date/badge/copy-path, missing, orphan), the
 * verification-age line, explicit refresh (?refresh=1), and the
 * per-title rescan POST with its summary line.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilesSection } from '../src/components/library/FilesSection';
import { formatBytes } from '../src/components/library/format';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';

autoCleanup();

const MODULE = 'a'.repeat(32);
const URL_ = 'https://ex.org/manga/x';

const DOWNLOADED = {
  id: '7',
  chapterLink: 'https://ex.org/manga/x/1',
  fileName: 'Ch. 1 The Beginning.cbz',
  path: 'mangam/Ch. 1 The Beginning.cbz',
  absolutePath: '/srv/fmd/library/mangam/Ch. 1 The Beginning.cbz',
  bytes: 1258291,
  mtime: '2026-11-18T17:34:02.117Z',
  state: 'downloaded',
  verifiedAt: '2026-11-19T00:00:00.000Z',
};
const MISSING = {
  id: '8',
  chapterLink: 'https://ex.org/manga/x/2',
  fileName: 'Ch. 2 The Middle.cbz',
  path: 'mangam/Ch. 2 The Middle.cbz',
  state: 'missing',
  verifiedAt: '2026-11-19T00:00:00.000Z',
};
const ORPHAN = {
  path: 'mangam/untracked.cbz',
  absolutePath: '/srv/fmd/library/mangam/untracked.cbz',
  bytes: 2048,
  mtime: '2026-11-17T10:00:00.000Z',
};

const LABELS = new Map([
  ['https://ex.org/manga/x/1', 'Ch. 1 The Beginning'],
  ['https://ex.org/manga/x/2', 'Ch. 2 The Middle'],
]);

function titleFilesRoutes(refreshSeen: { value: boolean }): MockRoute[] {
  return [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/library/title-files',
      respond: (url): { body: object } => {
        if (url.searchParams.get('refresh') !== null) {
          refreshSeen.value = true;
        }
        return {
          body: {
            moduleId: MODULE,
            url: URL_,
            verifiedAt: '2026-11-19T00:05:00.000Z',
            files: [DOWNLOADED, MISSING],
            orphans: [ORPHAN],
          },
        };
      },
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/library/rescan',
      respond: (): { body: object } => ({
        body: {
          report: {
            startedAt: '2026-11-19T00:06:00.000Z',
            finishedAt: '2026-11-19T00:06:01.000Z',
            durationMs: 1000,
            scope: { kind: 'title', moduleId: MODULE, url: URL_ },
            counts: { scanned: 3, present: 1, relinked: 1, missing: 1, orphans: 1, outsideRoot: 0 },
            relinked: [{ id: '9', fromPath: 'a/old.cbz', toPath: 'b/new.cbz' }],
            missing: [{ id: '8', manga: 'mangam', fileName: 'Ch. 2 The Middle.cbz', path: 'mangam/Ch. 2 The Middle.cbz', candidates: [] }],
            orphans: [ORPHAN],
          },
        },
      }),
    },
  ];
}

beforeEach((): void => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(globalThis.navigator, { clipboard: { writeText } });
});

describe('FilesSection', (): void => {
  it('renders downloaded and missing entries with chapter labels, human size, UTC date, state badges', async (): Promise<void> => {
    const labels = new Map([['https://ex.org/manga/x/1', 'Ch. 1 The Beginning'], ['https://ex.org/manga/x/2', 'Ch. 2 The Middle']]);
    const { fetch } = mockFetch(titleFilesRoutes({ value: false }));
    renderWithProviders(
      <FilesSection moduleId={MODULE} url={URL_} mangaTitle="Manga X" chapterLabels={labels} />,
      { fetch },
    );

    expect(await screen.findByText('Ch. 1 The Beginning')).toBeInTheDocument();
    // Human size (the shared formatter) + the shared UTC date shape.
    expect(screen.getByText((content, element): boolean =>
      element?.classList.contains('files-meta') === true && content.includes(formatBytes(1258291)) && content.includes('2026-11-18 17:34'),
    )).toBeInTheDocument();
    // State badges per row.
    expect(screen.getByText('downloaded')).toBeInTheDocument();
    expect(screen.getByText('missing')).toBeInTheDocument();
    // Verification age line (visible text, never tooltip-only — R3).
    expect(screen.getByText(/Verified/)).toBeInTheDocument();
    // The orphan surfaces in its own list.
    expect(await screen.findByText('mangam/untracked.cbz')).toBeInTheDocument();
    expect(screen.getByText('orphan')).toBeInTheDocument();
  });

  it('copy-path writes the recorded absolute path', async (): Promise<void> => {
    const { fetch } = mockFetch(titleFilesRoutes({ value: false }));
    renderWithProviders(
      <FilesSection moduleId={MODULE} url={URL_} mangaTitle="Manga X" chapterLabels={LABELS} />,
      { fetch },
    );
    const buttons = await screen.findAllByRole('button', { name: /Copy path/ });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    await userEvent.click(buttons[0] as HTMLElement);
    // The FIRST copy-path belongs to the downloaded row (files render
    // before orphans): the absolute path, not the display rel path.
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('/srv/fmd/library/mangam/Ch. 1 The Beginning.cbz');
  });

  it('refresh sends ?refresh=1 (the explicit re-verification leg)', async (): Promise<void> => {
    const refreshSeen = { value: false };
    const { fetch } = mockFetch(titleFilesRoutes(refreshSeen));
    renderWithProviders(
      <FilesSection moduleId={MODULE} url={URL_} mangaTitle="Manga X" chapterLabels={LABELS} />,
      { fetch },
    );
    await screen.findByText('Ch. 1 The Beginning');
    await userEvent.click(screen.getByTestId('files-refresh'));
    await screen.findByText('Ch. 1 The Beginning');
    expect(refreshSeen.value).toBe(true);
  });

  it('the per-title rescan POSTs with the title scope and renders the summary', async (): Promise<void> => {
    const { fetch } = mockFetch(titleFilesRoutes({ value: false }));
    renderWithProviders(
      <FilesSection moduleId={MODULE} url={URL_} mangaTitle="Manga X" chapterLabels={LABELS} />,
      { fetch },
    );
    await screen.findByText('Ch. 1 The Beginning');
    await userEvent.click(screen.getByTestId('files-rescan'));
    const summary = await screen.findByTestId('title-rescan-summary');
    expect(summary.textContent).toContain('1 re-linked');
    expect(summary.textContent).toContain('1 missing');
    expect(summary.textContent).toContain('1 orphans');
  });
});

describe('formatBytes (the shared formatter)', (): void => {
  it('renders human units', (): void => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});
