// @vitest-environment jsdom
/**
 * [parity-sweep] UI tests: the genre-exclude chips render distinctly,
 * open-by-URL resolves/navigates + surfaces typed errors (incl. the
 * Ctrl+Shift+V paste-and-go), and the new Settings sections render +
 * PUT their settings.
 */
import { fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppliedFilterChips } from '../src/components/catalog/AppliedFilterChips';
import { OpenByUrlInput } from '../src/components/catalog/OpenByUrlInput';
import {
  AboutSection,
  DiagnosticsSection,
  FilenamePolicySection,
  PerformanceSection,
  RetentionSection,
} from '../src/components/settings/ParitySweepSections';
import { EMPTY_FILTERS, type BrowseFilterState } from '../src/state/browse-filter-state';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';

autoCleanup();

const SETTINGS_BODY = {
  proxy: { type: '', host: '', port: '', user: '', pass: '' },
  output: {
    format: 'zip',
    chapterNameTemplate: '',
    unicodeReplacement: false,
    unicodeReplacementChar: '_',
    digitPadding: 0,
    removeMangaName: false,
  },
  favorites: { intervalMinutes: 60, checkAtStartup: true },
  performance: { requestTimeoutSeconds: 20, retryCount: 3, parallelChapters: 2, threadsPerChapter: 2 },
  retention: { days: 45 },
  filenamePolicy: { normalizePaths: false },
  diagnostics: { logEnabled: true, logLevel: 'info' },
  browser: { enabled: false, url: '' },
};

type MockRouteResult = { status?: number; body: unknown };

/** Path-exact route builder for the current MockRoute contract. */
const route = (method: string, path: string, body: unknown, status = 200): MockRoute => ({
  method,
  match: (url): boolean => url.pathname === path,
  respond: (): MockRouteResult => ({ status, body }),
});

describe('AppliedFilterChips — genre excludes render distinctly (audit (b)2)', (): void => {
  it('an excluded genre chip carries None-of label, strikethrough styling + data-excluded', (): void => {
    const { fetch } = mockFetch([]);
    const state = { ...EMPTY_FILTERS, genres: ['Action'], excludedGenres: ['Ecchi'] };
    const screen = renderWithProviders(
      <AppliedFilterChips
        state={state}
        onChange={(): void => {
          /* not under test */
        }}
      />,
      { fetch },
    );
    const include = screen.getByText(/All of: Action/);
    expect(include.closest('[data-excluded]')?.getAttribute('data-excluded')).toBeUndefined();
    const exclude = screen.getByText(/None of: Ecchi/);
    const badge = exclude.closest('[data-excluded="true"]');
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain('line-through');
    expect(badge?.className).toContain('opacity-60');
  });

  it('removing the exclude chip clears only the exclude list', (): void => {
    const { fetch } = mockFetch([]);
    const state = { ...EMPTY_FILTERS, genres: ['Action'], excludedGenres: ['Ecchi'] };
    let next: BrowseFilterState | undefined;
    const screen = renderWithProviders(
      <AppliedFilterChips state={state} onChange={(n): void => { next = n; }} />,
      { fetch },
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove filter: None of: Ecchi/ }));
    expect(next?.excludedGenres).toEqual([]);
    expect(next?.genres).toEqual(['Action']);
  });
});

describe('OpenByUrlInput — paste-and-go (M14, FMD2 edURL parity)', (): void => {
  beforeEach((): void => {
    globalThis.location.hash = '';
  });

  const infoRoute = (moduleId: string): MockRoute =>
    route(
      'POST',
      '/api/info',
      {
        moduleId,
        title: 'One Piece',
        url: 'https://site.example/one-piece',
        altTitles: '',
        authors: '',
        artists: '',
        genres: '',
        status: '',
        summary: '',
        coverLink: '',
        link: '',
        chapterLinks: [],
        chapterNames: [],
        numChapter: 0,
        downloaded: [],
      },
    );

  it('resolves by host and navigates to the manga page', async (): Promise<void> => {
    const { fetch } = mockFetch([infoRoute('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]);
    const screen = renderWithProviders(<OpenByUrlInput />, { fetch });
    fireEvent.change(screen.getByLabelText('Open by URL'), {
      target: { value: 'https://site.example/one-piece' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toContain('#/manga?');
    });
    expect(globalThis.location.hash).toContain('module=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(globalThis.location.hash).toContain('title=One+Piece');
  });

  it('unknown host surfaces the typed no_site_match error, no navigation', async (): Promise<void> => {
    const { fetch } = mockFetch([
      route('POST', '/api/info', { error: { code: 'no_site_match', message: 'no site matches this URL' } }, 400),
    ]);
    const screen = renderWithProviders(<OpenByUrlInput />, { fetch });
    fireEvent.change(screen.getByLabelText('Open by URL'), {
      target: { value: 'https://nowhere.example/x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor((): void => {
      expect(screen.getByTestId('open-by-url-error').textContent).toContain('No site matches this URL');
    });
    expect(globalThis.location.hash).not.toContain('#/manga');
  });

  it('ambiguous host names the candidate sites', async (): Promise<void> => {
    const { fetch } = mockFetch([
      route(
        'POST',
        '/api/info',
        { error: { code: 'ambiguous_site', message: "multiple sites match this URL's host: TwinA, TwinB" } },
        400,
      ),
    ]);
    const screen = renderWithProviders(<OpenByUrlInput />, { fetch });
    fireEvent.change(screen.getByLabelText('Open by URL'), { target: { value: 'https://twin.example/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor((): void => {
      expect(screen.getByTestId('open-by-url-error').textContent).toContain('TwinA');
    });
  });

  it('Ctrl+Shift+V paste-and-go reads the clipboard and navigates', async (): Promise<void> => {
    const clipboardRead = vi.fn().mockResolvedValue('https://site.example/one-piece');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { readText: clipboardRead },
      configurable: true,
    });
    const { fetch } = mockFetch([infoRoute('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')]);
    const screen = renderWithProviders(<OpenByUrlInput />, { fetch });
    fireEvent.keyDown(screen.getByLabelText('Open by URL'), {
      key: 'V',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(clipboardRead).toHaveBeenCalled();
    await waitFor((): void => {
      expect(globalThis.location.hash).toContain('module=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });
  });
});

describe('[parity-sweep] Settings sections render + PUT', (): void => {
  it('Performance renders the four knobs and PUTs on save', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([
      route('GET', '/api/settings', SETTINGS_BODY),
      route('PUT', '/api/settings/performance', SETTINGS_BODY),
    ]);
    const screen = renderWithProviders(<PerformanceSection />, { fetch });
    // Await the SEEDED server snapshot (20 ≠ the component default 15,
    // so this resolve proves the GET landed) before editing.
    const timeout = await screen.findByDisplayValue('20');
    expect(screen.getByLabelText('Retry count')).toBeDefined();
    expect(screen.getByLabelText('Parallel chapters')).toBeDefined();
    expect(screen.getByLabelText('Threads per chapter')).toBeDefined();
    fireEvent.change(timeout, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor((): void => {
      const put = requests.find((r): boolean => r.method === 'PUT' && r.path.endsWith('/api/settings/performance'));
      expect(put?.body).toMatchObject({ requestTimeoutSeconds: 30 });
    });
  });

  it('Retention renders keep-forever + days; keep-forever PUTs days=0', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([
      route('GET', '/api/settings', SETTINGS_BODY),
      route('PUT', '/api/settings/retention', SETTINGS_BODY),
    ]);
    const screen = renderWithProviders(<RetentionSection />, { fetch });
    // Await the seeded snapshot (45 ≠ the default 30) before toggling.
    await screen.findByDisplayValue('45');
    fireEvent.click(screen.getByLabelText('Keep job history forever'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor((): void => {
      const put = requests.find((r): boolean => r.method === 'PUT' && r.path.endsWith('/api/settings/retention'));
      expect(put?.body).toEqual({ days: 0 });
    });
  });

  it('Filename policy toggles + PUTs; Diagnostics enables/levels; About shows the version + links', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([
      route('GET', '/api/settings', SETTINGS_BODY),
      route('GET', '/healthz', { status: 'ok', version: '0.3.0-test' }),
      route('PUT', '/api/settings/filename-policy', SETTINGS_BODY),
      route('PUT', '/api/settings/diagnostics', SETTINGS_BODY),
    ]);
    const screen = renderWithProviders(
      <>
        <FilenamePolicySection />
        <DiagnosticsSection />
        <AboutSection />
      </>,
      { fetch },
    );
    // Await a deterministic post-seed signal (About's version text) so
    // the toggle happens AFTER the settings effect seeded the checkbox.
    expect(await screen.findByText(/0\.3\.0-test/)).toBeDefined();
    fireEvent.click(screen.getByLabelText('Linux-normalized filenames'));
    const policyForm = screen.getByTestId('filename-policy');
    fireEvent.click(within(policyForm).getByRole('button', { name: 'Save' }));
    await waitFor((): void => {
      const put = requests.find((r): boolean => r.method === 'PUT' && r.path.endsWith('/api/settings/filename-policy'));
      expect(put?.body).toEqual({ normalizePaths: true });
    });
    expect(screen.getByLabelText('Minimum log level')).toBeDefined();
    expect(screen.getByText(/0\.3\.0-test/)).toBeDefined();
    const diagnostics = screen.getByTestId('diagnostics-settings');
    expect(diagnostics.querySelector('a[href*="/metrics"]')).not.toBeNull();
    const about = screen.getByTestId('about-section');
    expect(about.querySelectorAll('a[href*="github.com"]').length).toBeGreaterThanOrEqual(2);
  });
});
