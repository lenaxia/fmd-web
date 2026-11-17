/**
 * Test harness: provider-wrapped render + a request-recording mock
 * fetch (fully offline; no socket ever leaves the process — DESIGN.md
 * §13). Importing this module extends expect with jest-dom matchers.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobsActivityProvider } from '../src/state/jobs-activity';
import { ApiClientProvider } from '../src/api/context';
import type { ApiClient } from '../src/api/client';
import { createApiClient } from '../src/api/client';
import type { ReactElement } from 'react';
import { afterEach } from 'vitest';

// jsdom ships no ResizeObserver; Radix size-tracking components (e.g.
// Tabs via @radix-ui/react-use-size) need one when the page under test
// renders them. Minimal no-op stub (observe/unobserve/disconnect).
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom (this suite's environment) ships no matchMedia at all — the
// app's responsive signals (R3) would never settle. Unit tests
// exercise the DESKTOP surface by default: `(hover: hover)` matches
// (the HoverCard popover paths keep their pre-mobile semantics under
// test) and narrow/portrait queries do not. Touch-branch suites
// override per-suite via stubTouchMedia (the inverse).
class FakeMediaQueryList implements MediaQueryList {
  readonly media: string;
  readonly onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
  private readonly listeners = new Set<EventListener>();
  constructor(media: string, private readonly matchesNow: boolean) {
    this.media = media;
  }
  get matches(): boolean {
    return this.matchesNow;
  }
  addEventListener(_type: string, listener: EventListener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: EventListener): void {
    this.listeners.delete(listener);
  }
  addListener(listener: (ev: MediaQueryListEvent) => void): void {
    this.listeners.add(listener as EventListener);
  }
  removeListener(listener: (ev: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener as EventListener);
  }
  dispatchEvent(): boolean {
    return true;
  }
}

/** The desktop-answer table: hover-capable pointer, wide viewport. */
function desktopMatches(query: string): boolean {
  return query === '(hover: hover)';
}

if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = (query: string): MediaQueryList => new FakeMediaQueryList(query, desktopMatches(query));
}

const nativeMatchMedia: (query: string) => MediaQueryList = globalThis.matchMedia.bind(globalThis);
if (nativeMatchMedia('(hover: hover)').matches !== true) {
  // A native matchMedia exists but answers false to everything (bare
  // jsdom) — force the desktop answers through the same fake.
  globalThis.matchMedia = (query: string): MediaQueryList => new FakeMediaQueryList(query, desktopMatches(query));
}

/** Per-suite inverse stub: force the TOUCH (no-hover) narrow surface. */
export function stubTouchMedia(): void {
  globalThis.matchMedia = (query: string): MediaQueryList => {
    const matches =
      query === '(hover: none)' || query === '(max-width: 767px)'
        ? true
        : query === '(hover: hover)'
          ? false
          : desktopMatches(query);
    return new FakeMediaQueryList(query, matches);
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export type MockRouteResult = { status?: number; body: unknown };

export interface MockRoute {
  readonly method: string;
  /** Full-match predicate over the parsed URL (path + query). */
  readonly match: (url: URL) => boolean;
  readonly respond: (url: URL, body: unknown) => MockRouteResult | Promise<MockRouteResult>;
}

export function mockFetch(routes: readonly MockRoute[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlText = input instanceof Request ? input.url : String(input);
    const url = new URL(urlText);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown;
    const rawBody = init?.body;
    if (typeof rawBody === 'string') {
      body = JSON.parse(rawBody) as unknown;
    } else if (rawBody === undefined && input instanceof Request) {
      const text = await input.text();
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    }
    requests.push({ method, path: `${url.pathname}${url.search}`, body });
    const route = routes.find((r): boolean => r.method === method && r.match(url));
    if (route === undefined) {
      return Response.json(
        { error: { code: 'not_found', message: `no mock for ${method} ${url.pathname}` } },
        { status: 404 },
      );
    }
    const out = await route.respond(url, body);
    return Response.json(out.body, { status: out.status ?? 200 });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

export function renderWithProviders(
  ui: ReactElement,
  options?: { fetch?: typeof fetch; hash?: string },
): RenderResult & { client: ApiClient } {
  // Seed the live hash when given — useRoute subscribers parse
  // globalThis.location.hash on mount, so jsdom renders must start on
  // the URL under test (production always mounts on a real hash).
  // Auto-clearing happens in autoCleanup's afterEach (a bare '' here
  // would stomp a hash a suite's own helper seeded before render).
  if (options?.hash !== undefined) {
    globalThis.location.hash = options.hash;
  }
  const client = createApiClient(options?.fetch);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        {/* R5 arrival: the app shell mounts the jobs feed provider — jsdom
            renders get the SAME shell shape (DownloadsPage consumes it). */}
        <JobsActivityProvider>{ui}</JobsActivityProvider>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

export function autoCleanup(): void {
  afterEach((): void => {
    cleanup();
    // Deterministic URL state per test — later renders parse the hash
    // on mount, so earlier tests' navigations must not leak.
    globalThis.location.hash = '';
  });
}

/**
 * [parity-sweep] The canonical FULL /api/settings body every settings
 * test spreads (proxy/output/favorites/performance/retention/
 * filenamePolicy/diagnostics/browser) — the wire shape the
 * regenerated client types demand.
 */
export const FULL_SETTINGS = {
  proxy: { type: '', host: '', port: '', user: '', pass: '' },
  output: {
    format: 'zip',
    chapterNameTemplate: '',
    unicodeReplacement: false,
    unicodeReplacementChar: '_',
    digitPadding: 0,
    removeMangaName: false,
  },
  favorites: { intervalMinutes: 60, checkAtStartup: true },
  performance: { requestTimeoutSeconds: 15, retryCount: 2, parallelChapters: 1, threadsPerChapter: 1 },
  retention: { days: 30 },
  filenamePolicy: { normalizePaths: false },
  diagnostics: { logEnabled: true, logLevel: 'info' },
  browser: { enabled: false, url: '' },
} as const;
