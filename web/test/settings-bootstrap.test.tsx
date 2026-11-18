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
import { autoCleanup, FULL_SETTINGS, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { MODULE_ID, moduleFixture } from './fixtures';

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

  it('surfaces tolerated upstream-broken files (failures[]) from the sync summary', async (): Promise<void> => {
    const routes: MockRoute[] = [
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/modules',
        // A populated registry: the sync status block renders in the
        // main Settings view, where failures[] is listed in full.
        respond: (): { body: object } => ({
          body: {
            modules: [moduleFixture({ id: MODULE_ID, name: 'KLManga' })],
            count: 1,
          },
        }),
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === '/api/settings',
        respond: (): { body: object } => ({
          body: { ...FULL_SETTINGS },
        }),
      },
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/sync/modules',
        respond: (): { body: object } => ({
          body: {
            ok: true,
            summary: {
              treeSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
              totalFiles: 417,
              registeredFiles: 412,
              failedFiles: 5,
              totalModules: 454,
              failures: [
                { file: 'modules/JapScan.lua', error: 'luaL_loadbufferx(modules/JapScan.lua) failed: 3' },
                { file: 'modules/dm5.lua', error: 'luaL_loadbufferx(modules/dm5.lua) failed: 3' },
              ],
              knownBroken: {},
              eventCoverage: {},
            },
          },
        }),
      },
    ];
    const { fetch } = mockFetch(routes);
    renderWithProviders(<SettingsPage />, { fetch });

    await userEvent.click(await screen.findByRole('button', { name: 'Sync modules' }));
    // [UX-AUDIT T-6] one-line status + collapsed technical detail (the
    // tree-SHA/file-count wall lives inside <details> now).
    expect(await screen.findByText('Module sync complete: 454 modules.')).toBeInTheDocument();
    expect(screen.getByText(/412\/417 files registered, 5 failed/)).toBeInTheDocument();
    // the tolerated failures list, in full, in the Settings surface
    expect(await screen.findByText(/2 upstream-broken file\(s\) tolerated/)).toBeInTheDocument();
    const list = screen.getByLabelText('Tolerated broken module files');
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list.textContent).toContain('modules/JapScan.lua');
    expect(list.textContent).toContain('luaL_loadbufferx(modules/dm5.lua) failed: 3');
    expect(fetch).toBeDefined();
  });
});
