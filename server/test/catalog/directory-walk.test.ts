/**
 * §6.8 directory walk — offline engine test: the REAL Hentai2Read
 * module file (OnGetDirectoryPageNumber + OnGetNameAndLink, JSON-app
 * directory shape) driven through the wasmoon host with recorded
 * directory pages (NO network). Proves the walk algorithm and the
 * §5.8 normalization of scraped links end-to-end, plus the typed
 * failure paths (never a partial page).
 */
import { describe, expect, it } from 'vitest';
import { CatalogFallbackError } from '@fmd/contract';
import { EngineDirectoryWalker, MAX_DIRECTORY_PAGES } from '../../src/catalog/directory-walk.js';
import { RecordedHttpTransport } from '../../src/engine/shims/http-transport.js';
import { RecordedResponseResolver, type ResolvedRecordedResponse } from '../../src/engine/shims/http-shim.js';
import { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import { SyncHostGate, type HostGatePort } from '../../src/engine/shims/http-hostgate.js';
import { makeRegistration } from '../api/helpers.js';
import type { ModuleCapabilities, RegistrationRecord } from '../../src/engine/registry/capabilities.js';

const HENTAI2READ_ID = '053da85062184626a0a1ff6d57c3c955';
const PAGE_1 = 'https://hentai2read.com/browse/newest/page-1';
const PAGE_2 = 'https://hentai2read.com/browse/newest/page-2';

/** Recorded directory page: the real `script[data-page="app"]` JSON-app
 * shape Hentai2Read's directory events parse (books.lastPage/books.data). */
function directoryPage(lastPage: number, books: ReadonlyArray<{ url: string; title: string }>): string {
  const app = { props: { books: { lastPage, data: books } } };
  return [
    '<!DOCTYPE html>',
    '<html><head>',
    `<script data-page="app">${JSON.stringify(app)}</script>`,
    '</head><body></body></html>',
    '',
  ].join('\n');
}

/** §6.8-capable capability fixture (declares BOTH directory events). */
function directoryCapable(): ModuleCapabilities {
  return {
    requires_subprocess: false,
    requires_browser: false,
    bypass_python_gated: false,
    requires_imagepuzzle: false,
    requires_mangafoxwatermark: false,
    events: ['OnGetDirectoryPageNumber', 'OnGetNameAndLink', 'OnGetInfo', 'OnGetPageNumber'],
    known_broken_flags: [],
    live_scrape_fallback: true,
  };
}

function plainCapabilities(): ModuleCapabilities {
  return {
    requires_subprocess: false,
    requires_browser: false,
    bypass_python_gated: false,
    requires_imagepuzzle: false,
    requires_mangafoxwatermark: false,
    events: ['OnGetInfo'],
    known_broken_flags: [],
    live_scrape_fallback: false,
  };
}

interface RecordedSite {
  readonly resolver: RecordedResponseResolver;
  readonly transport: RecordedHttpTransport;
}

function recordPages(pages: Array<{ url: string; body: string }>): RecordedSite {
  const resolver = new RecordedResponseResolver(
    pages.map((page) => ({ url: page.url, status: 200, mimeType: 'text/html; charset=utf-8', body: page.body })),
  );
  const transport = new RecordedHttpTransport((method, url, body, mimeType, headers): ResolvedRecordedResponse =>
    resolver.resolve(method, url, body, mimeType, headers),
  );
  return { resolver, transport };
}

/** Counting decorator over the real gate — proves the walk wires the
 * per-host limiter and never exceeds its bound. */
class CountingGate implements HostGatePort {
  acquisitions = 0;
  activeNow = 0;
  maxObserved = 0;

  constructor(private readonly inner: HostGatePort) {}

  acquire(url: string, isTerminated: () => boolean): (() => void) | null {
    this.acquisitions += 1;
    const release = this.inner.acquire(url, isTerminated);
    if (release === null) {
      return null;
    }
    this.activeNow += 1;
    this.maxObserved = Math.max(this.maxObserved, this.activeNow);
    return (): void => {
      this.activeNow -= 1;
      release();
    };
  }
}

function walkerFor(
  transport: RecordedHttpTransport,
  overrides: Partial<ConstructorParameters<typeof EngineDirectoryWalker>[0]> = {},
  registrations: readonly RegistrationRecord[] = [
    makeRegistration({
      id: HENTAI2READ_ID,
      name: 'Hentai2Read',
      file: 'Hentai2Read.lua',
      capabilities: directoryCapable(),
    }),
  ],
): EngineDirectoryWalker {
  return new EngineDirectoryWalker({
    luaRoot: '/workspace/FMD2/lua',
    modules: (): readonly RegistrationRecord[] => registrations,
    transport,
    egress: new EgressPolicy({ allow: ['hentai2read.com'] }),
    ...overrides,
  });
}

describe('EngineDirectoryWalker (§6.8) — real module, recorded fixtures', (): void => {
  it('walks GetDirectoryPageNumber → per-page GetNameAndLink and returns §5.8-normalized entries', async (): Promise<void> => {
    const site = recordPages([
      {
        url: PAGE_1,
        body: directoryPage(2, [
          { url: 'https://hentai2read.com/manga/Alpha_Manga/', title: '  Alpha Manga  ' },
          { url: 'https://hentai2read.com/manga/Beta%20Tales', title: 'Beta &amp; Tales' },
        ]),
      },
      {
        url: PAGE_2,
        body: directoryPage(2, [
          { url: '/manga/relative-gamma', title: 'Gamma Story' },
        ]),
      },
    ]);
    const gate = new CountingGate(new SyncHostGate({ limit: 1 }));
    const walker = walkerFor(site.transport, { hostGate: gate });

    const entries = await walker.walk(HENTAI2READ_ID);

    // §5.8 output — normalized, NOT the raw module pairs:
    expect(entries.map((e) => e.link)).toEqual([
      '/manga/Alpha_Manga/', // host stripped (uData.pas:111-113)
      '/manga/Beta%20Tales',
      '/manga/relative-gamma', // host-relative preserved
    ]);
    expect(entries.map((e) => e.title)).toEqual(['Alpha Manga', 'Beta & Tales', 'Gamma Story']);

    // 3 page fetches (page-1 by BOTH events, page-2 once), every one
    // through the per-host gate, never over its limit of 1.
    expect(site.resolver.requests.map((r) => r.url)).toEqual([PAGE_1, PAGE_1, PAGE_2]);
    expect(gate.acquisitions).toBe(3);
    expect(gate.maxObserved).toBe(1);
  });

  it('a failed page fetch is a typed walk_failed — never a partial page', async (): Promise<void> => {
    // page-2 deliberately NOT recorded → the module's HTTP.GET fails →
    // net_problem → the whole walk fails even though page-1 succeeded.
    const site = recordPages([
      {
        url: PAGE_1,
        body: directoryPage(2, [{ url: 'https://hentai2read.com/manga/Alpha_Manga/', title: 'Alpha Manga' }]),
      },
    ]);
    const walker = walkerFor(site.transport);

    const outcome = walker.walk(HENTAI2READ_ID);
    await expect(outcome).rejects.toMatchObject({
      name: 'CatalogFallbackError',
      kind: 'walk_failed',
    });
    await outcome.catch((err: unknown): void => {
      expect((err as CatalogFallbackError).message).toContain('page 1');
    });
  });

  it('a page count over the safety ceiling is walk_failed (no truncated crawl)', async (): Promise<void> => {
    const site = recordPages([
      { url: PAGE_1, body: directoryPage(MAX_DIRECTORY_PAGES + 1, []) },
    ]);
    const walker = walkerFor(site.transport);
    await expect(walker.walk(HENTAI2READ_ID)).rejects.toMatchObject({
      name: 'CatalogFallbackError',
      kind: 'walk_failed',
    });
  });

  it('a module without the §6.8 capability is fallback_unavailable (engine never even starts)', async (): Promise<void> => {
    const site = recordPages([]);
    const walker = walkerFor(site.transport, {}, [
      makeRegistration({
        id: HENTAI2READ_ID,
        name: 'Hentai2Read',
        file: 'Hentai2Read.lua',
        capabilities: plainCapabilities(),
      }),
    ]);
    await expect(walker.walk(HENTAI2READ_ID)).rejects.toMatchObject({
      name: 'CatalogFallbackError',
      kind: 'fallback_unavailable',
    });
  });
});
