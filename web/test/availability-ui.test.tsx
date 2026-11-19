// @vitest-environment jsdom
/**
 * Site-availability UI pins (dead-site discovery): the LAST-CHECK chip
 * (icon states + checked_at/reason tooltip, distinct from the catalog
 * chip), the Settings registry row (status marker + the per-row Check
 * action writing the record through the API), and the site picker
 * (unreachable rows DIMMED but fully clickable — a hint, never a gate;
 * the client-local Hide-unavailable toggle; unknown renders normal).
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModuleSummaryT } from '../src/api/hooks';
import { AvailabilityChip, availabilityTitle } from '../src/components/AvailabilityChip';
import { SiteRow } from '../src/components/SiteRow';
import { SitePickerPage } from '../src/pages/SitePickerPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { moduleFixture } from './fixtures';
import { autoCleanup, FULL_SETTINGS, mockFetch, renderWithProviders } from './helpers';
import { parseHash } from '../src/router';

autoCleanup();

const REACHABLE = { status: 'reachable' as const, checkedAt: '2026-11-19T00:00:00Z', reason: null };
const UNREACHABLE = {
  status: 'unreachable' as const,
  checkedAt: '2026-11-19T00:00:00Z',
  reason: 'connect ECONNREFUSED 127.0.0.1:9',
};
const UNKNOWN = { status: 'unknown' as const, checkedAt: null, reason: null };

describe('AvailabilityChip (the Last check marker)', (): void => {
  it('reachable: success icon + tooltip with age', (): void => {
    renderWithProviders(<AvailabilityChip availability={REACHABLE} />);
    const chip = screen.getByRole('img');
    expect(chip).toHaveAttribute('title', expect.stringContaining('Last check: reachable'));
  });

  it('unreachable: dead-site icon + tooltip carrying the REASON', (): void => {
    renderWithProviders(<AvailabilityChip availability={UNREACHABLE} />);
    const chip = screen.getByRole('img');
    expect(chip).toHaveAttribute('title', expect.stringContaining('unreachable'));
    expect(chip).toHaveAttribute('title', expect.stringContaining('connect ECONNREFUSED'));
    expect(chip.className).toContain('availability-chip-down');
  });

  it('unknown: muted icon + never-checked tooltip (renders as a normal row concern)', (): void => {
    renderWithProviders(<AvailabilityChip availability={UNKNOWN} />);
    expect(screen.getByRole('img')).toHaveAttribute('title', expect.stringContaining('never'));
    expect(availabilityTitle(UNKNOWN)).toContain('never');
  });

  it('says "Last check", never "Catalog" — a different concern than catalogInstalled', (): void => {
    for (const availability of [REACHABLE, UNREACHABLE, UNKNOWN]) {
      expect(availabilityTitle(availability)).toContain('Last check');
      expect(availabilityTitle(availability)).not.toContain('Catalog');
    }
  });
});

describe('SiteRow availability dimming (picker)', (): void => {
  it('unreachable rows DIM + badge + hint, but stay fully clickable (no gate)', async (): Promise<void> => {
    const onPick = vi.fn();
    const module = moduleFixture({ id: 'd'.repeat(32), name: 'DeadMirror', availability: UNREACHABLE });
    renderWithProviders(<SiteRow module={module} onPick={onPick} />);
    const row = screen.getByText('DeadMirror').closest('.site-row') as HTMLElement;
    expect(row.dataset['unavailable']).toBe('true');
    expect(row.className).toContain('site-row-unavailable');
    expect(within(row).getByTestId(`site-unavailable-${module.id}`)).toBeVisible();
    // The hint, not a gate: clicking still picks the site.
    await userEvent.click(screen.getByRole('button', { name: /DeadMirror/ }));
    expect(onPick).toHaveBeenCalledWith(module);
  });

  it('unknown rows render as NORMAL rows (no dim, no badge)', (): void => {
    const module = moduleFixture({ id: 'e'.repeat(32), name: 'FreshSite', availability: UNKNOWN });
    renderWithProviders(<SiteRow module={module} onPick={vi.fn()} />);
    const row = screen.getByText('FreshSite').closest('.site-row') as HTMLElement;
    expect(row.dataset['unavailable']).toBeUndefined();
    expect(row.className).not.toContain('site-row-unavailable');
  });
});

describe('SitePickerPage: Hide unavailable (client-local view state)', (): void => {
  const modules: readonly ModuleSummaryT[] = [
    moduleFixture({ id: '1'.repeat(32), name: 'AliveSite', category: 'Manga', availability: REACHABLE }),
    moduleFixture({ id: '2'.repeat(32), name: 'DeadSite', category: 'Manga', availability: UNREACHABLE }),
    moduleFixture({ id: '3'.repeat(32), name: 'FreshSite', category: 'Manga', availability: UNKNOWN }),
  ];

  function picker(): ReturnType<typeof renderWithProviders> {
    const { fetch } = mockFetch([
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: unknown } => ({ body: { modules, count: modules.length } }),
      },
    ]);
    return renderWithProviders(
      <SitePickerPage route={parseHash('#/browse?sites=1')} onPick={(): void => {}} />,
      { fetch, hash: '#/browse?sites=1' },
    );
  }

  it('the toggle is plain UI state: unreachable hides, unknown + reachable stay; never in the URL', async (): Promise<void> => {
    picker();
    expect(await screen.findByText('DeadSite')).toBeVisible();
    expect(screen.getByText('FreshSite')).toBeVisible();
    await userEvent.click(screen.getByTestId('hide-unavailable-toggle'));
    await waitFor((): void => {
      expect(screen.queryByText('DeadSite')).not.toBeInTheDocument();
    });
    expect(screen.getByText('AliveSite')).toBeVisible();
    expect(screen.getByText('FreshSite')).toBeVisible();
    // Client-local ONLY: the toggle never lands in the shareable URL.
    expect(globalThis.location.hash).not.toContain('hide');
    // and back: unchecking restores the dimmed row.
    await userEvent.click(screen.getByTestId('hide-unavailable-toggle'));
    await waitFor((): void => {
      expect(screen.getByText('DeadSite')).toBeVisible();
    });
  });
});

describe('Settings registry: status column + per-row Check', (): void => {
  const MODULE_A = 'a'.repeat(32);
  const registry: readonly ModuleSummaryT[] = [
    moduleFixture({ id: MODULE_A, name: 'AliveSource', availability: UNKNOWN }),
    moduleFixture({ id: 'b'.repeat(32), name: 'DeadSource', availability: UNREACHABLE }),
  ];

  it('the Last check facet chips render with live counts (All/Reachable/Unreachable/Unknown)', async (): Promise<void> => {
    const { fetch } = mockFetch([
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: unknown } => ({ body: { modules: registry, count: registry.length } }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({ body: { ...FULL_SETTINGS } }),
      },
    ]);
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    const group = within(within(facets).getByRole('group', { name: 'Last check' }));
    expect(group.getByRole('button', { name: /All 2/ })).toBeVisible();
    expect(group.getByRole('button', { name: /Reachable 0/ })).toBeVisible();
    expect(group.getByRole('button', { name: /Unreachable 1/ })).toBeVisible();
    expect(group.getByRole('button', { name: /Unknown 1/ })).toBeVisible();
  });

  it('the Unreachable chip filters the registry (?filter= URL-as-truth)', async (): Promise<void> => {
    const { fetch } = mockFetch([
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: unknown } => ({ body: { modules: registry, count: registry.length } }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({ body: { ...FULL_SETTINGS } }),
      },
    ]);
    renderWithProviders(<SettingsPage />, { fetch });
    const facets = await screen.findByTestId('module-facets');
    await userEvent.click(within(facets).getByRole('button', { name: /Unreachable 1/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toContain('filter=unreachable');
    });
    await waitFor((): void => {
      expect(screen.queryByLabelText('AliveSource', { exact: true })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('DeadSource', { exact: true })).toBeVisible();
  });

  it('the per-row Check probes once and the written record flips the row (unknown → reachable)', async (): Promise<void> => {
    const checkBody = {
      moduleId: MODULE_A,
      verdict: 'reachable',
      detail: 'Reachable (HTTP 200)',
      availability: REACHABLE,
    };
    // The record rides /api/modules: the GET answers the PRE-check
    // registry until the Check POST fires, then the post-check one —
    // exactly the cache-invalidation flow useCheckModule drives.
    let checked = false;
    const { requests, fetch } = mockFetch([
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: unknown } => ({
          body: {
            modules: checked
              ? [moduleFixture({ id: MODULE_A, name: 'AliveSource', availability: REACHABLE }), ...registry.filter((m): boolean => m.id !== MODULE_A)]
              : registry,
            count: registry.length,
          },
        }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({ body: { ...FULL_SETTINGS } }),
      },
      {
        method: 'POST',
        match: (url): boolean => url.pathname === `/api/modules/${MODULE_A}/check`,
        respond: (): { status: number; body: unknown } => {
          checked = true;
          return { status: 200, body: checkBody };
        },
      },
    ]);
    renderWithProviders(<SettingsPage />, { fetch });
    expect(await screen.findByTestId(`check-site-${MODULE_A}`)).toBeVisible();
    // Unknown renders the muted marker first.
    expect(screen.getByTestId(`availability-${MODULE_A}`).className).toContain('availability-chip-unknown');
    await userEvent.click(screen.getByTestId(`check-site-${MODULE_A}`));
    await waitFor((): void => {
      expect(
        requests.some((r): boolean => r.method === 'POST' && r.path === `/api/modules/${MODULE_A}/check`),
      ).toBe(true);
    });
    // The modules list refetch carries the record: the marker flips.
    await waitFor((): void => {
      expect(screen.getByTestId(`availability-${MODULE_A}`).className).toContain('availability-chip-ok');
    });
  });

  it('every registry row carries a status marker (the "status column")', async (): Promise<void> => {
    const { fetch } = mockFetch([
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: unknown } => ({ body: { modules: registry, count: registry.length } }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({ body: { ...FULL_SETTINGS } }),
      },
    ]);
    renderWithProviders(<SettingsPage />, { fetch });
    expect(await screen.findByTestId(`availability-${MODULE_A}`)).toBeVisible();
    expect(screen.getByTestId(`availability-${'b'.repeat(32)}`)).toBeVisible();
    // the unreachable marker's tooltip names the reason
    expect(screen.getByTestId(`availability-${'b'.repeat(32)}`)).toHaveAttribute(
      'title',
      expect.stringContaining('connect ECONNREFUSED'),
    );
  });
});
