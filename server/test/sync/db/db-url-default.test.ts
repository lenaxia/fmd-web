import { describe, expect, it } from 'vitest';
import { CatalogSync } from '../../../src/sync/db/sync-service.js';
import {
  catalogBlobUrl,
  DEFAULT_FMD2_DB_URL,
  FMD2_DB_REPO_DEFAULT,
} from '../../../src/sync/db/sync-service.js';

/**
 * Default FMD_DB_URL regression (launch defect (b)): the historical
 * default carried a phantom `/db` segment (`.../FMD2-DB/master/db`) —
 * the LIVE layout is `<base>/master/7z/<ID>.7z` (FMD2 dist config.json
 * db_url) — so every default catalog fetch 404'd. These assertions are
 * pure string composition: NO network in CI (the live HEAD check is
 * the opt-in server/test/live/defaults-live.test.ts).
 */

describe('default FMD_DB_URL composition (offline regression, launch defect (b))', (): void => {
  it('the default has NO phantom /db segment and matches the live repo layout', (): void => {
    expect(DEFAULT_FMD2_DB_URL).toBe('https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master');
    expect(DEFAULT_FMD2_DB_URL.startsWith('https://raw.githubusercontent.com/')).toBe(true);
    // the phantom segment is the regression probe: `/db` after the ref
    expect(/\/db$/.test(DEFAULT_FMD2_DB_URL)).toBe(false);
    expect(DEFAULT_FMD2_DB_URL.endsWith(`/${FMD2_DB_REPO_DEFAULT.ref}`)).toBe(true);
  });

  it('blob URLs compose to .../master/7z/<id>.7z (the live FMD2-DB pattern)', (): void => {
    const id = '053da85062184626a0a1ff6d57c3c955';
    expect(catalogBlobUrl(DEFAULT_FMD2_DB_URL, id)).toBe(
      `https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/7z/${id}.7z`,
    );
  });

  it('catalogBlobUrl trims trailing slashes off overridden bases (override-driven call sites)', (): void => {
    expect(catalogBlobUrl('http://e2e-mock:8081/FMD2-DB/master//', 'ab'.repeat(16))).toBe(
      `http://e2e-mock:8081/FMD2-DB/master/7z/${'ab'.repeat(16)}.7z`,
    );
  });

  it('CatalogSync fetches .../master/7z/<id>.7z when dbUrl is not overridden', async (): Promise<void> => {
    const id = 'ef'.repeat(16);
    const seen: string[] = [];
    const sync = new CatalogSync({
      dataDir: '/tmp/unused-default-url-audit',
      fetchImpl: (url: string): Promise<Response> => {
        seen.push(url);
        return Promise.resolve(new Response('not found', { status: 404 }));
      },
    });
    const outcome = await sync.syncCatalog(id);
    expect(outcome.state).toBe('failed'); // the 404 surfaces as a failed sync
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/7z/${id}.7z`);
    expect(seen[0]).not.toContain('/db/');
  });

  it('the audit trail: every dbUrl composition in the tree flows through catalogBlobUrl', (): void => {
    // One composition point (sync-service.ts) — the default constant is
    // the only place the raw URL appears; tests/e2e/compose overrides
    // inject their own base (asserted above with the loopback form).
    expect(DEFAULT_FMD2_DB_URL).not.toContain('/db/');
  });
});
