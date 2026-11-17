// @vitest-environment jsdom

/**
 * SitePickerPage (site-first browse): sites render BY NAME with
 * category grouping, catalog-state chips and capability badges;
 * known-broken rows are disabled with their reason; hex module ids are
 * NEVER rendered as text (they ride data attributes + the URL only);
 * picking a site routes to browse?site=<id>.
 */
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModuleSummaryT } from '../src/api/hooks';
import { moduleFixture } from './fixtures';
import { renderWithProviders, autoCleanup, mockFetch, type MockRoute } from './helpers';
import { SitePickerPage } from '../src/pages/SitePickerPage';

const HEX32 = /[0-9a-f]{32}/;

function site(overrides: Partial<ModuleSummaryT>): ModuleSummaryT {
  return moduleFixture(overrides);
}

function modulesRoute(modules: readonly ModuleSummaryT[]): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/modules',
    respond: (): { body: unknown } => ({ body: { modules, count: modules.length } }),
  };
}

describe('SitePickerPage (browse default state)', (): void => {
  autoCleanup();

  const installed = site({ id: '1'.repeat(32), name: 'InstalledSite', category: 'Manga' });
  const liveOnly = site({
    id: '2'.repeat(32),
    name: 'LiveOnlySite',
    category: 'Manga',
    catalogInstalled: false,
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: [],
      known_broken_flags: [],
      live_scrape_fallback: true,
    },
  });
  const needsSetup = site({
    id: '3'.repeat(32),
    name: 'FreshSite',
    category: 'Manhwa',
    catalogInstalled: false,
  });
  const broken = site({
    id: '4'.repeat(32),
    name: 'BrokenSite',
    category: 'Manga',
    catalogInstalled: true,
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: [],
      known_broken_flags: ['cloudflare-loop'],
      live_scrape_fallback: false,
    },
  });
  const disabled = site({ id: '5'.repeat(32), name: 'DisabledSite', category: 'Manga', enabled: false });

  it('renders sites by name, grouped by category, with catalog-state chips and badges', async (): Promise<void> => {
    renderWithProviders(<SitePickerPage onPick={(): void => {}} />, {
      fetch: mockFetch([modulesRoute([installed, liveOnly, needsSetup, broken, disabled])]).fetch,
    });

    expect(await screen.findByText('InstalledSite')).toBeVisible();
    expect(screen.getByText('LiveOnlySite')).toBeVisible();
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.getByText('BrokenSite')).toBeVisible();
    // Disabled modules are not offered.
    expect(screen.queryByText('DisabledSite')).toBeNull();

    // Category grouping headers.
    expect(screen.getByText('Manga')).toBeVisible();
    expect(screen.getByText('Manhwa')).toBeVisible();

    // Catalog-state chips (one per installed site — two here).
    expect(screen.getAllByText('catalog ready')).toHaveLength(2);
    expect(screen.getByText('live browse')).toBeVisible();
    expect(screen.getByText('needs setup')).toBeVisible();

    // Capability badges ride the rows (§5.10).
    expect(screen.getAllByText('live-scrape browse').length).toBeGreaterThan(0);

    // The hex-ID contract: no 32-hex string is ever rendered as text.
    expect(screen.queryByText(HEX32)).toBeNull();
  });

  it('search filters by name across categories', async (): Promise<void> => {
    renderWithProviders(<SitePickerPage onPick={(): void => {}} />, {
      fetch: mockFetch([modulesRoute([installed, needsSetup])]).fetch,
    });
    const input = await screen.findByLabelText('Search sites');
    await userEvent.type(input, 'fresh');
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.queryByText('InstalledSite')).toBeNull();
  });

  it('known-broken rows are disabled with the reason surfaced', async (): Promise<void> => {
    renderWithProviders(<SitePickerPage onPick={(): void => {}} />, {
      fetch: mockFetch([modulesRoute([broken])]).fetch,
    });
    const row = await screen.findByRole('button', { name: /BrokenSite/ });
    expect(row).toBeDisabled();
    expect(row.getAttribute('title')).toContain('cloudflare-loop');
    // Both the row badge and the capability list carry the flag.
    expect(screen.getAllByText(/known broken:/).length).toBeGreaterThan(0);
    expect(screen.queryByText(HEX32)).toBeNull();
  });

  it('picking a site calls back with the module (router owns the ?site= URL)', async (): Promise<void> => {
    const picked: ModuleSummaryT[] = [];
    renderWithProviders(
      <SitePickerPage
        onPick={(module): void => {
          picked.push(module);
        }}
      />,
      { fetch: mockFetch([modulesRoute([installed])]).fetch },
    );
    await userEvent.click(await screen.findByRole('button', { name: /InstalledSite/ }));
    expect(picked).toHaveLength(1);
    expect(picked[0]?.id).toBe(installed.id);
  });

  it('an empty registry explains the D20 bootstrap instead of a hex form', async (): Promise<void> => {
    renderWithProviders(<SitePickerPage onPick={(): void => {}} />, {
      fetch: mockFetch([modulesRoute([])]).fetch,
    });
    expect(await screen.findByText(/first-run module sync/)).toBeVisible();
    // The deleted CatalogIdForm contract: no catalog-id form anywhere.
    expect(screen.queryByLabelText('Catalog id')).toBeNull();
    expect(within(document.body).queryByLabelText('Open catalog by id')).toBeNull();
  });
});
