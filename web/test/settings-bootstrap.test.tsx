// @vitest-environment jsdom
/**
 * Settings D20 first-run bootstrap empty state: an empty module
 * registry surfaces explicit guidance + a runnable sync action with
 * live progress/result (never a blank page).
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../src/pages/SettingsPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { MODULE_ID } from './fixtures';

autoCleanup();

describe('SettingsPage D20 bootstrap empty state', (): void => {
  it('guides and runs the module sync from the empty state', async (): Promise<void> => {
    const syncBodies: unknown[] = [];
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: object } => ({ body: { modules: [], count: 0 } }),
      },
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/sync/modules',
        respond: (_url, body): { body: object } => {
          syncBodies.push(body);
          return {
            body: {
              ok: true,
              summary: {
                treeSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                totalFiles: 4,
                registeredFiles: 4,
                failedFiles: 0,
                totalModules: 4,
                failures: [],
                knownBroken: {},
                eventCoverage: {},
              },
            },
          };
        },
      },
    ];
    const { fetch, requests } = mockFetch(routes);
    renderWithProviders(<SettingsPage />, { fetch });

    expect(await screen.findByText('No modules registered yet')).toBeInTheDocument();
    expect(screen.getByText(/auto-triggers module and catalog sync/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Run module sync now' }));
    expect(await screen.findByText(/Module sync finished: 4\/4 files registered/)).toBeInTheDocument();
    expect(requests.filter((r): boolean => r.path === '/api/sync/modules')).toHaveLength(1);
    expect(fetch).toBeDefined();
    void MODULE_ID;
  });

  it('shows sync progress label while the mutation is pending', async (): Promise<void> => {
    let releaseSync: (() => void) | undefined;
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        respond: (): { body: object } => ({ body: { modules: [], count: 0 } }),
      },
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/sync/modules',
        respond: (): Promise<{ body: object }> =>
          new Promise<{ body: object }>((resolve): void => {
            releaseSync = (): void =>
              resolve({
                body: {
                  ok: true,
                  summary: {
                    treeSha: '0000000000',
                    totalFiles: 0,
                    registeredFiles: 0,
                    failedFiles: 0,
                    totalModules: 0,
                    failures: [],
                    knownBroken: {},
                    eventCoverage: {},
                  },
                },
              });
          }),
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<SettingsPage />, { fetch });

    await screen.findByText('No modules registered yet');
    await userEvent.click(screen.getByRole('button', { name: 'Run module sync now' }));
    expect(await screen.findByText('Module sync running…')).toBeInTheDocument();
    releaseSync?.();
  });
});
