/**
 * Test harness: provider-wrapped render + a request-recording mock
 * fetch (fully offline; no socket ever leaves the process — DESIGN.md
 * §13). Importing this module extends expect with jest-dom matchers.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider } from '../src/api/context';
import type { ApiClient } from '../src/api/client';
import { createApiClient } from '../src/api/client';
import type { ReactElement } from 'react';
import { afterEach } from 'vitest';

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
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
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
