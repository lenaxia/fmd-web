import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BootstrapRunner } from '../../src/runtime/bootstrap.js';

/**
 * Bootstrap warning surfacing for TOLERATED staged-validation failures
 * (launch defect (a)): the sync-state report carries failures[] AND the
 * bootstrap log lists them as explicit WARNING lines — a tolerant sync
 * is never a silent one.
 */

const FAILURE_FIXTURE = [
  { file: 'modules/JapScan.lua', firstError: 'luaL_loadbufferx(modules/JapScan.lua) failed: 3' },
  { file: 'modules/dm5.lua', firstError: 'luaL_loadbufferx(modules/dm5.lua) failed: 3' },
] as const;

function makeRunner(
  logs: string[],
  dirs: string[],
  syncReport: { modules: number; failures?: readonly { file: string; firstError: string }[] },
): BootstrapRunner {
  const dataDir = mkdtempSync(join(tmpdir(), 'fmd-bootstrap-warn-'));
  dirs.push(dataDir);
  return new BootstrapRunner({
    dataDir: mkdtempSync(join(tmpdir(), 'fmd-bootstrap-warn-')),
    syncModules: async () => ({ sha: 'a'.repeat(40), report: syncReport }),
    bootRegistry: async () => ({ source: 'sweep', modules: syncReport.modules }),
    syncCatalog: async () => ({ state: 'updated' }),
    checkCatalogUpdates: async () => ({ changed: false, headSha: 'b'.repeat(40) }),
    catalogIds: [],
    log: (message): void => {
      logs.push(message);
    },
  });
}

describe('BootstrapRunner — tolerated failures surface as warnings', (): void => {
  const dirs: string[] = [];

  afterEach((): void => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists every tolerated failure as a WARNING line after the sync result', async (): Promise<void> => {
    const logs: string[] = [];
    const runner = makeRunner(logs, dirs, { modules: 454, failures: [...FAILURE_FIXTURE] });
    await runner.run();

    expect(runner.isDone).toBe(true);
    expect(logs).toContainEqual(
      expect.stringContaining('bootstrap: WARNING — module sync tolerated 2 upstream-broken file(s)'),
    );
    expect(logs).toContainEqual(expect.stringContaining('modules/JapScan.lua'));
    expect(logs).toContainEqual(
      expect.stringContaining('bootstrap:   - modules/dm5.lua: luaL_loadbufferx(modules/dm5.lua) failed: 3'),
    );
  });

  it('a clean tree logs no warning block', async (): Promise<void> => {
    const logs: string[] = [];
    const runner = makeRunner(logs, dirs, { modules: 4, failures: [] });
    await runner.run();

    expect(runner.isDone).toBe(true);
    expect(logs.some((line) => line.includes('WARNING'))).toBe(false);
    expect(logs.some((line) => line.includes('upstream-broken'))).toBe(false);
  });
});
