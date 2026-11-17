// @vitest-environment jsdom
/**
 * Capability badge rendering tests (§5.10 / D3): every detected flag
 * — browser, subprocess, bypass gating, account — and every
 * known-broken flag id renders; absent flags render nothing (the §15
 * ecosystem metric must be visible per module, no silent breakage).
 * Also drives the full Settings list over a mock fetch.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapabilityBadges } from '../src/components/CapabilityBadges';
import { SettingsPage } from '../src/pages/SettingsPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { moduleFixture } from './fixtures';

autoCleanup();

describe('CapabilityBadges component', (): void => {
  it('renders all capability badges and one per known-broken flag', (): void => {
    render(
      <CapabilityBadges
        module={moduleFixture({
          name: 'HeavySite',
          accountSupport: true,
          capabilities: {
            requires_subprocess: true,
            requires_browser: true,
            bypass_python_gated: true,
            requires_imagepuzzle: false,
            requires_mangafoxwatermark: false,
            events: [],
            known_broken_flags: ['ehentai-image', 'tapas-cloudflare'],
            live_scrape_fallback: true,
          },
        })}
      />,
    );
    expect(screen.getByTitle('Upstream regression flag (D3): ehentai-image')).toHaveTextContent('known broken: ehentai-image');
    expect(screen.getByTitle('Upstream regression flag (D3): tapas-cloudflare')).toHaveTextContent('known broken: tapas-cloudflare');
    expect(screen.getByTitle(/browser\/antibot sidecar profile/)).toHaveTextContent('needs browser');
    expect(screen.getByTitle(/shells out to a subprocess/)).toHaveTextContent('subprocess');
    expect(screen.getByTitle(/python-gated bypass/)).toHaveTextContent('bypass-gated');
    expect(screen.getByTitle(/list its titles straight from the site/)).toHaveTextContent('directory');
    expect(screen.getByTitle(/account login/)).toHaveTextContent('account');
  });

  it('renders no badges for a clean module (nothing invented)', (): void => {
    render(<CapabilityBadges module={moduleFixture()} />);
    expect(screen.queryByText(/known broken/)).not.toBeInTheDocument();
    expect(screen.queryByText('needs browser')).not.toBeInTheDocument();
    expect(screen.queryByText('subprocess')).not.toBeInTheDocument();
    expect(screen.queryByText('bypass-gated')).not.toBeInTheDocument();
    expect(screen.queryByText('directory')).not.toBeInTheDocument();
    expect(screen.queryByText('account')).not.toBeInTheDocument();
  });
});

describe('Settings page module list (badges over the API)', (): void => {
  it('lists modules with badges and opens the options editor', async (): Promise<void> => {
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: object } => ({
          body: {
            modules: [
              moduleFixture({
                name: 'BrowserSite',
                capabilities: {
                  requires_subprocess: false,
                  requires_browser: true,
                  bypass_python_gated: false,
                  requires_imagepuzzle: false,
                  requires_mangafoxwatermark: false,
                  events: [],
                  known_broken_flags: ['cloudflare-loop'],
                  live_scrape_fallback: false,
                },
              }),
            ],
            count: 1,
          },
        }),
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<SettingsPage />, { fetch });

    expect(await screen.findByText('BrowserSite')).toBeInTheDocument();
    expect(screen.getByText('known broken: cloudflare-loop')).toBeInTheDocument();
    expect(screen.getByText('needs browser')).toBeInTheDocument();
    expect(screen.queryByText('subprocess')).not.toBeInTheDocument();

    // The editor honors the module's option descriptors (combobox index seeds).
    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(screen.getByLabelText(`Options for BrowserSite`)).toBeInTheDocument();
  });
});
