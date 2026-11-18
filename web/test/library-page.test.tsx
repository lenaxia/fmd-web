// @vitest-environment jsdom
/**
 * LibraryPage [UX-AUDIT L-2/L-3]: the row meta line is human-readable
 * with the filename de-emphasized (no code chip), and the row carries
 * file management — a kebab menu → "Delete file…" → a confirm dialog
 * naming the file → DELETE /api/library/:id with the list refetched.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryPage } from '../src/pages/LibraryPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { MODULE_ID } from './fixtures';

autoCleanup();

const FILE = {
  id: '7',
  moduleId: MODULE_ID,
  manga: 'Fixture Manga',
  fileName: 'Chapter 1 The Beginning.zip',
  bytes: 1258291,
  createdAt: '2026-11-18T17:34:02.117Z',
};

function libraryRoutes(files: { id: string }[], opts?: { onDelete?: () => void }): MockRoute[] {
  return [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/library',
      respond: (): { body: object } => ({ body: { files: files.map(() => FILE) } }),
    },
    {
      method: 'DELETE',
      match: (url): boolean => url.pathname === `/api/library/${FILE.id}`,
      respond: (): { body: object } => {
        opts?.onDelete?.();
        files.pop();
        return { body: { ok: true } };
      },
    },
  ];
}

describe('LibraryPage row polish (UX-AUDIT L-2/L-3)', (): void => {
  it('renders the human meta line with the filename de-emphasized, not a code chip', async (): Promise<void> => {
    const { fetch } = mockFetch(libraryRoutes([FILE]));
    renderWithProviders(<LibraryPage />, { fetch });

    expect(await screen.findByText('Fixture Manga')).toBeInTheDocument();
    const meta = document.querySelector('.library-meta');
    // L-1 (pinned): human size · UTC date, never raw toISOString.
    expect(meta?.textContent).toContain('1.2 MiB · 2026-11-18 17:34');
    expect(meta?.textContent).not.toContain('T17:34:02.117Z');
    // L-3: the filename rides the meta line as plain text — the old
    // <code> chip styling is gone.
    expect(meta?.textContent).toContain('Chapter 1 The Beginning.zip');
    expect(meta?.querySelector('code')).toBeNull();
  });

  it('manages files from the row: menu → Delete file… → confirm names the file → DELETE + refetch', async (): Promise<void> => {
    const files = [{ id: FILE.id }];
    let deleted = false;
    const { fetch, requests } = mockFetch(
      libraryRoutes(files, {
        onDelete: (): void => {
          deleted = true;
        },
      }),
    );
    renderWithProviders(<LibraryPage />, { fetch });

    await screen.findByText('Fixture Manga');
    await userEvent.click(screen.getByRole('button', { name: `File actions for ${FILE.fileName}` }));
    await userEvent.click(await screen.findByText('Delete file…'));

    // the confirm dialog names the exact artifact before anything fires
    const dialog = await screen.findByTestId(`library-delete-dialog-${FILE.id}`);
    expect(dialog).toBeInTheDocument();
    expect(dialog.textContent).toContain(FILE.fileName);
    expect(deleted).toBe(false);

    await userEvent.click(screen.getByTestId(`library-delete-confirm-${FILE.id}`));
    expect(deleted).toBe(true);
    expect(requests.some((r): boolean => r.method === 'DELETE' && r.path === `/api/library/${FILE.id}`)).toBe(true);
    // the refetch after invalidation drops the row
    expect(await screen.findByText('No chapters downloaded yet')).toBeInTheDocument();
  });

  it('keeps the row when the delete is cancelled', async (): Promise<void> => {
    const files = [{ id: FILE.id }];
    const { fetch, requests } = mockFetch(libraryRoutes(files));
    renderWithProviders(<LibraryPage />, { fetch });

    await screen.findByText('Fixture Manga');
    await userEvent.click(screen.getByRole('button', { name: `File actions for ${FILE.fileName}` }));
    await userEvent.click(await screen.findByText('Delete file…'));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(requests.some((r): boolean => r.method === 'DELETE')).toBe(false);
    expect(await screen.findByText('Fixture Manga')).toBeInTheDocument();
  });
});
