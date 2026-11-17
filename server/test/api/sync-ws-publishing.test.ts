/**
 * WsPublishingSyncService (site-first browse): one catalog provision
 * streams as WS `sync` frames — `checking` at entry, the service's
 * fine-grained phases verbatim, and a terminal frame whose `outcome`
 * follows the no-catalog/transient taxonomy — while the REST outcome
 * passes through UNCHANGED.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_CATALOG_ERROR_PREFIX,
  WsPublishingSyncService,
  type CatalogSyncOutcome,
  type SyncService,
} from '../../src/api/services.js';
import { catalogSyncJobId, type CatalogSyncProgressT } from '@fmd/contract';

function fakeInner(
  result: CatalogSyncOutcome | Error,
): SyncService & { phases: string[] } {
  const phases: string[] = [];
  const service: SyncService & { phases: string[] } = {
    phases,
    syncModules: async (): Promise<never> => {
      throw new Error('not under test');
    },
    syncCatalog: async (id: string, onProgress?: (phase: 'downloading' | 'extracting' | 'installing') => void): Promise<CatalogSyncOutcome> => {
      void id;
      onProgress?.('downloading');
      onProgress?.('extracting');
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    syncAllCatalogs: async (): Promise<never> => {
      throw new Error('not under test');
    },
  };
  return service;
}

describe('WsPublishingSyncService', (): void => {
  const MODULE_ID = 'd'.repeat(32);

  it('streams checking → service phases → terminal done(updated)', async (): Promise<void> => {
    const inner = fakeInner({ id: MODULE_ID, state: 'updated', dbSha: 'ab'.repeat(32), bytes: 10 });
    const published: CatalogSyncProgressT[] = [];
    const service = new WsPublishingSyncService(inner, (event): void => {
      published.push(event);
    });

    const outcome = await service.syncCatalog(MODULE_ID);
    expect(outcome.state).toBe('updated');
    expect(published.map((p): string => p.phase)).toEqual([
      'checking',
      'downloading',
      'extracting',
      'done',
    ]);
    expect(published[0]?.jobId).toBe(catalogSyncJobId(MODULE_ID));
    expect(published[0]?.moduleId).toBe(MODULE_ID);
    expect(published.at(-1)?.outcome).toBe('updated');
  });

  it('maps the no-catalog error prefix onto the terminal no-catalog outcome', async (): Promise<void> => {
    const inner = fakeInner({
      id: MODULE_ID,
      state: 'failed',
      error: `${NO_CATALOG_ERROR_PREFIX} FMD2-DB has no catalog archive for this site (HTTP 404)`,
    });
    const published: CatalogSyncProgressT[] = [];
    const service = new WsPublishingSyncService(inner, (event): void => {
      published.push(event);
    });

    const outcome = await service.syncCatalog(MODULE_ID);
    expect(outcome.state).toBe('failed');
    const terminal = published.at(-1);
    expect(terminal?.phase).toBe('done');
    expect(terminal?.outcome).toBe('no-catalog');
    expect(terminal?.detail).toContain('HTTP 404');
  });

  it('a throwing service surfaces phase failed and rethrows (route error envelope unaffected)', async (): Promise<void> => {
    const inner = fakeInner(new Error('socket hang up'));
    const published: CatalogSyncProgressT[] = [];
    const service = new WsPublishingSyncService(inner, (event): void => {
      published.push(event);
    });

    await expect(service.syncCatalog(MODULE_ID)).rejects.toThrow('socket hang up');
    expect(published.at(-1)?.phase).toBe('failed');
    expect(published.at(-1)?.detail).toBe('socket hang up');
  });

  it('forwards a caller onProgress alongside its own WS emit', async (): Promise<void> => {
    const inner = fakeInner({ id: MODULE_ID, state: 'unchanged' });
    const seen: string[] = [];
    const service = new WsPublishingSyncService(inner, (): void => {});
    await service.syncCatalog(MODULE_ID, (phase): void => {
      seen.push(phase);
    });
    expect(seen).toEqual(['downloading', 'extracting']);
  });
});
