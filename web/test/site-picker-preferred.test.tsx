/**
 * Preferred sites in the site picker ([fuzzy-javelin-pearls]):
 *
 * - buildPickerItems: the Preferred group floats FIRST in CANONICAL
 *   allowlist order (D1 §3 — presentation order), the rest keep the
 *   category-grouped A→Z shape; a dead preferred site STAYS in the
 *   group (dimmed by SiteRow's hint, never hidden)
 * - integration: the star toggle PUTs the next FULL ordered list
 *   (append on star, remove on un-star); after the write the row
 *   re-renders inside the Preferred group with the star pressed
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SitePickerPage } from '../src/pages/SitePickerPage';
import { buildPickerItems, PREFERRED_GROUP_LABEL } from '../src/pages/SitePickerPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { moduleFixture } from './fixtures';
import type { ModuleSummaryT } from '../src/api/hooks';

autoCleanup();

const SITE_A = 'a'.repeat(32);
const SITE_B = 'b'.repeat(32);

function rows(): ModuleSummaryT[] {
  return [
    moduleFixture({ id: SITE_A, name: 'Zebra Site', category: 'Raw' }),
    moduleFixture({ id: SITE_B, name: 'Alpha Site', category: 'English' }),
  ];
}

describe('buildPickerItems — preferred group ordering', () => {
  it('floats the Preferred group FIRST in allowlist order; the rest keep category groups', () => {
    const items = buildPickerItems(rows(), '', [], [SITE_A, SITE_B]);
    expect(
      items.map((item): string =>
        item.kind === 'header' ? `header:${item.category}` : `site:${item.module.id}`,
      ),
    ).toEqual([
      `header:${PREFERRED_GROUP_LABEL}`,
      `site:${SITE_A}`, // allowlist order, NOT name order (Zebra first)
      `site:${SITE_B}`,
      // both sites floated — no category group remains
    ]);
  });

  it('no allowlist → the exact pre-scope shape (category groups only)', () => {
    const items = buildPickerItems(rows(), '', [], []);
    expect(items.map((item): string => (item.kind === 'header' ? `header:${item.category}` : `site:${item.module.id}`))).toEqual([
      'header:English',
      `site:${SITE_B}`,
      'header:Raw',
      `site:${SITE_A}`,
    ]);
  });

  it('a preferred site that falls out of the filter (category facet) leaves the group', () => {
    const items = buildPickerItems(rows(), '', ['English'], [SITE_A]);
    expect(items.map((item): string => (item.kind === 'header' ? `header:${item.category}` : `site:${item.module.id}`))).toEqual([
      'header:English',
      `site:${SITE_B}`,
    ]);
  });
});

function modulesRoute(rows: ModuleSummaryT[]): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/modules',
    respond: (): { body: object } => ({ body: { modules: rows, count: rows.length } }),
  };
}

describe('SitePickerPage — the preferred star', () => {
  it('starring a site PUTs the next full ordered list and re-renders the Preferred group', async () => {
    const user = userEvent.setup();
    const puts: string[] = [];
    let current: string[] = [];
    const { fetch } = mockFetch([
      modulesRoute(rows()),
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/preferred-sites',
        respond: (): { body: object } => ({ body: { sites: [...current] } }),
      },
      {
        method: 'PUT',
        match: (url): boolean => url.pathname === '/api/preferred-sites',
        respond: (_url, body): { body: object } => {
          puts.push(String(body === undefined ? '' : JSON.stringify(body)));
          const next = (body as { sites?: string[] } | undefined)?.sites ?? [];
          current = [...next];
          return { body: { sites: next } };
        },
      },
    ]);
    renderWithProviders(<SitePickerPage route={{ name: 'browse', query: { sites: '1' } }} onPick={(): void => undefined} />, {
      fetch,
      hash: '#/browse?sites=1',
    });
    const starA = await screen.findByTestId(`prefer-toggle-${SITE_A}`);
    await user.click(starA);
    await waitFor((): void => {
      expect(puts.length).toBe(1);
    });
    expect(JSON.parse(puts[0] ?? '{}')).toEqual({ sites: [SITE_A] });
    // After the write the Preferred group renders with Zebra first.
    await waitFor((): void => {
      expect(screen.getByText(PREFERRED_GROUP_LABEL)).toBeVisible();
    });
    expect(screen.getByTestId(`prefer-toggle-${SITE_A}`)).toHaveAttribute('aria-pressed', 'true');
    // Un-star sends the list WITHOUT the site.
    await user.click(screen.getByTestId(`prefer-toggle-${SITE_A}`));
    await waitFor((): void => {
      expect(puts.length).toBe(2);
    });
    expect(JSON.parse(puts[1] ?? '{}')).toEqual({ sites: [] });
  });
});
