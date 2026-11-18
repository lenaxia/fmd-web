// @vitest-environment jsdom
/**
 * Settings→Websites rebuild pins (tsk-skilled-tabby-blooms): faceted
 * registry view over a production-shaped fixture (registration-order
 * rows with INTERLEAVED categories — the "only 1 english site" repro),
 * URL-synced facet state (?q=&lang=&h=&setup=), filter-scoped global
 * bulk with the disable-all confirm, and the collapsed proxy drawer.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../src/pages/SettingsPage';
import { autoCleanup, FULL_SETTINGS, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { moduleFixture } from './fixtures';

autoCleanup();

/**
 * Production shape in miniature: categories INTERLEAVE in
 * registration (directory-walk) order, one site has an EMPTY category
 * and accountSupport mixes — the exact inputs behind the user's "only
 * 1 english site" misread.
 */
const REGISTRY = [
  moduleFixture({ id: '1'.repeat(32), name: 'AlphaReader', category: 'English', accountSupport: false }),
  moduleFixture({ id: '2'.repeat(32), name: 'BetaRaw', category: 'Raw', accountSupport: false }),
  moduleFixture({ id: '3'.repeat(32), name: 'GammaScan', category: 'English-Scanlation', accountSupport: true }),
  moduleFixture({ id: '4'.repeat(32), name: 'DeltaH', category: 'H-Sites', accountSupport: false }),
  moduleFixture({ id: '5'.repeat(32), name: 'EpsilonNoCat', category: '', accountSupport: true }),
  moduleFixture({ id: '6'.repeat(32), name: 'ZetaReader', category: 'English', accountSupport: true }),
];

function routes(extra: readonly MockRoute[] = []): MockRoute[] {
  return [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/modules',
      respond: (): { body: object } => ({ body: { modules: REGISTRY, count: REGISTRY.length } }),
    },
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/settings',
      respond: (): { body: object } => ({ body: { ...FULL_SETTINGS } }),
    },
    ...extra,
  ];
}

describe('Settings → Websites: facet chips + grouping', (): void => {
  it('renders ONE header per category with the TRUE count (interleaved registration order)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(<SettingsPage />, { fetch });
    // Wait for the list to arrive.
    expect(await screen.findByLabelText('AlphaReader', { exact: true })).toBeVisible();
    const headers = screen.getAllByTestId('module-category-header');
    const byCategory = new Map(headers.map((h) => [h.querySelector('span')?.textContent ?? '', h]));
    // Sorted A→Z, one per category, true counts — NOT per-adjacent-run shards.
    expect([...byCategory.keys()]).toEqual(['English', 'English-Scanlation', 'H-Sites', 'Raw', 'Unknown']);
    expect(within(byCategory.get('English') as HTMLElement).getByText('(2)')).toBeVisible();
    expect(within(byCategory.get('Raw') as HTMLElement).getByText('(1)')).toBeVisible();
    // The raw-empty category displays as 'Unknown' (27 production sites).
    expect(within(byCategory.get('Unknown') as HTMLElement).getByText('(1)')).toBeVisible();
  });

  it('LANGUAGE chips show collapsed counts (English 3 = English 2 + English-Scanlation 1; Unknown 1)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    const langGroup = within(within(facets).getByRole('group', { name: 'Language' }));
    expect(langGroup.getByRole('button', { name: /English 3/ })).toBeVisible();
    expect(langGroup.getByRole('button', { name: /Raw 1/ })).toBeVisible();
    expect(langGroup.getByRole('button', { name: /H-Sites 1/ })).toBeVisible();
    expect(langGroup.getByRole('button', { name: /Unknown 1/ })).toBeVisible();
    // The distribution is visible AT A GLANCE: every chip carries its count.
    const setupGroup = within(within(facets).getByRole('group', { name: 'Needs setup' }));
    expect(setupGroup.getByRole('button', { name: /No setup needed 3/ })).toBeVisible();
    expect(setupGroup.getByRole('button', { name: /Needs credentials 3/ })).toBeVisible();
  });

  it('chip selection filters the list AND lands in the URL hash (back-nav restore channel)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    await userEvent.click(within(facets).getByRole('button', { name: /English 3/ }));
    // URL carries the facet (navigate → hash mutation).
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe('#/settings?lang=English');
    });
    // The list narrows to the collapsed language set.
    await waitFor((): void => {
      expect(screen.getByRole('status').textContent).toContain('3/6 sites match');
    });
    expect(screen.queryByLabelText('BetaRaw', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByLabelText('GammaScan', { exact: true })).toBeInTheDocument();
  });

  it('NEEDS SETUP "No setup needed" hides every credential site (the user-requested filter)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    await userEvent.click(within(facets).getByRole('button', { name: /No setup needed 3/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe('#/settings?setup=no-setup');
    });
    expect(screen.queryByLabelText('GammaScan', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('EpsilonNoCat', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByLabelText('AlphaReader', { exact: true })).toBeInTheDocument();
  });

  it('a seeded hash (#/settings?lang=English) renders pre-filtered — state survives navigation', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(<SettingsPage />, { fetch, hash: '#/settings?lang=English&h=safe' });
    await screen.findByTestId('module-facets');
    // lang=English AND h=safe → AlphaReader + GammaScan (DeltaH excluded twice over).
    await waitFor((): void => {
      expect(screen.queryByLabelText('DeltaH', { exact: true })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('AlphaReader', { exact: true })).toBeInTheDocument();
    expect(screen.getByLabelText('GammaScan', { exact: true })).toBeInTheDocument();
  });
});

describe('Settings → Websites: filter-scoped global bulk', (): void => {
  function bulkRoute(writes: Array<Record<string, unknown>>): MockRoute[] {
    return [
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/modules/bulk',
        respond: (_url, body): { body: object } => {
          writes.push(body as Record<string, unknown>);
          return { body: { modules: REGISTRY, updated: REGISTRY.length } };
        },
      },
    ];
  }

  it('Enable all under an active filter POSTs exactly the FILTERED ids', async (): Promise<void> => {
    const writes: Array<Record<string, unknown>> = [];
    const { fetch } = mockFetch(routes(bulkRoute(writes)));
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    await userEvent.click(within(facets).getByRole('button', { name: /Raw 1/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe('#/settings?lang=Raw');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Enable all' }));
    await waitFor((): void => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]).toEqual({
      enabled: true,
      ids: ['2'.repeat(32)],
    });
  });

  it('Disable all asks for confirmation, then scopes the write to the filtered ids', async (): Promise<void> => {
    const writes: Array<Record<string, unknown>> = [];
    const { fetch } = mockFetch(routes(bulkRoute(writes)));
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    await userEvent.click(within(facets).getByRole('button', { name: /Raw 1/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe('#/settings?lang=Raw');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Disable all' }));
    // The confirm dialog (destructive direction) — nothing written yet.
    const dialog = await screen.findByTestId('module-disable-all-dialog');
    expect(within(dialog).getByRole('heading', { name: /Disable 1 filtered sites?/ })).toBeVisible();
    expect(writes).toHaveLength(0);
    await userEvent.click(within(dialog).getByTestId('module-disable-all-confirm'));
    await waitFor((): void => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]).toEqual({ enabled: false, ids: ['2'.repeat(32)] });
  });

  it('unfiltered Disable all confirms against ALL sites and writes the registry-wide body', async (): Promise<void> => {
    const writes: Array<Record<string, unknown>> = [];
    const { fetch } = mockFetch(routes(bulkRoute(writes)));
    renderWithProviders(<SettingsPage />, { fetch });
    await screen.findByTestId('module-facets');
    await userEvent.click(screen.getByRole('button', { name: 'Disable all' }));
    const dialog = await screen.findByTestId('module-disable-all-dialog');
    expect(within(dialog).getByRole('heading', { name: /Disable all sites\?/ })).toBeVisible();
    await userEvent.click(within(dialog).getByTestId('module-disable-all-confirm'));
    await waitFor((): void => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]).toEqual({ enabled: false });
  });

  it('cancel in the confirm dialog writes nothing', async (): Promise<void> => {
    const writes: Array<Record<string, unknown>> = [];
    const { fetch } = mockFetch(routes(bulkRoute(writes)));
    renderWithProviders(<SettingsPage />, { fetch });
    await screen.findByTestId('module-facets');
    await userEvent.click(screen.getByRole('button', { name: 'Disable all' }));
    const dialog = await screen.findByTestId('module-disable-all-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor((): void => {
      expect(screen.queryByTestId('module-disable-all-dialog')).not.toBeInTheDocument();
    });
    expect(writes).toHaveLength(0);
  });
});

describe('Settings → Websites: proxy drawer', (): void => {
  it('the editor is HIDDEN by default; the summary + one Configure affordance render', async (): Promise<void> => {
    const { fetch } = mockFetch(routes());
    renderWithProviders(<SettingsPage />, { fetch });
    const section = await screen.findByTestId('proxy-section');
    expect(within(section).getByTestId('proxy-summary')).toHaveTextContent('none');
    expect(within(section).getByRole('button', { name: /Configure/ })).toBeVisible();
    // The five-string editor is NOT on the page until the drawer opens.
    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('Configure opens the drawer with the SetProxy editor; Save PUTs the body', async (): Promise<void> => {
    const puts: unknown[] = [];
    const { fetch } = mockFetch(
      routes([
        {
          method: 'PUT',
          match: (url): boolean => url.pathname === '/api/settings/proxy',
          respond: (_url, body): { body: object } => {
            puts.push(body);
            return { body: { proxy: body, browser: { enabled: false, url: '' } } };
          },
        },
      ]),
    );
    renderWithProviders(<SettingsPage />, { fetch });
    const section = await screen.findByTestId('proxy-section');
    await userEvent.click(within(section).getByTestId('proxy-drawer-open'));
    const drawer = await screen.findByTestId('proxy-drawer');
    await userEvent.selectOptions(within(drawer).getByLabelText('Type'), 'SOCKS5');
    await userEvent.type(within(drawer).getByLabelText('Host'), 'proxy.example');
    await userEvent.type(within(drawer).getByLabelText('Port'), '1080');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save proxy' }));
    await waitFor((): void => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]).toEqual({
      type: 'SOCKS5',
      host: 'proxy.example',
      port: '1080',
      user: '',
      pass: '',
    });
  });
});
