import { describe, expect, it } from 'vitest';
import { DEFAULT_FMD2_DB_URL, catalogBlobUrl } from '../../src/sync/db/sync-service.js';
import { DEFAULT_BOOTSTRAP_CATALOGS } from '../../src/runtime/catalog-defaults.js';

/**
 * NETWORK-GATED (opt-in, like the live smoke CLI): HEAD-verifies every
 * curated default catalog ID against the LIVE FMD2-DB so catalog rot is
 * caught by CI, not discovered by users (launch defect (c)).
 *
 * Skipped unless FMD_LIVE=1 — the runbook invocation:
 *   npm run test:live          (repo root; unsets nothing else)
 * The zero-network guard (corpus/test/setup/no-network.ts) honors the
 * same flag for this run only.
 */

const runLive = process.env['FMD_LIVE'] === '1';

describe.skipIf(!runLive)('default bootstrap catalogs are live (FMD2-DB HEAD checks)', (): void => {
  it('ships >=4 curated default catalog ids', (): void => {
    expect(DEFAULT_BOOTSTRAP_CATALOGS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(DEFAULT_BOOTSTRAP_CATALOGS).size).toBe(DEFAULT_BOOTSTRAP_CATALOGS.length);
    for (const id of DEFAULT_BOOTSTRAP_CATALOGS) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('the default FMD_DB_URL composes to the live layout (.../master/7z/<id>.7z)', (): void => {
    expect(DEFAULT_FMD2_DB_URL).toBe('https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master');
    expect(DEFAULT_FMD2_DB_URL).not.toContain('/db');
    for (const id of DEFAULT_BOOTSTRAP_CATALOGS) {
      expect(catalogBlobUrl(DEFAULT_FMD2_DB_URL, id)).toBe(
        `https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/7z/${id}.7z`,
      );
    }
  });

  it('HEAD-verifies every default catalog id against live FMD2-DB (200)', async (): Promise<void> => {
    for (const id of DEFAULT_BOOTSTRAP_CATALOGS) {
      const url = catalogBlobUrl(DEFAULT_FMD2_DB_URL, id);
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
      expect(
        response.status,
        `${id} no longer serves at the default URL (catalog rot — curate a replacement): ${url}`,
      ).toBe(200);
    }
  });
});

describe.skipIf(runLive)('default catalogs (offline marker)', (): void => {
  it('documents how to run the live check', (): void => {
    // Keeps the file visible in normal runs without touching the network.
    expect(DEFAULT_BOOTSTRAP_CATALOGS.length).toBeGreaterThanOrEqual(4);
  });
});
