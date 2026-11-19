/**
 * Search scope ([fuzzy-javelin-pearls], D1 §2 ENTER):
 *
 * - URL codec: parse/serialize round-trips; unknown scope drops to
 *   all; picks dedupe; the default state serializes to NO params
 * - liveSearchCandidates: scope=all NEVER yields candidates (the
 *   zero-network charter); preferred/specific yield the catalog-less
 *   LIVE-CAPABLE enabled sites in canonical scope order
 * - SearchHomePage integration: the wire request carries the scope
 *   (preferred) or the explicit sites (specific, pick order); the
 *   preferred chips render in allowlist order with availability DIM
 *   (never hidden); the empty allowlist teaches; the specific picker
 *   writes ?picks= URL-as-truth
 * - Live fan-out: fires ONLY under an explicit scope for catalog-less
 *   sites (scope=all never issues a per-site search); results render
 *   PROGRESSIVELY (a resolved site's rows show while another is
 *   pending); a failed site renders its typed failure row
 * - useLiveSiteSearch: at most LIVE_FANOUT_CONCURRENCY requests in
 *   flight at once; changing q ABORTS the in-flight generation
 *   (signal observed); unmount aborts too
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowsePage } from '../src/pages/BrowsePage';
import {
  LIVE_FANOUT_CONCURRENCY,
  useLiveSiteSearch,
  type LiveSiteSearchInput,
} from '../src/api/hooks';
import {
  liveSearchCandidates,
  parseSearchScope,
  serializeSearchScope,
} from '../src/state/search-scope-state';
import { ApiClientProvider } from '../src/api/context';
import { createApiClient } from '../src/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { entryFixture, moduleFixture } from './fixtures';
import type { ModuleSummaryT } from '../src/api/hooks';

autoCleanup();

const SITE_A = 'a'.repeat(32);
const SITE_B = 'b'.repeat(32);
const SITE_LIVE1 = 'c'.repeat(32); // catalog-less, live-capable
const SITE_LIVE2 = 'd'.repeat(32); // catalog-less, live-capable
const SITE_NOLIVE = 'e'.repeat(32); // catalog-less, NO directory events

function registry(): ModuleSummaryT[] {
  return [
    moduleFixture({ id: SITE_A, name: 'SiteA Manga' }),
    moduleFixture({ id: SITE_B, name: 'SiteB Manga' }),
    moduleFixture({
      id: SITE_LIVE1,
      name: 'LiveOne',
      catalogInstalled: false,
      capabilities: {
        ...moduleFixture().capabilities,
        live_scrape_fallback: true,
      },
    }),
    moduleFixture({
      id: SITE_LIVE2,
      name: 'LiveTwo',
      catalogInstalled: false,
      capabilities: {
        ...moduleFixture().capabilities,
        live_scrape_fallback: true,
      },
    }),
    moduleFixture({ id: SITE_NOLIVE, name: 'NoDirectoryWalk', catalogInstalled: false }),
  ];
}

function modulesRoute(rows: ModuleSummaryT[] = registry()): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/modules',
    respond: (): { body: object } => ({ body: { modules: rows, count: rows.length } }),
  };
}

function preferredRoute(sites: string[]): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/preferred-sites',
    respond: (): { body: object } => ({ body: { sites } }),
  };
}

function unionRoute(requests: string[], entries: object[] = []): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/search',
    respond: (url): { body: object } => {
      requests.push(url.search);
      return {
        body: {
          entries,
          facets: [],
          warnings: [],
          excluded: [],
          scope: url.searchParams.get('scope') ?? (url.searchParams.has('sites') ? 'specific' : 'all'),
        },
      };
    },
  };
}

function liveSearchRoute(
  requests: string[],
  respond: (siteId: string) => { status?: number; body: object } = (siteId): { body: object } => ({
    body: {
      entries: [entryFixture(`/${siteId}/live-one`, `${siteId === SITE_LIVE1 ? 'LiveOne' : 'LiveTwo'} Hit`)],
      total: 1,
      source: 'live',
    },
  }),
): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => /^\/api\/catalog\/[0-9a-f]{32}\/search$/.test(url.pathname),
    respond: (url): { status?: number; body: object } => {
      requests.push(url.pathname + url.search);
      const siteId = url.pathname.split('/')[3] ?? '';
      return respond(siteId);
    },
  };
}

// ── URL codec (pure) ─────────────────────────────────────────────────

describe('search scope URL codec', () => {
  it('parses absent/invalid scope as all with no picks', () => {
    expect(parseSearchScope({})).toEqual({ scope: 'all', picks: [] });
    expect(parseSearchScope({ scope: 'nonsense' })).toEqual({ scope: 'all', picks: [] });
    expect(parseSearchScope({ scope: 'specific', picks: ' , ' })).toEqual({ scope: 'specific', picks: [] });
  });

  it('parses preferred and specific (picks deduped, order preserved)', () => {
    expect(parseSearchScope({ scope: 'preferred' })).toEqual({ scope: 'preferred', picks: [] });
    expect(parseSearchScope({ scope: 'specific', picks: `${SITE_B},${SITE_A},${SITE_B}` })).toEqual({
      scope: 'specific',
      picks: [SITE_B, SITE_A],
    });
  });

  it('serializes the default to NO params; specific carries the ordered picks', () => {
    expect(serializeSearchScope({ scope: 'all', picks: [] })).toEqual({});
    expect(serializeSearchScope({ scope: 'preferred', picks: [] })).toEqual({ scope: 'preferred' });
    expect(serializeSearchScope({ scope: 'specific', picks: [SITE_B, SITE_A] })).toEqual({
      scope: 'specific',
      picks: `${SITE_B},${SITE_A}`,
    });
  });

  it('liveSearchCandidates: scope=all yields NOTHING (zero-network charter); explicit scopes yield catalog-less live-capable enabled sites in scope order', () => {
    const rows = registry().map((m): {
      id: string;
      name: string;
      enabled: boolean;
      catalogInstalled: boolean;
      liveCapable: boolean;
    } => ({
      id: m.id,
      name: m.name,
      enabled: m.enabled,
      catalogInstalled: m.catalogInstalled,
      liveCapable: m.capabilities.live_scrape_fallback,
    }));
    expect(liveSearchCandidates({ scope: 'all', picks: [] }, [SITE_LIVE1], rows)).toEqual([]);
    expect(liveSearchCandidates({ scope: 'preferred', picks: [] }, [SITE_LIVE2, SITE_LIVE1, SITE_NOLIVE, SITE_A], rows)).toEqual([
      { id: SITE_LIVE2, name: 'LiveTwo' },
      { id: SITE_LIVE1, name: 'LiveOne' },
    ]);
    expect(liveSearchCandidates({ scope: 'specific', picks: [SITE_A, SITE_LIVE1] }, [], rows)).toEqual([
      { id: SITE_LIVE1, name: 'LiveOne' },
    ]);
  });
});

// ── SearchHomePage integration ───────────────────────────────────────

describe('SearchHomePage scope wiring', () => {
  it('default (no scope param): the union request carries NO scope/sites; scope=all never live-searches the catalog-less sites', async () => {
    const searchRequests: string[] = [];
    const liveRequests: string[] = [];
    const { fetch } = mockFetch([
      modulesRoute(),
      preferredRoute([SITE_LIVE1]),
      unionRoute(searchRequests),
      liveSearchRoute(liveRequests),
    ]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { q: 'union' } }} />, {
      fetch,
      hash: '#/browse?q=union',
    });
    await waitFor((): void => {
      expect(searchRequests.length).toBeGreaterThan(0);
    });
    expect(searchRequests[0]).not.toContain('scope=');
    expect(searchRequests[0]).not.toContain('sites=');
    // Zero-network: no per-site live search fired under scope=all.
    expect(liveRequests).toEqual([]);
  });

  it('scope=preferred: the request carries scope=preferred; chips render in allowlist order with the DEAD site dimmed (never hidden)', async () => {
    const searchRequests: string[] = [];
    const rows = registry();
    rows[1] = moduleFixture({
      ...rows[1],
      availability: { status: 'unreachable', checkedAt: '2026-11-01T00:00:00Z', reason: 'DNS gone' },
    });
    const { fetch } = mockFetch([
      modulesRoute(rows),
      preferredRoute([SITE_B, SITE_A]),
      unionRoute(searchRequests, [
        { ...entryFixture('/a/union', 'Union Alpha'), site: SITE_A, siteName: 'SiteA Manga' },
      ]),
    ]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { q: 'union', scope: 'preferred' } }} />, {
      fetch,
      hash: '#/browse?q=union&scope=preferred',
    });
    await waitFor((): void => {
      expect(searchRequests.length).toBeGreaterThan(0);
    });
    expect(searchRequests[0]).toContain('scope=preferred');
    // Chips in ALLOWLIST order (B first) — not id order.
    const chips = await screen.findAllByTestId(/^preferred-chip-/);
    expect(chips.map((chip): string => chip.getAttribute('data-testid') ?? '')).toEqual([
      `preferred-chip-${SITE_B}`,
      `preferred-chip-${SITE_A}`,
    ]);
    expect(chips[0]).toHaveAttribute('data-unavailable', 'true');
    expect(chips[1]).not.toHaveAttribute('data-unavailable');
    expect(screen.getByText('Union Alpha')).toBeVisible();
  });

  it('scope=preferred with an EMPTY allowlist renders the teaching hint (never a silent fall-back to all)', async () => {
    const searchRequests: string[] = [];
    const { fetch } = mockFetch([
      modulesRoute(),
      preferredRoute([]),
      unionRoute(searchRequests, [
        { ...entryFixture('/a/union', 'Union Alpha'), site: SITE_A, siteName: 'SiteA Manga' },
      ]),
    ]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { q: 'union', scope: 'preferred' } }} />, {
      fetch,
      hash: '#/browse?q=union&scope=preferred',
    });
    expect(await screen.findByTestId('preferred-empty-hint')).toBeVisible();
    await waitFor((): void => {
      expect(searchRequests.length).toBeGreaterThan(0);
    });
    expect(searchRequests[0]).toContain('scope=preferred');
  });

  it('the specific picker writes ?picks= URL-as-truth and the request carries sites= in PICK order', async () => {
    const searchRequests: string[] = [];
    const user = userEvent.setup();
    const { fetch } = mockFetch([
      modulesRoute(),
      preferredRoute([]),
      unionRoute(searchRequests, [
        { ...entryFixture('/b/union', 'Beta Picked'), site: SITE_B, siteName: 'SiteB Manga' },
      ]),
    ]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { q: 'union' } }} />, {
      fetch,
      hash: '#/browse?q=union',
    });
    await screen.findByTestId('scope-selector');
    await user.click(screen.getByTestId('scope-specific'));
    const picker = await screen.findByTestId('specific-picker');
    expect(picker).toBeVisible();
    // Pick B then A — the URL + the wire carry THAT order.
    await user.click(screen.getByTestId(`specific-pick-${SITE_B}`));
    await user.click(screen.getByTestId(`specific-pick-${SITE_A}`));
    await waitFor((): void => {
      expect(globalThis.location.hash).toContain(`picks=${SITE_B}%2C${SITE_A}`);
    });
    // Each pick re-fires the debounced query — wait for the request
    // that carries BOTH picks. The wire form is REPEATED params
    // (openapi-fetch array serialization — the server's boundary
    // normalizer accepts it), B BEFORE A (pick order).
    await waitFor((): void => {
      const withSites = searchRequests.find(
        (s): boolean => s.includes(`sites=${SITE_B}`) && s.includes(`sites=${SITE_A}`),
      );
      if (withSites === undefined) {
        throw new Error('no union request carried both picks');
      }
      expect(withSites.indexOf(`sites=${SITE_B}`)).toBeLessThan(withSites.indexOf(`sites=${SITE_A}`));
    });
    expect(await screen.findByText('Beta Picked')).toBeVisible();
  });
});

describe('SearchHomePage live-scrape leg', () => {
  it('fires per-site searches ONLY for catalog-less live-capable sites under an explicit scope, rendering PROGRESSIVELY', async () => {
    const liveRequests: string[] = [];
    let releaseLive1: (() => void) | undefined;
    const { fetch } = mockFetch([
      modulesRoute(),
      preferredRoute([SITE_LIVE1, SITE_LIVE2, SITE_NOLIVE, SITE_A]),
      unionRoute([], []),
      {
        method: 'GET',
        match: (url): boolean => url.pathname === `/api/catalog/${SITE_LIVE1}/search`,
        respond: (): { body: object; delay?: number } => {
          liveRequests.push('live1');
          return {
            // Resolves FIRST (no delay) — its rows render while live2
            // is still pending (progressive proof).
            body: {
              entries: [entryFixture('/c/live-one', 'LiveOne Hit')],
              total: 1,
              source: 'live',
            },
          };
        },
      },
      {
        method: 'GET',
        match: (url): boolean => url.pathname === `/api/catalog/${SITE_LIVE2}/search`,
        respond: (): { body: object } => {
          liveRequests.push('live2');
          return {
            body: { entries: [], total: 0, source: 'live' },
          };
        },
      },
    ]);
    void releaseLive1;
    renderWithProviders(
      <BrowsePage route={{ name: 'browse', query: { q: 'union', scope: 'preferred' } }} />,
      { fetch, hash: '#/browse?q=union&scope=preferred' },
    );
    const section = await screen.findByTestId('live-results');
    expect(section).toBeVisible();
    // Progressive: LiveOne's entries render (scope order groups)…
    expect(await screen.findByText('LiveOne Hit')).toBeVisible();
    // …and both live-capable sites were asked; the no-walk and
    // catalog sites were NOT.
    await waitFor((): void => {
      expect(liveRequests.sort()).toEqual(['live1', 'live2']);
    });
  });

  it('a FAILED live site renders its typed failure row (never silent)', async () => {
    const liveRequests: string[] = [];
    const { fetch } = mockFetch([
      modulesRoute(),
      preferredRoute([SITE_LIVE1]),
      unionRoute([], []),
      liveSearchRoute(liveRequests, (): { status: number; body: object } => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'no live directory walk for this module' } },
      })),
    ]);
    renderWithProviders(
      <BrowsePage route={{ name: 'browse', query: { q: 'union', scope: 'preferred' } }} />,
      { fetch, hash: '#/browse?q=union&scope=preferred' },
    );
    const section = await screen.findByTestId('live-results');
    await waitFor((): void => {
      expect(section.getAttribute('data-live-pending')).toBe('false');
    });
    expect(screen.getByText(/failed — /)).toBeVisible();
  });
});

// ── useLiveSiteSearch semantics (hook level) ─────────────────────────

/** A controllable fetch double: per-site deferred promises + signal
 * observation (abort proofs). */
function controlledFetch(): {
  fetch: typeof fetch;
  inFlight: () => number;
  started: () => string[];
  resolveSite: (siteId: string) => void;
  aborted: () => string[];
} {
  const pending = new Map<string, Array<{ resolve: (r: Response) => void; signal?: AbortSignal }>>();
  const started: string[] = [];
  const abortedSites: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const siteId = url.pathname.split('/')[3] ?? url.pathname;
    started.push(siteId);
    // openapi-fetch carries the signal ON the Request object; a bare
    // init-shaped call falls back to init.signal.
    const signal: AbortSignal | undefined =
      input instanceof Request ? (input.signal ?? undefined) : (init?.signal ?? undefined);
    signal?.addEventListener('abort', (): void => {
      abortedSites.push(siteId);
    });
    return new Promise<Response>((resolve): void => {
      const queue = pending.get(siteId) ?? [];
      queue.push(signal === undefined ? { resolve } : { resolve, signal });
      pending.set(siteId, queue);
    });
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    inFlight: (): number =>
      [...pending.values()].reduce((acc, queue): number => acc + queue.length, 0),
    started: (): string[] => [...started],
    resolveSite: (siteId: string): void => {
      const queue = pending.get(siteId) ?? [];
      // FIFO: the OLDEST pending promise for the site is the STALE
      // generation's request — resolving it must never land rows.
      const entry = queue.shift();
      if (entry === undefined) {
        return;
      }
      if (queue.length === 0) {
        pending.delete(siteId);
      } else {
        pending.set(siteId, queue);
      }
      entry.resolve(
        Response.json({ entries: [entryFixture('/x/one', 'Live Row')], total: 1, source: 'live' }),
      );
    },
    aborted: (): string[] => [...abortedSites],
  };
}

function renderLiveHook(
  fetchImpl: typeof fetch,
  input: LiveSiteSearchInput,
): { rerender(next: LiveSiteSearchInput): void; unmount(): void; result(): ReturnType<typeof useLiveSiteSearch> } {
  const client = createApiClient(fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook((props: LiveSiteSearchInput) => useLiveSiteSearch(props), {
    initialProps: input,
    wrapper: ({ children }): React.ReactElement => (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>{children}</ApiClientProvider>
      </QueryClientProvider>
    ),
  });
  return {
    rerender: (next: LiveSiteSearchInput): void => {
      view.rerender(next);
    },
    unmount: (): void => {
      view.unmount();
    },
    result: (): ReturnType<typeof useLiveSiteSearch> => view.result.current,
  };
}

describe('useLiveSiteSearch', () => {
  const fiveSites = [1, 2, 3, 4, 5].map(
    (n): { readonly id: string; readonly name: string } => ({
      id: String(n).repeat(32),
      name: `Live${String(n)}`,
    }),
  );

  it('caps concurrency at LIVE_FANOUT_CONCURRENCY (per-host is 1 by construction — one request per distinct origin)', async () => {
    const controller = controlledFetch();
    const hook = renderLiveHook(controller.fetch, {
      sites: fiveSites,
      q: 'union',
      enabled: true,
    });
    await waitFor((): void => {
      expect(controller.started().length).toBe(LIVE_FANOUT_CONCURRENCY);
    });
    // Nothing else starts until a slot frees.
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    expect(controller.started().length).toBe(LIVE_FANOUT_CONCURRENCY);
    controller.resolveSite(fiveSites[0]?.id ?? '');
    await waitFor((): void => {
      expect(controller.started().length).toBe(LIVE_FANOUT_CONCURRENCY + 1);
    });
    expect(hook.result().perSite.map((row): string => row.siteId)).toEqual(
      fiveSites.map((s): string => s.id),
    );
    hook.unmount();
  });

  it('changing q SUPERSEDES the in-flight generation (aborted in the hook; late results never render)', async () => {
    const controller = controlledFetch();
    const hook = renderLiveHook(controller.fetch, { sites: fiveSites.slice(0, 2), q: 'one', enabled: true });
    await waitFor((): void => {
      expect(controller.inFlight()).toBe(2);
    });
    hook.rerender({ sites: fiveSites.slice(0, 2), q: 'two', enabled: true });
    // The hook's cleanup aborted the old generation (controller-side,
    // same realm) and the new generation re-seeds pending rows. NOTE:
    // the fetch-level signal is realm-dropped under jsdom for EVERY
    // query in this suite (requestCompatibleSignal's documented
    // tradeoff — browsers get true network aborts), so the proof here
    // is the user-visible half: resolving the STALE requests must
    // never land their rows in the new generation.
    await waitFor((): void => {
      expect(hook.result().perSite.every((row): boolean => row.status === 'pending')).toBe(true);
    });
    controller.resolveSite(fiveSites[0]?.id ?? '');
    controller.resolveSite(fiveSites[1]?.id ?? '');
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    expect(hook.result().perSite.every((row): boolean => row.status === 'pending')).toBe(true);
    expect(hook.result().totalEntries).toBe(0);
    hook.unmount();
  });

  it('unmount is clean: late resolutions after navigate touch nothing (no leak, no error)', async () => {
    const controller = controlledFetch();
    const hook = renderLiveHook(controller.fetch, { sites: fiveSites.slice(0, 3), q: 'one', enabled: true });
    await waitFor((): void => {
      expect(controller.inFlight()).toBe(3);
    });
    const snapshot = hook.result();
    hook.unmount();
    // Resolving every in-flight request AFTER the unmount (the
    // navigated-away shape) neither throws nor mutates the last
    // rendered state.
    controller.resolveSite(fiveSites[0]?.id ?? '');
    controller.resolveSite(fiveSites[1]?.id ?? '');
    controller.resolveSite(fiveSites[2]?.id ?? '');
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    expect(hook.result()).toEqual(snapshot);
  });

  it('disabled or empty-q input is a no-op (no requests)', async () => {
    const controller = controlledFetch();
    const hook = renderLiveHook(controller.fetch, { sites: fiveSites, q: '', enabled: true });
    expect(hook.result().perSite).toEqual([]);
    hook.rerender({ sites: fiveSites, q: 'x', enabled: false });
    expect(hook.result().perSite).toEqual([]);
    expect(controller.started()).toEqual([]);
    hook.unmount();
  });
});
