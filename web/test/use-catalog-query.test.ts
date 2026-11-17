// @vitest-environment jsdom
/**
 * useCatalogQuery (tsk-savvy-jockey-ambles LLD): debounce timing
 * (250ms trailing — FMD2 TSearchDBThread coalescing adapted), the
 * in-flight abort on state change (FMD2 NewSearch parity — superseded
 * requests never land), and the realm-guarded AbortSignal pass-through
 * (jsdom's cross-realm signals must never reach openapi-fetch's
 * `new Request(url, { signal })` — the probe drops them so queries
 * issue).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { createElement } from 'react';
import { requestCompatibleSignal } from '../src/api/hooks';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue, useCatalogQuery } from '../src/state/use-catalog-query';
import { EMPTY_FILTERS } from '../src/state/browse-filter-state';
import { ApiClientProvider } from '../src/api/context';
import { createApiClient } from '../src/api/client';
import type { CatalogPageT } from '../src/api/hooks';

const page = (titles: readonly string[]): CatalogPageT => ({
  entries: titles.map((title, i) => ({
    link: `/${i}`,
    title,
    alttitles: '',
    authors: '',
    artists: '',
    genres: '',
    status: '',
    summary: '',
    numChapter: 1,
    jdn: i,
  })),
  total: titles.length,
  source: 'catalog',
});

describe('useDebouncedValue', (): void => {
  it('emits stable values only after the 250ms window (TSearchDBThread coalescing)', (): void => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ value }: { value: string }) => useDebouncedValue(value, SEARCH_DEBOUNCE_MS),
        { initialProps: { value: 'a' } },
      );
      expect(result.current).toBe('a'); // initial value emits immediately

      // Rapid keystrokes coalesce: intermediate values never emit.
      rerender({ value: 'al' });
      act((): void => {
        vi.advanceTimersByTime(200);
      });
      rerender({ value: 'alp' });
      act((): void => {
        vi.advanceTimersByTime(200);
      });
      rerender({ value: 'alph' });
      expect(result.current).toBe('a');

      act((): void => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      expect(result.current).toBe('alph');
    } finally {
      vi.useRealTimers();
    }
  });

  it('one debounce window → exactly one emission for the latest value', (): void => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ value }: { value: string }) => useDebouncedValue(value, SEARCH_DEBOUNCE_MS),
        { initialProps: { value: '' } },
      );
      for (const value of ['n', 'na', 'nar', 'naru', 'narut', 'naruto']) {
        rerender({ value });
        act((): void => {
          vi.advanceTimersByTime(100);
        });
      }
      expect(result.current).toBe('');
      act((): void => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      expect(result.current).toBe('naruto');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('requestCompatibleSignal (realm guard)', (): void => {
  it('drops every cross-realm signal (the real undici Request rejects them all)', (): void => {
    // In the jsdom env, Request is undici's while AbortController is
    // jsdom's — EVERY test-reachable signal fails its realm check (even
    // a Request-minted one fails the round-trip), so the guard drops
    // all of them and openapi-fetch's Request construction never sees
    // a signal: queries issue.
    expect(requestCompatibleSignal(new AbortController().signal)).toBeUndefined();
    expect(requestCompatibleSignal(new Request('about:blank').signal)).toBeUndefined();
    expect(requestCompatibleSignal(undefined)).toBeUndefined();
  });

  it('passes a compatible signal through untouched (single-realm Request)', (): void => {
    // A lenient stand-in for a browser's same-realm Request: accepts
    // every signal → the probe passes the ORIGINAL signal through.
    class LenientRequest {
      constructor(_url: unknown, _init?: unknown) {
        /* realm-compatible by construction */
      }
    }
    vi.stubGlobal('Request', LenientRequest);
    try {
      const signal: AbortSignal = new AbortController().signal;
      expect(requestCompatibleSignal(signal)).toBe(signal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function makeWrapper(fetchImpl: typeof fetch): {
  wrapper: ({ children }: { children: ReactNode }) => ReactElement;
  queryClient: QueryClient;
} {
  const client = createApiClient(fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactElement =>
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(ApiClientProvider, { client, children }),
    });
  return { wrapper, queryClient };
}

describe('useCatalogQuery: in-flight abort on state change', (): void => {
  it('jsdom (cross-realm) never sees the signal — queries ISSUE (the guard)', async (): Promise<void> => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input;
      seenSignals.push(init?.signal as AbortSignal | undefined);
      return Response.json(page(['Wired']));
    }) as typeof fetch;
    const { wrapper } = makeWrapper(fetchFn);

    const { result } = renderHook(
      ({ q }: { q: string }) => useCatalogQuery('c'.repeat(32), { ...EMPTY_FILTERS, q }, { view: 'latest', enabled: true }),
      { wrapper, initialProps: { q: 'a' } },
    );
    await waitFor((): void => {
      expect(result.current.pages.data?.pages[0]?.entries[0]?.title).toBe('Wired');
    });
    // The guard dropped the cross-realm signal BEFORE Request construction.
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBeUndefined();
  });

  it('a superseded in-flight fetch never lands; the latest state wins and the guard cancels', async (): Promise<void> => {
    const bodies = new Map<string, CatalogPageT>([
      ['a', page(['Result A'])],
      ['ab', page(['Result AB'])],
    ]);
    const parked = new Map<string, (value: unknown) => void>();
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const q: string = url.searchParams.get('q') ?? '';
      void init;
      if (q === 'a') {
        // Park the superseded request until the test releases it.
        await new Promise((resolve): void => {
          parked.set('a', resolve);
        });
      } else {
        await new Promise((resolve): void => {
          setTimeout(resolve, 10);
        });
      }
      return Response.json(bodies.get(q) ?? page([q]));
    }) as typeof fetch;
    const { wrapper, queryClient } = makeWrapper(fetchFn);
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useCatalogQuery('c'.repeat(32), { ...EMPTY_FILTERS, q }, { view: 'latest', enabled: true }),
      { wrapper, initialProps: { q: 'a' } },
    );

    // State change (a → ab): the guard cancels the site's in-flight
    // queries immediately (FMD2 NewSearch parity)…
    rerender({ q: 'ab' });
    await waitFor((): void => {
      expect(cancelSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // mount + change
    });

    // …the latest state fetches and lands…
    await waitFor((): void => {
      expect(result.current.pages.data?.pages[0]?.entries[0]?.title).toBe('Result AB');
    });

    // …and the parked superseded response is a NO-OP when it finally
    // resolves (cancelled queries never deliver).
    (parked.get('a') as (value: unknown) => void)(undefined);
    await new Promise((resolve): void => {
      setTimeout(resolve, 30);
    });
    expect(result.current.pages.data?.pages[0]?.entries[0]?.title).toBe('Result AB');
  });

  it('resolves search mode whenever any filter is active (q optional)', (): void => {
    const { wrapper } = makeWrapper((async (): Promise<Response> => Response.json(page([]))) as typeof fetch);
    const { result, rerender } = renderHook(
      ({ state }: { state: typeof EMPTY_FILTERS }) =>
        useCatalogQuery('c'.repeat(32), state, { view: 'latest', enabled: false }),
      { wrapper, initialProps: { state: EMPTY_FILTERS } },
    );
    expect(result.current.mode).toBe('latest');
    rerender({ state: { ...EMPTY_FILTERS, genres: ['Action'] } });
    expect(result.current.mode).toBe('search');
    rerender({ state: { ...EMPTY_FILTERS, q: 'x' } });
    expect(result.current.mode).toBe('search');
  });
});
