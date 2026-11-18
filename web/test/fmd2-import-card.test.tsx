// @vitest-environment jsdom
/**
 * Settings → 'Import from FMD2' card flow: drag-drop upload → analyze
 * preview (sites + unmapped ids + mappable settings + credential
 * FIELDS, never values) → confirm (credentials OPT-IN, off by
 * default) → apply → result summary with the Favorites link. The
 * card calls the multipart endpoints through globalThis.fetch — a
 * recorded stub stands in (fully offline).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ImportFromFmd2Card } from '../src/components/settings/ImportFromFmd2Card';
import { autoCleanup, renderWithProviders } from './helpers';
import type { Fmd2ImportPreview, Fmd2ImportReport } from '../src/api/fmd2-import';

autoCleanup();

const MODULE_A = 'a'.repeat(32);

interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function stubFetch(handlers: {
  analyze?: { status?: number; body: unknown };
  apply?: { status?: number; body: unknown };
}): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (init?.body instanceof FormData) {
      body = {
        kind: 'form-data',
        files: init.body.getAll('file').map((value): string => (value instanceof File ? value.name : String(value))),
      };
    } else if (typeof init?.body === 'string') {
      body = JSON.parse(init.body) as unknown;
    }
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/api/import/fmd2/analyze' && handlers.analyze !== undefined) {
      return Response.json(handlers.analyze.body, { status: handlers.analyze.status ?? 200 });
    }
    if (url.pathname === '/api/import/fmd2/apply' && handlers.apply !== undefined) {
      return Response.json(handlers.apply.body, { status: handlers.apply.status ?? 200 });
    }
    return Response.json({ error: { code: 'not_found', message: `no stub for ${method} ${url.pathname}` } }, { status: 404 });
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const PREVIEW: Fmd2ImportPreview = {
  files: ['favorites.db', 'settings.json'],
  ignored: [{ source: 'config.json', reason: 'config.json bootstrap (db/update URLs) — nothing importable' }],
  favorites: {
    total: 3,
    importable: 2,
    bySite: [
      { moduleId: MODULE_A, siteName: 'AlphaSource', count: 2, mapped: true },
    ],
    unmappedSiteIds: [{ id: '5450026642ecrrd48apotd81e57f8e40', count: 1 }],
  },
  downloadedLedger: { rows: 2, matched: 2 },
  settings: {
    mappable: [
      { key: 'proxy', label: 'Global proxy', source: 'settings.json [connections]', preview: 'HTTP proxy.lan:1080', requiresCredentials: true },
      { key: 'performance', label: 'Performance (connections subset)', source: 'settings.json [connections]', preview: 'timeout 20s', requiresCredentials: false },
    ],
    notImportable: [{ source: 'settings.json [saveto] SaveTo', reason: 'desktop download path — the server manages its own library layout' }],
  },
  credentials: {
    sites: [{ moduleId: MODULE_A, siteName: 'AlphaSource', fields: ['username', 'password'] }],
    globalProxyAuth: true,
  },
  analyzeToken: 'token-1234',
};

const REPORT: Fmd2ImportReport = {
  favorites: {
    created: 2,
    updated: 0,
    unchanged: 0,
    skipped: [{ label: 'Dead <5450026642ecrrd48apotd81e57f8e40/x>', reason: 'site not installed (unknown catalog id)' }],
    unmappedSiteIds: [{ id: '5450026642ecrrd48apotd81e57f8e40', count: 1 }],
    saveToPathsDropped: 1,
  },
  downloadedLedgerRowsApplied: 2,
  credentials: { imported: [], skipped: [] },
  settings: {
    applied: [{ key: 'performance', detail: 'performance set (timeout 20s)' }],
    notImportable: [{ source: 'settings.json [saveto] SaveTo', reason: 'desktop download path — the server manages its own library layout' }],
  },
};

function uploadFile(): void {
  const input = screen.getByTestId('fmd2-file-input') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], 'favorites.db', { type: 'application/octet-stream' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ImportFromFmd2Card (Settings → Import from FMD2)', (): void => {
  it('renders the upload dropzone idle state', (): void => {
    stubFetch({});
    renderWithProviders(<ImportFromFmd2Card />);
    expect(screen.getByTestId('fmd2-dropzone')).toBeVisible();
    expect(screen.getByTestId('fmd2-file-input')).toHaveAttribute('accept', '.json,.sqlite,.db,.zip');
    expect(screen.queryByTestId('fmd2-preview')).not.toBeInTheDocument();
  });

  it('upload → analyze (multipart) → preview with sites, unmapped ids, settings ON, credentials OFF', async (): Promise<void> => {
    const { calls } = stubFetch({ analyze: { body: PREVIEW } });
    renderWithProviders(<ImportFromFmd2Card />);
    uploadFile();
    const preview = await screen.findByTestId('fmd2-preview');
    // The analyze call went out as multipart with the file.
    const analyzeCall = calls.find((call): boolean => call.path === '/api/import/fmd2/analyze');
    expect(analyzeCall?.method).toBe('POST');
    expect(analyzeCall?.body).toMatchObject({ kind: 'form-data', files: ['favorites.db'] });
    // Preview content.
    expect(await within(preview).findByTestId('fmd2-preview-favorites')).toHaveTextContent('2 of 3');
    // The site renders in BOTH the by-site list and the credentials group.
    expect(screen.getAllByText('AlphaSource')).toHaveLength(2);
    expect(screen.getByTestId('fmd2-preview-unmapped')).toHaveTextContent('5450026642ecrrd48apotd81e57f8e40');
    // Settings default ON; credentials default OFF.
    expect(screen.getByTestId('fmd2-setting-performance')).toBeChecked();
    expect(screen.getByTestId('fmd2-setting-proxy')).toBeChecked();
    expect(screen.getByTestId(`fmd2-credential-${MODULE_A}`)).not.toBeChecked();
    expect(screen.getByTestId('fmd2-credential-proxy')).not.toBeChecked();
  });

  it('secrets never render — only field names', async (): Promise<void> => {
    stubFetch({ analyze: { body: PREVIEW } });
    renderWithProviders(<ImportFromFmd2Card />);
    uploadFile();
    await screen.findByTestId('fmd2-preview');
    const section = screen.getByTestId('fmd2-import-section');
    expect(section.textContent).not.toMatch(/password\s*[:=]\s*\S+pass/i);
    expect(section.textContent).toContain('username, password');
  });

  it('confirm without opt-ins → apply token with empty credentials; result summary + Favorites link', async (): Promise<void> => {
    const { calls } = stubFetch({ analyze: { body: PREVIEW }, apply: { body: REPORT } });
    renderWithProviders(<ImportFromFmd2Card />);
    uploadFile();
    await screen.findByTestId('fmd2-preview');
    fireEvent.click(screen.getByTestId('fmd2-apply'));
    const result = await screen.findByTestId('fmd2-result');
    // The apply call used the ANALYZE TOKEN (no re-upload) and NO credentials.
    const applyCall = calls.find((call): boolean => call.path === '/api/import/fmd2/apply');
    expect(applyCall?.body).toEqual({
      token: 'token-1234',
      favorites: true,
      settings: ['proxy', 'performance'],
      credentials: [],
    });
    expect(within(result).getByTestId('fmd2-result-favorites')).toHaveTextContent('2 created');
    expect(screen.getByTestId('fmd2-result-unmapped')).toHaveTextContent('5450026642ecrrd48apotd81e57f8e40');
    expect(screen.getByTestId('fmd2-result-settings')).toHaveTextContent('performance set');
    expect(screen.getByTestId('fmd2-result-notimported')).toHaveTextContent('not imported');
    expect(screen.getByRole('button', { name: 'Go to Favorites' })).toBeVisible();
  });

  it('opting in a site credential sends it in the apply selection', async (): Promise<void> => {
    const { calls } = stubFetch({ analyze: { body: PREVIEW }, apply: { body: REPORT } });
    renderWithProviders(<ImportFromFmd2Card />);
    uploadFile();
    await screen.findByTestId('fmd2-preview');
    fireEvent.click(screen.getByTestId(`fmd2-credential-${MODULE_A}`));
    fireEvent.click(screen.getByTestId('fmd2-apply'));
    await screen.findByTestId('fmd2-result');
    const applyCall = calls.find((call): boolean => call.path === '/api/import/fmd2/apply');
    expect(applyCall?.body).toMatchObject({ credentials: [MODULE_A] });
  });

  it('analyze failure surfaces the server message inline', async (): Promise<void> => {
    stubFetch({ analyze: { status: 400, body: { error: { code: 'bad_request', message: 'favorites.db: not a readable SQLite database (file is not a database)' } } } });
    renderWithProviders(<ImportFromFmd2Card />);
    uploadFile();
    await waitFor((): void => {
      expect(screen.getByText(/not a readable SQLite database/)).toBeVisible();
    });
    expect(screen.getByTestId('fmd2-dropzone')).toBeVisible();
  });
});

