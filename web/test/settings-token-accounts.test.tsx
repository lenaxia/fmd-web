// @vitest-environment jsdom
/**
 * v0.3.1 hotfix UI pins (owner directive — *arr token semantics +
 * enabled-only accounts):
 * - ApiTokenSection ALWAYS renders with a token (it exists and rotates
 *   with NO password configured); the old "Auth is off. A token is
 *   generated … once a password is set" gate copy is GONE; env-pinned
 *   deployments keep "Managed via environment".
 * - AccountsSection lists only ENABLED sites (disabled sites are off
 *   the manager until re-enabled).
 */
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { ApiTokenSection } from '../src/components/ApiTokenSection';
import { AccountsSection } from '../src/components/AccountsSection';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { moduleFixture } from './fixtures';

autoCleanup();

const TOKEN = 'a'.repeat(64);

function tokenRoute(body: unknown): MockRoute[] {
  return [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/settings/api-token',
      respond: (): { body: unknown } => ({ body }),
    },
  ];
}

describe('Settings → API token section (*arr semantics)', (): void => {
  it('renders the token with regenerate when one exists (auth off = open deployment)', async (): Promise<void> => {
    const { fetch } = mockFetch(
      tokenRoute({ token: TOKEN, envManaged: false, mode: 'api-token' }),
    );
    renderWithProviders(<ApiTokenSection />, { fetch });
    const section = await screen.findByTestId('api-token-settings');
    expect(section).toBeInTheDocument();
    // Masked value + reveal/copy/regenerate affordances (await the DATA,
    // not the always-rendered section shell).
    expect(await screen.findByTestId('api-token-value')).toHaveTextContent('••••');
    expect(await screen.findByTestId('api-token-regenerate')).toBeInTheDocument();
    // Mode label: open deployment vocabulary, NOT 'API-only mode'.
    expect(screen.getByTestId('api-token-mode')).toHaveTextContent('open deployment — token for scripts');
    // The OLD gate copy must never render (it described the removed
    // 'generate only for authed deployments' policy).
    expect(screen.queryByText(/Auth is off/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/once a password is set/i)).not.toBeInTheDocument();
  });

  it('env-pinned deployments show "Managed via environment" and no regenerate', async (): Promise<void> => {
    const { fetch } = mockFetch(
      tokenRoute({ token: null, envManaged: true, mode: 'password+api-token' }),
    );
    renderWithProviders(<ApiTokenSection />, { fetch });
    expect(await screen.findByTestId('api-token-managed')).toHaveTextContent('Managed via environment');
    expect(screen.queryByTestId('api-token-regenerate')).not.toBeInTheDocument();
  });

  it('a null stored token (transient) renders neutral copy — still no auth-off gate', async (): Promise<void> => {
    const { fetch } = mockFetch(tokenRoute({ token: null, envManaged: false, mode: 'none' }));
    renderWithProviders(<ApiTokenSection />, { fetch });
    expect(await screen.findByText('No API token stored')).toBeInTheDocument();
    expect(screen.queryByText(/Auth is off/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/once a password is set/i)).not.toBeInTheDocument();
  });
});

describe('Settings → Accounts section (enabled-only listing)', (): void => {
  function accountsRoute(stored: Array<{ moduleId: string }>): MockRoute[] {
    return [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/accounts',
        respond: (): { body: unknown } => ({
          body: {
            accounts: stored.map((a): unknown => ({
              ...a,
              username: 'user',
              enabled: true,
              status: 'asValid',
            })),
            count: stored.length,
          },
        }),
      },
    ];
  }

  it('lists only ENABLED account-support sites — disabled sites never render, stored or not', async (): Promise<void> => {
    const { fetch } = mockFetch(
      accountsRoute([{ moduleId: 'd'.repeat(32) }, { moduleId: 'e'.repeat(32) }]),
    );
    renderWithProviders(
      <AccountsSection
        modules={[
          moduleFixture({ id: 'b'.repeat(32), name: 'EnabledSite', accountSupport: true, enabled: true }),
          // Account support but DISABLED → never listed (owner directive).
          moduleFixture({ id: 'd'.repeat(32), name: 'DisabledStoredSite', accountSupport: true, enabled: false }),
          // Disabled + no stored account → also never listed.
          moduleFixture({ id: 'f'.repeat(32), name: 'DisabledFreshSite', accountSupport: true, enabled: false }),
          // Enabled but NO account support → not the section's concern.
          moduleFixture({ id: '1'.repeat(32), name: 'NoAccountSite', accountSupport: false, enabled: true }),
        ]}
        onOpenCookies={(): void => undefined}
      />,
      { fetch },
    );
    const section = await screen.findByTestId('accounts-section');
    const cards = within(section).queryAllByTestId('account-card');
    // Use the aria-labels the cards carry.
    expect(within(section).getByLabelText('Account for EnabledSite')).toBeInTheDocument();
    expect(within(section).queryByLabelText('Account for DisabledStoredSite')).not.toBeInTheDocument();
    expect(within(section).queryByLabelText('Account for DisabledFreshSite')).not.toBeInTheDocument();
    expect(within(section).queryByLabelText('Account for NoAccountSite')).not.toBeInTheDocument();
    expect(cards.length + within(section).queryAllByLabelText(/^Account for /).length).toBeGreaterThanOrEqual(1);
    // Header count reflects the ENABLED-only set.
    expect(section).toHaveTextContent('1 enabled site with account support');
  });

  it('empty state names the enabled filter (not a registry-wide claim)', async (): Promise<void> => {
    const { fetch } = mockFetch(accountsRoute([]));
    renderWithProviders(
      <AccountsSection
        modules={[
          moduleFixture({ id: 'd'.repeat(32), name: 'OnlyDisabledSite', accountSupport: true, enabled: false }),
        ]}
        onOpenCookies={(): void => undefined}
      />,
      { fetch },
    );
    expect(await screen.findByText('No enabled account-supporting sites')).toBeInTheDocument();
  });
});
