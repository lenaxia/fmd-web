// @vitest-environment jsdom

/**
 * BrowsePage site-first flow (FMD2 DBUpdaterThread parity, offline):
 * ?site= (with ?catalog= as legacy alias) drives the unified browsing
 * model — POST /api/sync/catalog/:id + WS `sync` frames reduce the
 * progress machine; a finished provision flips catalogInstalled (live
 * join) and the entries view opens; the FMD2-DB 404 outcome on a
 * directory-capable site AUTOMATICALLY falls through to the live
 * channel (one progress experience, no decision point — the muted
 * 'from site' badge is the only trace) while a non-capable site gets
 * the friendly no-list panel; cancel aborts the progress UX;
 * known-broken sites stay closed with their reason; hex ids are never
 * rendered; NO mode vocabulary ('live browse'/'scrape') anywhere.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModuleSummaryT } from '../src/api/hooks';
import { moduleFixture, entryFixture } from './fixtures';
import { renderWithProviders, autoCleanup, mockFetch, type MockRoute } from './helpers';
import { BrowsePage } from '../src/pages/BrowsePage';
import type { Route } from '../src/router';

const SITE_ID = '7'.repeat(32);

/** Recording socket double; opens asynchronously like a real socket. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    // Async open (handlers are bound right after construction).
    setTimeout((): void => {
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function wsFrame(id: string, phase: string, outcome?: string): unknown {
  return {
    type: 'sync',
    id,
    sync: {
      jobId: `catalog-sync:${SITE_ID}`,
      moduleId: SITE_ID,
      phase,
      ...(outcome !== undefined ? { outcome } : {}),
    },
  };
}

interface Harness {
  readonly routes: readonly MockRoute[];
  installed(): boolean;
  syncCalls(): number;
  entryCalls(): number;
  /** Resolve a held sync POST (deferred mode). */
  settleSync(result: unknown): void;
}

function makeRoutes(
  module: ModuleSummaryT,
  opts?: { readonly hangPost?: boolean; readonly deferPost?: boolean; readonly latestSource?: 'catalog' | 'live' },
): Harness {
  let installed = module.catalogInstalled;
  let syncCalls = 0;
  let entryCalls = 0;
  let settle: ((result: unknown) => void) | undefined;
  const routes: MockRoute[] = [
    {
      method: 'GET',
      match: (url): boolean => url.pathname === '/api/modules',
      respond: (): { body: unknown } => ({
        body: { modules: [{ ...module, catalogInstalled: installed }], count: 1 },
      }),
    },
    {
      method: 'POST',
      match: (url): boolean => url.pathname === `/api/sync/catalog/${SITE_ID}`,
      respond: (): Promise<{ body: unknown }> | { body: unknown } => {
        syncCalls += 1;
        if (opts?.hangPost === true) {
          return new Promise((): void => {});
        }
        if (opts?.deferPost === true) {
          return new Promise<{ body: unknown }>((resolve): void => {
            settle = (result: unknown): void => {
              if ((result as { state?: string }).state === 'updated') {
                installed = true;
              }
              resolve({ body: { ok: true, result } });
            };
          });
        }
        return { body: { ok: true, result: { id: SITE_ID, state: 'updated', dbSha: 'ab', bytes: 2 } } };
      },
    },
    {
      method: 'GET',
      match: (url): boolean => url.pathname === `/api/catalog/${SITE_ID}/latest`,
      respond: (): { body: unknown } => {
        entryCalls += 1;
        return {
          body: {
            entries: [entryFixture('/manga/alpha', 'Alpha Quest')],
            total: 1,
            source: opts?.latestSource ?? 'catalog',
          },
        };
      },
    },
  ];
  return {
    routes,
    installed: (): boolean => installed,
    syncCalls: (): number => syncCalls,
    entryCalls: (): number => entryCalls,
    settleSync: (result: unknown): void => {
      settle?.(result);
    },
  };
}

// Builds the route AND seeds the live hash — useRoute parses the hash
// on mount, so jsdom renders must start on the URL under test.
const route = (query: Record<string, string>): Route => {
  globalThis.location.hash = `#/browse?${new URLSearchParams(query).toString()}`;
  return { name: 'browse', query };
};

describe('BrowsePage site-first flow', (): void => {
  autoCleanup();

  afterEach((): void => {
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it('catalog-less site auto-provisions (POST + WS progress) and opens entries on completion', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fresh = moduleFixture({ id: SITE_ID, name: 'FreshSite', catalogInstalled: false });
    const h = makeRoutes(fresh, { deferPost: true });
    renderWithProviders(<BrowsePage route={route({ site: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    // Provisioning started: inline status + the sync POST fired once
    // (held until the WS phases are observed — deterministic).
    expect(await screen.findByTestId('provision-status')).toBeVisible();
    expect(h.syncCalls()).toBe(1);
    // No doomed entries fetch fired while the site was unresolved/
    // unprovisioned.
    expect(h.entryCalls()).toBe(0);

    // WS frames stream the phases (the toast machine is WS-driven).
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket?.push(wsFrame('1', 'checking'));
    socket?.push(wsFrame('2', 'downloading'));

    // Completion (WS terminal + REST confirm) → catalogInstalled flips
    // on the modules refetch → the entries view opens.
    socket?.push(wsFrame('3', 'done', 'updated'));
    h.settleSync({ id: SITE_ID, state: 'updated', dbSha: 'ab', bytes: 2 });
    expect(await screen.findByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
    expect(h.installed()).toBe(true);
    expect(h.entryCalls()).toBe(1);
    // The site NAME is the header identity — never the hex id.
    expect(screen.getByText('FreshSite')).toBeVisible();
    expect(screen.queryByText(/[0-9a-f]{32}/)).toBeNull();
  });

  it('cancel stops the provisioning UX (cancelled panel, no entries fetch)', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fresh = moduleFixture({ id: SITE_ID, name: 'FreshSite', catalogInstalled: false });
    // The POST never settles — only the user cancel ends the UX.
    const h = makeRoutes(fresh, { hangPost: true });
    renderWithProviders(<BrowsePage route={route({ site: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    expect(await screen.findByTestId('provision-status')).toBeVisible();
    FakeWebSocket.instances[0]?.push(wsFrame('1', 'downloading'));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled')).toBeVisible();
    expect(screen.queryByTestId('provision-status')).toBeNull();
    expect(h.entryCalls()).toBe(0);
  });

  it('FMD2-DB 404 on a directory-capable site → AUTOMATIC live fallback: entries open, one progress experience', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const liveCapable = moduleFixture({
      id: SITE_ID,
      name: 'LiveSite',
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
    const h = makeRoutes(liveCapable, { deferPost: true, latestSource: 'live' });
    renderWithProviders(<BrowsePage route={route({ site: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    // ONE progress experience: the preparing status, then the list.
    expect(await screen.findByTestId('provision-status')).toBeVisible();
    expect(screen.getByText(/Preparing LiveSite…/)).toBeVisible();
    h.settleSync({
      id: SITE_ID,
      state: 'failed',
      error: 'no-catalog: FMD2-DB has no catalog archive for this site (HTTP 404)',
    });

    // No decision point — the entries open automatically via the live
    // channel, and the muted source badge is the only trace.
    expect(await screen.findByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
    expect(h.entryCalls()).toBe(1);
    expect(screen.getByTitle('List fetched live from the site')).toHaveTextContent('from site');

    // THE MODE-VOCABULARY CONTRACT: no 'live browse'/'scrape' strings
    // and no mode-named buttons anywhere in the DOM.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/live[ -]browse/i);
    expect(text).not.toMatch(/scrape/i);
    expect(screen.queryByRole('button', { name: /live/i })).toBeNull();
  });

  it('FMD2-DB 404 on a site WITHOUT directory capability → friendly no-list panel, nothing opens', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const plain = moduleFixture({ id: SITE_ID, name: 'PlainSite', catalogInstalled: false });
    const h = makeRoutes(plain, { deferPost: true });
    renderWithProviders(<BrowsePage route={route({ site: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    expect(await screen.findByTestId('provision-status')).toBeVisible();
    h.settleSync({
      id: SITE_ID,
      state: 'failed',
      error: 'no-catalog: FMD2-DB has no catalog archive for this site (HTTP 404)',
    });

    expect(await screen.findByText('No list available for this site')).toBeVisible();
    expect(screen.getByText(/titles cannot be fetched from the site directly/i)).toBeVisible();
    expect(h.entryCalls()).toBe(0);
    // No mode-named buttons anywhere.
    expect(screen.queryByRole('button', { name: /live/i })).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/live[ -]browse/i);
    expect(text).not.toMatch(/scrape/i);
  });

  it('transient failure → retry affordance re-fires the sync POST', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fresh = moduleFixture({ id: SITE_ID, name: 'FreshSite', catalogInstalled: false });
    const h = makeRoutes(fresh, { deferPost: true });
    renderWithProviders(<BrowsePage route={route({ site: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    expect(await screen.findByTestId('provision-status')).toBeVisible();
    h.settleSync({ id: SITE_ID, state: 'failed', error: 'ETIMEDOUT' });
    expect(await screen.findByText('Couldn’t open this site')).toBeVisible();
    expect(h.syncCalls()).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.syncCalls()).toBe(2);
    h.settleSync({ id: SITE_ID, state: 'failed', error: 'ETIMEDOUT' });
    expect(await screen.findByText('Couldn’t open this site')).toBeVisible();
  });

  it('known-broken site: disabled open with reason, no provisioning', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const broken = moduleFixture({
      id: SITE_ID,
      name: 'BrokenSite',
      catalogInstalled: false,
      capabilities: {
        requires_subprocess: false,
        requires_browser: false,
        bypass_python_gated: false,
        requires_imagepuzzle: false,
        requires_mangafoxwatermark: false,
        events: [],
        known_broken_flags: ['madara.run_html_load'],
        live_scrape_fallback: false,
      },
    });
    const h = makeRoutes(broken);
    renderWithProviders(<BrowsePage route={route({ site: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    expect(await screen.findByText('This site is unavailable')).toBeVisible();
    expect(screen.getAllByText(/known broken upstream/i).length).toBeGreaterThan(0);
    expect(h.syncCalls()).toBe(0);
    expect(h.entryCalls()).toBe(0);
  });

  it('?catalog= stays as a legacy alias of ?site=', async (): Promise<void> => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const installedModule = moduleFixture({ id: SITE_ID, name: 'LegacySite', catalogInstalled: true });
    const h = makeRoutes(installedModule);
    renderWithProviders(<BrowsePage route={route({ catalog: SITE_ID })} />, {
      fetch: mockFetch(h.routes).fetch,
    });

    expect(await screen.findByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
    expect(screen.getByText('LegacySite')).toBeVisible();
    // Installed: no provisioning fired.
    expect(h.syncCalls()).toBe(0);
  });
});
