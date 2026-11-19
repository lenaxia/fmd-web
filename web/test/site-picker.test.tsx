// @vitest-environment jsdom

/**
 * SitePickerPage (site-first browse): sites render BY NAME with
 * category grouping, readiness chips and capability badges;
 * known-broken rows are disabled with their reason; hex module ids are
 * NEVER rendered as text (they ride data attributes + the URL only);
 * picking a site routes to browse?site=<id>.
 *
 * Category facet filter (language parity): SiteFilterChips render one
 * chip per category with counts; selection is multi-select, URL-synced
 * (?cats=csv), 'All' by default, AND-composed with the search box.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModuleSummaryT } from '../src/api/hooks';
import { moduleFixture } from './fixtures';
import { renderWithProviders, autoCleanup, mockFetch, type MockRoute } from './helpers';
import { SitePickerPage } from '../src/pages/SitePickerPage';
import { parseHash } from '../src/router';

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

function picker(modules: readonly ModuleSummaryT[], hash = '#/browse') {
  return renderWithProviders(
    <SitePickerPage route={parseHash(hash)} onPick={(): void => {}} />,
    { fetch: mockFetch([modulesRoute(modules)]).fetch, hash },
  );
}

const chips = (): HTMLElement => screen.getByRole('group', { name: 'Filter sites by category' });

const chip = (name: string): HTMLElement => within(chips()).getByRole('button', { name: new RegExp(`^${name}( |$)`) });

const hashNow = (): string => decodeURIComponent(globalThis.location.hash);

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
  const spanish = site({ id: '6'.repeat(32), name: 'SitioEs', category: 'Spanish', catalogInstalled: true });

  it('renders sites by name, grouped by category, with readiness chips and badges', async (): Promise<void> => {
    picker([installed, liveOnly, needsSetup, broken, disabled]);

    expect(await screen.findByText('InstalledSite')).toBeVisible();
    expect(screen.getByText('LiveOnlySite')).toBeVisible();
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.getByText('BrokenSite')).toBeVisible();
    // Disabled modules are not offered.
    expect(screen.queryByText('DisabledSite')).toBeNull();

    // Category grouping headers (selector-scoped: chips carry the same
    // category words).
    expect(screen.getByText('Manga', { selector: '.site-category' })).toBeVisible();
    expect(screen.getByText('Manhwa', { selector: '.site-category' })).toBeVisible();

    // Readiness chips: installed → ready; catalog-less → needs setup
    // (unified browsing — no mode vocabulary on chips).
    expect(screen.getAllByText('ready')).toHaveLength(2);
    expect(screen.getAllByText('needs setup')).toHaveLength(2);

    // Capability badges ride the rows (§5.10) — the directory
    // capability, plumbing-free.
    expect(screen.getByText('directory')).toBeVisible();

    // THE MODE-VOCABULARY CONTRACT: no 'live browse' / 'scrape'
    // strings anywhere in the rendered picker.
    expect(screen.queryByText(/live browse/i)).toBeNull();
    expect(screen.queryByText(/scrape/i)).toBeNull();

    // The hex-ID contract: no 32-hex string is ever rendered as text.
    expect(screen.queryByText(HEX32)).toBeNull();
  });

  it('search filters by name across categories', async (): Promise<void> => {
    picker([installed, needsSetup]);
    const input = await screen.findByLabelText('Search sites');
    await userEvent.type(input, 'fresh');
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.queryByText('InstalledSite')).toBeNull();
  });

  it('known-broken rows are disabled with the reason surfaced', async (): Promise<void> => {
    picker([broken]);
    const row = await screen.findByRole('button', { name: /BrokenSite: browse/ });
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
        route={parseHash('#/browse')}
        onPick={(module): void => {
          picked.push(module);
        }}
      />,
      { fetch: mockFetch([modulesRoute([installed])]).fetch, hash: '#/browse' },
    );
    await userEvent.click(await screen.findByRole('button', { name: /InstalledSite: browse/ }));
    expect(picked).toHaveLength(1);
    expect(picked[0]?.id).toBe(installed.id);
  });

  it('an empty registry explains the D20 bootstrap instead of a hex form', async (): Promise<void> => {
    picker([]);
    expect(await screen.findByText(/first-run module sync/)).toBeVisible();
    // The deleted CatalogIdForm contract: no catalog-id form anywhere.
    expect(screen.queryByLabelText('Catalog id')).toBeNull();
    expect(within(document.body).queryByLabelText('Open catalog by id')).toBeNull();
  });

  // ── category facet filter (chips matrix) ────────────────────────────

  it('renders one chip per category with counts (All default, aria-pressed)', async (): Promise<void> => {
    picker([installed, liveOnly, broken, needsSetup, spanish, disabled]);
    await screen.findByText('InstalledSite');

    // Counts cover the ENABLED registry (disabled modules excluded):
    // Manga 3 (installed, liveOnly, broken), Manhwa 1, Spanish 1.
    expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Manga')).toHaveAttribute('aria-pressed', 'false');
    expect(chip('Manga')).toHaveTextContent('Manga');
    expect(within(chip('Manga')).getByText('3')).toBeVisible();
    expect(chip('Manhwa')).toBeInTheDocument();
    expect(chip('Spanish')).toBeInTheDocument();
  });

  it('single category chip filters the list to that category', async (): Promise<void> => {
    picker([installed, liveOnly, needsSetup, spanish]);
    await screen.findByText('InstalledSite');

    await userEvent.click(chip('Manhwa'));
    expect(screen.getByText('FreshSite')).toBeVisible();
    await waitFor((): void => {
      expect(screen.queryByText('InstalledSite')).toBeNull();
      expect(screen.queryByText('LiveOnlySite')).toBeNull();
      expect(screen.queryByText('SitioEs')).toBeNull();
      // The Manga group header is gone with its rows.
      expect(screen.queryByText('Manga', { selector: '.site-category' })).toBeNull();
    });
    // URL-synced: ?cats=Manhwa.
    await waitFor((): void => {
      expect(hashNow()).toBe('#/browse?sites=1&cats=Manhwa');
    });
    expect(chip('All')).toHaveAttribute('aria-pressed', 'false');
    expect(chip('Manhwa')).toHaveAttribute('aria-pressed', 'true');
  });

  it('multi-select chips union their categories; All resets', async (): Promise<void> => {
    picker([installed, needsSetup, spanish]);
    await screen.findByText('InstalledSite');

    await userEvent.click(chip('Manhwa'));
    await userEvent.click(chip('Spanish'));
    await waitFor((): void => {
      expect(hashNow()).toBe('#/browse?sites=1&cats=Manhwa,Spanish');
    });
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.getByText('SitioEs')).toBeVisible();
    await waitFor((): void => {
      expect(screen.queryByText('InstalledSite')).toBeNull();
    });

    // All clears the selection (cats param gone; the picker keeps its
    // own ?sites=1 address since the search-first home took bare browse).
    await userEvent.click(chip('All'));
    await waitFor((): void => {
      expect(hashNow()).toBe('#/browse?sites=1');
    });
    expect(screen.getByText('InstalledSite')).toBeVisible();
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.getByText('SitioEs')).toBeVisible();
  });

  it('toggling a selected chip off drops just that category', async (): Promise<void> => {
    picker([installed, needsSetup, spanish]);
    await screen.findByText('InstalledSite');

    await userEvent.click(chip('Manhwa'));
    await userEvent.click(chip('Spanish'));
    await waitFor((): void => {
      expect(hashNow()).toBe('#/browse?sites=1&cats=Manhwa,Spanish');
    });
    await userEvent.click(chip('Spanish'));
    expect(screen.getByText('FreshSite')).toBeVisible();
    await waitFor((): void => {
      expect(screen.queryByText('SitioEs')).toBeNull();
      expect(hashNow()).toBe('#/browse?sites=1&cats=Manhwa');
    });
  });

  it('chips AND-compose with the search box', async (): Promise<void> => {
    picker([installed, liveOnly, needsSetup, spanish]);
    await screen.findByText('InstalledSite');

    await userEvent.click(chip('Manga'));
    await waitFor((): void => {
      expect(hashNow()).toBe('#/browse?sites=1&cats=Manga');
    });
    await userEvent.type(await screen.findByLabelText('Search sites'), 'live');
    expect(screen.getByText('LiveOnlySite')).toBeVisible();
    await waitFor((): void => {
      expect(screen.queryByText('InstalledSite')).toBeNull();
      expect(screen.queryByText('FreshSite')).toBeNull();
    });
    // Search keeps the cats param on the URL untouched.
    expect(hashNow()).toBe('#/browse?sites=1&cats=Manga');
  });

  it('URL round-trip: ?cats= at mount filters the list and presses the chip', async (): Promise<void> => {
    picker([installed, liveOnly, needsSetup, spanish], '#/browse?cats=Spanish');
    expect(await screen.findByText('SitioEs')).toBeVisible();
    expect(screen.queryByText('InstalledSite')).toBeNull();
    expect(screen.queryByText('FreshSite')).toBeNull();
    expect(chip('Spanish')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('All')).toHaveAttribute('aria-pressed', 'false');
  });

  it('unknown categories in a shared URL are dropped (never an empty list)', async (): Promise<void> => {
    picker([installed, spanish], '#/browse?cats=NoSuchCategory,Spanish');
    expect(await screen.findByText('SitioEs')).toBeVisible();
    await waitFor((): void => {
      expect(screen.queryByText('InstalledSite')).toBeNull();
    });
  });

  it('empty category+search result explains itself', async (): Promise<void> => {
    picker([needsSetup, spanish]);
    await screen.findByText('FreshSite');
    await userEvent.click(chip('Spanish'));
    await waitFor((): void => {
      expect(screen.queryByText('FreshSite')).toBeNull();
    });
    await userEvent.type(await screen.findByLabelText('Search sites'), 'zzz');
    expect(await screen.findByText(/No sites match .+ in the selected categories\./)).toBeVisible();
  });
});
