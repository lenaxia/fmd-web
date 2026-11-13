import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ContractDocument, HealthStatus } from '@fmd/contract';
import { describe, expect, it } from 'vitest';
import {
  asEventBinding,
  canTransition,
  defaultPoolSize,
  defaultPoolOptions,
  emptySnapshot,
  findRoute,
  generationNote,
  isShimName,
  isValidSha,
  isAppDbTable,
  LANES,
  makePin,
  SHIM_NAMES,
  startServer,
  CATALOG_SCHEMA_COLUMNS,
  APP_DB_TABLES,
  API_ROUTES,
} from '../src/index.js';

const contractPath = fileURLToPath(
  new URL('../../contract/contract.json', import.meta.url),
);

function loadContract(): ContractDocument {
  return JSON.parse(readFileSync(contractPath, 'utf8')) as ContractDocument;
}

interface Response {
  readonly status: number;
  readonly body: unknown;
}

async function getJson(url: string): Promise<Response> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as unknown };
}

describe('placeholder healthcheck server (loopback only — offline policy)', (): void => {
  it('serves /healthz and /readyz and 404s elsewhere', async (): Promise<void> => {
    const server = startServer(0);
    await new Promise<void>((resolve, reject): void => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port: number = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${String(port)}`;
    try {
      const health = await getJson(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect((health.body as HealthStatus).status).toBe('ok');

      const ready = await getJson(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ ready: true });

      const miss = await fetch(`${base}/definitely-not-a-route`);
      expect(miss.status).toBe(404);
    } finally {
      await new Promise<void>((resolve): void => {
        server.close((): void => resolve());
      });
    }
  }, 30_000);
});

describe('job lanes (§4/§7.1)', (): void => {
  it('defines exactly the 4 lanes', (): void => {
    expect(LANES).toEqual(['info', 'download', 'update', 'sync']);
  });

  it('follows the persisted state machine', (): void => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'retry')).toBe(true);
    expect(canTransition('retry', 'running')).toBe(true);
    expect(canTransition('running', 'done')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('queued', 'cancelled')).toBe(true);
    expect(canTransition('done', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
  });
});

describe('§5.2 contract cross-check (server reads contract.json, not a copy)', (): void => {
  it('contract carries exactly 15 dispatcher rows', (): void => {
    expect(loadContract().events).toHaveLength(15);
  });

  it('every event read-back is a subset of its bound globals', (): void => {
    for (const e of loadContract().events) {
      for (const g of e.readBack) {
        expect(e.globals).toContain(g);
      }
    }
  });

  it('event rows narrow through the boundary guard', (): void => {
    const row: unknown = loadContract().events[0];
    expect(asEventBinding(row)?.event).toBe('GetDirectoryPageNumber');
    expect(asEventBinding('nope')).toBeUndefined();
    expect(asEventBinding(null)).toBeUndefined();
  });
});

describe('worker pool placeholders (§5.12)', (): void => {
  it('pool size is min(cpu_count, 8) with a 2 GB RSS budget', (): void => {
    expect(defaultPoolSize(2)).toBe(2);
    expect(defaultPoolSize(96)).toBe(8);
    const opts = defaultPoolOptions(96);
    expect(opts.size).toBe(8);
    expect(opts.rssBudgetBytes).toBe(2 * 1024 ** 3);
  });
});

describe('shim registry (§5.7)', (): void => {
  it('registers the contract shim names incl. pb (D17)', (): void => {
    expect(SHIM_NAMES).toContain('pb');
    expect(SHIM_NAMES).toContain('duktape');
    expect(SHIM_NAMES).toHaveLength(15);
  });

  it('narrows shim names', (): void => {
    expect(isShimName('http')).toBe(true);
    expect(isShimName('websitebypass')).toBe(false); // host-level, not a require shim (§5.7)
  });

  it('generation placeholder stays honest', (): void => {
    expect(generationNote()).toContain('contract.json');
  });
});

describe('module state snapshot (§5.3)', (): void => {
  it('starts empty and unknown', (): void => {
    const snap = emptySnapshot('0123456789abcdef0123456789abcdef');
    expect(snap.cookieCount).toBe(0);
    expect(snap.storageKeys).toEqual([]);
    expect(snap.accountStatus).toBe('asUnknown');
  });
});

describe('sync pins (§2)', (): void => {
  it('accepts SHA-1/SHA-256 hex pins and rejects junk', (): void => {
    expect(isValidSha('a'.repeat(40))).toBe(true);
    expect(isValidSha('b'.repeat(64))).toBe(true);
    expect(isValidSha('zz')).toBe(false);
    expect(makePin('dazedcat19/FMD2', 'c'.repeat(40))).toEqual({
      repo: 'dazedcat19/FMD2',
      sha: 'c'.repeat(40),
    });
    expect((): unknown => makePin('dazedcat19/FMD2', 'short')).toThrow(/invalid commit SHA/);
  });
});

describe('db schema placeholders (§6/§9)', (): void => {
  it('lists all app.db tables', (): void => {
    expect(APP_DB_TABLES).toContain('downloaded_chapters');
    expect(APP_DB_TABLES).toHaveLength(8);
    expect(isAppDbTable('job')).toBe(true);
    expect(isAppDbTable('not_a_table')).toBe(false);
  });

  it('catalog columns reuse the FMD2-DB schema verbatim', (): void => {
    expect([...CATALOG_SCHEMA_COLUMNS]).toEqual([
      'link', 'title', 'alttitles', 'authors', 'artists',
      'genres', 'status', 'summary', 'numchapter', 'jdn',
    ]);
  });
});

describe('api route inventory (§10)', (): void => {
  it('contains the idempotent job API and WS backfill endpoints', (): void => {
    expect(findRoute('POST', '/api/jobs/download')).toBeDefined();
    expect(findRoute('WS', '/ws')).toBeDefined();
    expect(findRoute('GET', '/healthz')).toBeDefined();
    expect(findRoute('GET', '/api/catalog/popular')).toBeUndefined(); // D14: no popularity endpoint
    expect(API_ROUTES.length).toBeGreaterThanOrEqual(14);
  });
});
