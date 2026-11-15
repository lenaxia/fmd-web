// @vitest-environment jsdom
/**
 * Settings → proxy rendering tests (§9/§10, §5.4 SetProxy parity, D2
 * §5.11): the global proxy editor (typed config, Save → PUT
 * /api/settings/proxy), the browser sidecar profile badge, and the
 * per-module proxy override — plus the Settings → Modules 'requires
 * browser' badge surface over a mock fetch (fully offline).
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProxySettingsSection } from '../src/components/ProxySettings';
import { SettingsPage } from '../src/pages/SettingsPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { moduleFixture } from './fixtures';

autoCleanup();

describe('ProxySettingsSection (global proxy + sidecar badge)', (): void => {
  it('renders the browser sidecar OFF badge and the five SetProxy fields (none default)', async (): Promise<void> => {
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({
          body: { proxy: { type: '', host: '', port: '', user: '', pass: '' }, browser: { enabled: false, url: '' } },
        }),
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<ProxySettingsSection />, { fetch });
    expect(await screen.findByTitle(/browser profile .*not active/i)).toHaveTextContent('browser sidecar: off');
    expect(screen.getByLabelText('Type')).toHaveValue('');
    expect(screen.getByLabelText('Host')).toBeDisabled();
    expect(screen.getByLabelText('Port')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save proxy' })).toBeDisabled(); // nothing drafted yet
  });

  it('renders the enabled sidecar badge when the profile is active', async (): Promise<void> => {
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({
          body: {
            proxy: { type: '', host: '', port: '', user: '', pass: '' },
            browser: { enabled: true, url: 'http://flaresolverr:8191' },
          },
        }),
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<ProxySettingsSection />, { fetch });
    expect(await screen.findByTitle(/profile active/i)).toHaveTextContent('browser sidecar: enabled');
  });

  it('edits a SOCKS5 config and PUTs the five-string body on Save', async (): Promise<void> => {
    const putBodies: unknown[] = [];
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({
          body: { proxy: { type: '', host: '', port: '', user: '', pass: '' }, browser: { enabled: false, url: '' } },
        }),
      },
      {
        method: 'PUT',
        match: (url): boolean => url.pathname === '/api/settings/proxy',
        respond: (_url, body): { body: object } => {
          putBodies.push(body);
          return { body: { proxy: body, browser: { enabled: false, url: '' } } };
        },
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<ProxySettingsSection />, { fetch });

    await screen.findByTitle(/not active/i);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Type'), 'SOCKS5');
    await user.type(screen.getByLabelText('Host'), 'proxy.example');
    await user.type(screen.getByLabelText('Port'), '1080');
    await user.type(screen.getByLabelText('User'), 'u');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Save proxy' }));
    await waitFor((): void => {
      expect(putBodies).toHaveLength(1);
    });
    expect(putBodies[0]).toEqual({ type: 'SOCKS5', host: 'proxy.example', port: '1080', user: 'u', pass: 'pw' });
    expect(await screen.findByRole('status')).toHaveTextContent(/Global proxy: SOCKS5 proxy\.example:1080/);
  });
});

describe('Settings page: proxy section + module capability badges + override', (): void => {
  it('lists modules with the requires-browser badge and saves a module proxy override', async (): Promise<void> => {
    const moduleBodies: unknown[] = [];
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: object } => ({
          body: {
            modules: [
              moduleFixture({
                id: 'a'.repeat(32),
                name: 'BrowserSite',
                capabilities: {
                  requires_subprocess: false,
                  requires_browser: true,
                  bypass_python_gated: false,
                  requires_imagepuzzle: false,
                  requires_mangafoxwatermark: false,
                  events: [],
                  known_broken_flags: ['madara.run_html_load'],
                  live_scrape_fallback: false,
                },
              }),
            ],
            count: 1,
          },
        }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({
          body: { proxy: { type: '', host: '', port: '', user: '', pass: '' }, browser: { enabled: false, url: '' } },
        }),
      },
      {
        method: 'PUT',
        match: (url): boolean => url.pathname.startsWith('/api/modules/'),
        respond: (_url, body): { body: object } => {
          moduleBodies.push(body);
          return { body: moduleFixture({ id: 'a'.repeat(32), name: 'BrowserSite', proxy: { type: 'HTTP', host: 'p', port: '8080', user: '', pass: '' } }) };
        },
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<SettingsPage />, { fetch });

    // the §5.10 badge surface: requires browser + known-broken flag
    expect(await screen.findByTitle(/browser\/antibot sidecar profile/)).toHaveTextContent('needs browser');
    expect(screen.getByTitle(/madara\.run_html_load/)).toHaveTextContent('known broken: madara.run_html_load');
    // the proxy section is on the page
    expect(screen.getByRole('region', { name: 'Proxy settings' })).toBeInTheDocument();

    // open the module editor and save an override
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Configure' }));
    const overrideForm = await screen.findByRole('form', { name: /Proxy override for BrowserSite/ });
    const overrideCheckbox = within(overrideForm).getByLabelText(/Module proxy override/) as HTMLInputElement;
    expect(overrideCheckbox.checked).toBe(false);
    await user.click(overrideCheckbox);
    await user.selectOptions(within(overrideForm).getByLabelText('Type'), 'HTTP');
    await user.type(within(overrideForm).getByLabelText('Host'), 'p');
    await user.type(within(overrideForm).getByLabelText('Port'), '8080');
    await user.click(within(overrideForm).getByRole('button', { name: 'Save module proxy' }));
    await waitFor((): void => {
      expect(moduleBodies).toHaveLength(1);
    });
    expect(moduleBodies[0]).toEqual({ proxy: { type: 'HTTP', host: 'p', port: '8080', user: '', pass: '' } });
  });

  it('unchecked override saves an explicit null (inherit the global proxy)', async (): Promise<void> => {
    const moduleBodies: unknown[] = [];
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: object } => ({
          body: {
            modules: [
              moduleFixture({
                id: 'b'.repeat(32),
                name: 'OverriddenSite',
                proxy: { type: 'SOCKS4', host: 's', port: '1080', user: '', pass: '' },
              }),
            ],
            count: 1,
          },
        }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({
          body: { proxy: { type: '', host: '', port: '', user: '', pass: '' }, browser: { enabled: false, url: '' } },
        }),
      },
      {
        method: 'PUT',
        match: (url): boolean => url.pathname.startsWith('/api/modules/'),
        respond: (_url, body): { body: object } => {
          moduleBodies.push(body);
          return { body: moduleFixture({ id: 'b'.repeat(32), name: 'OverriddenSite', proxy: null }) };
        },
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<SettingsPage />, { fetch });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Configure' }));
    const overrideForm = await screen.findByRole('form', { name: /Proxy override for OverriddenSite/ });
    const overrideCheckbox = within(overrideForm).getByLabelText(/Module proxy override/) as HTMLInputElement;
    expect(overrideCheckbox.checked).toBe(true); // the module carries an override
    await user.click(overrideCheckbox); // unchecked → inherit global
    await user.click(within(overrideForm).getByRole('button', { name: 'Save module proxy' }));
    await waitFor((): void => {
      expect(moduleBodies).toHaveLength(1);
    });
    expect(moduleBodies[0]).toEqual({ proxy: null });
  });
});
