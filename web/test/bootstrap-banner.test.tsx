// @vitest-environment jsdom
/**
 * App-shell D20 bootstrap banner: polls /readyz and surfaces the
 * server's stage (`reason`) while bootstrap runs, then disappears when
 * the server reports ready. The compose e2e asserts the same two
 * transitions in the browser.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../src/App';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';

autoCleanup();

describe('App bootstrap banner (D20 progress)', (): void => {
  it('surfaces the bootstrap stage while /readyz answers 503, then hides on ready', async (): Promise<void> => {
    let calls = 0;
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/readyz',
        respond: (): { status: number; body: object } => {
          calls += 1;
          return calls === 1
            ? { status: 503, body: { ready: false, reason: 'bootstrap: modules…' } }
            : { status: 200, body: { ready: true } };
        },
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<App />, { fetch });

    const banner = await screen.findByTestId('bootstrap-status');
    expect(banner).toHaveTextContent('First-run bootstrap running (D20)');
    // The stage (server `reason`) replaces the connecting state once the
    // first /readyz poll answers 503.
    await screen.findByText(/bootstrap: modules…/);

    // Next poll reports ready → the banner disappears.
    expect(await screen.findByText('FMD Web')).toBeInTheDocument();
    // The shell rendered — the NAV tabs. R3 responsive shell: BOTH
    // surfaces carry the same Browse destination (top tabs >=768px,
    // the BottomTabNav twin below — CSS picks per viewport; jsdom
    // renders both, the e2e shell spec asserts the switch).
    const browseLinks = await screen.findAllByRole('link', { name: 'Browse' });
    expect(browseLinks.length).toBeGreaterThanOrEqual(2);
    expect(
      await (async (): Promise<boolean> => {
        // The next 1s poll reports ready → the banner unmounts.
        for (let i = 0; i < 200; i += 1) {
          if (document.querySelector('[data-testid="bootstrap-status"]') === null) {
            return true;
          }
          await new Promise<void>((resolve): void => {
            setTimeout(resolve, 20);
          });
        }
        return false;
      })(),
    ).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    void fetch;
  });

  it('keeps a connecting state while the server is unreachable (bootstrap early)', async (): Promise<void> => {
    const { fetch } = mockFetch([
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/readyz',
        respond: (): Promise<{ status: number; body: object }> =>
          Promise.reject(new TypeError('fetch failed')),
      },
    ]);
    renderWithProviders(<App />, { fetch });

    const banner = await screen.findByTestId('bootstrap-status');
    expect(banner).toHaveTextContent('connecting to the server…');
  });
});
