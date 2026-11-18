/**
 * CONTRACT SEAM test — the gap that shipped the v0.3.1 /api/info bug:
 * the web e2e suite serves MOCKED routes, so the client posting a raw
 * FMD2-DB catalog row (host-relative `link`, §5.8
 * RemoveHostFromURLsPair) against a server whose schema demanded
 * absolute http(s) urls NEVER met each other until a user did.
 *
 * This test closes that seam: the REAL production server (the actual
 * `buildApp` route chain — zod boundary, MaybeFillHost join, info
 * cache) listens on loopback, a REAL catalog row is read through the
 * API, and the REAL generated client (`createApiClient` — the same
 * openapi-fetch surface `useLiveInfo` calls) posts it with NO mocked
 * route in between. If client payload shape and server acceptance
 * drift apart again, THIS fails while the mocked e2e stays green.
 *
 * The server side is loaded through a RUNTIME-RESOLVED specifier on
 * purpose: the server module graph is built for NodeNext + @types/node
 * while the web package compiles under Bundler + DOM lib — a static
 * import would drag the server tree into the web tsconfig project.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';

/** Structural slice of the server test harness (runtime-loaded). */
interface ServerHarness {
  readonly app: {
    inject: (opts: { method: string; url: string; payload?: unknown }) => Promise<{ statusCode: number; body: string }>;
    listen: (opts: { port: number; host: string }) => Promise<void>;
    close: () => Promise<void>;
    readonly server: { address: () => { port: number } | null };
  };
  readonly info: { readonly calls: ReadonlyArray<{ moduleId: string; url: string }> };
  readonly catalogs: { install: (id: string, entries: unknown[]) => void };
}

// AlphaSource ('a'×32): registered with rootURL https://example.org AND
// known to the harness fake info service — its catalog is installed
// below with HOST-RELATIVE links, exactly as FMD2-DB serves them.
const MODULE_ID = 'a'.repeat(32);
const MODULE_ROOT = 'https://example.org'; // the harness registration's default rootURL

let h: ServerHarness;
let client: ApiClient;

/** Fresh client whose fetch targets the LIVE test server (real loopback HTTP). */
function clientFor(port: number): ApiClient {
  const origin = `http://127.0.0.1:${String(port)}`;
  const retarget = (url: string): string => url.replace('http://localhost', origin);
  return createApiClient((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // The node client defaults its baseUrl to 'http://localhost' (no
    // browser origin exists) — retarget it at the listening app. The
    // fetch itself is the REAL network stack: no route mocks between
    // the client and the server. openapi-fetch hands a Request object
    // (not a string) — rebuild it against the loopback origin.
    if (input instanceof Request) {
      return globalThis.fetch(new Request(retarget(input.url), input)) as Promise<Response>;
    }
    return globalThis.fetch(retarget(String(input)), init) as Promise<Response>;
  });
}

beforeAll(async (): Promise<void> => {
  const spec = new URL('../../server/test/api/helpers.js', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ spec)) as { buildHarness: () => ServerHarness };
  h = mod.buildHarness();
  // The AlphaSource catalog exactly as FMD2-DB serves it: HOST-RELATIVE links.
  h.catalogs.install(MODULE_ID, [
    {
      link: '/title/116496-en-null',
      title: 'One Piece',
      alttitles: '',
      authors: 'A',
      artists: '',
      genres: 'Action',
      status: 'Ongoing',
      summary: 'row straight from the installed catalog',
      numChapter: 3,
      jdn: 45000,
    },
  ]);
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = h.app.server.address();
  expect(addr, 'loopback listener bound').not.toBeNull();
  client = clientFor(addr?.port ?? 0);
});

afterAll(async (): Promise<void> => {
  await h.app.close();
});

describe('CONTRACT /api/info — real server, real client, real catalog row', (): void => {
  it('a host-relative catalog row posted by the generated client is joined server-side (200, canonical url)', async (): Promise<void> => {
    // 1. Read the row through the API (real route, real store double).
    const page = await client.GET('/api/catalog/{id}/latest', {
      params: { path: { id: MODULE_ID } },
    });
    expect(page.response.status).toBe(200);
    const row = (page.data as { entries: Array<{ link: string; title: string }> }).entries[0];
    expect(row?.link).toBe('/title/116496-en-null'); // host-relative, as shipped
    expect(row?.title).toBe('One Piece');

    // 2. The client posts it RAW — exactly the useLiveInfo call shape.
    const res = await client.POST('/api/info', {
      body: { moduleId: MODULE_ID, url: row?.link ?? '' },
    });
    expect(res.response.status).toBe(200); // NEVER a 400 url-shape rejection
    const info = res.data as { moduleId: string; url: string };
    expect(info.moduleId).toBe(MODULE_ID);
    expect(info.url).toBe(`${MODULE_ROOT}/title/116496-en-null`); // MaybeFillHost join
    // The engine saw the canonical absolute url, not the raw row link.
    expect(h.info.calls).toEqual([{ moduleId: MODULE_ID, url: `${MODULE_ROOT}/title/116496-en-null` }]);

    // 3. Cache-key convergence: the absolute equivalent is ONE snapshot.
    const again = await client.POST('/api/info', {
      body: { moduleId: MODULE_ID, url: `${MODULE_ROOT}/title/116496-en-null` },
    });
    expect(again.response.status).toBe(200);
    expect(again.data).toEqual(res.data);
    expect(h.info.calls).toHaveLength(1);
  });
});
