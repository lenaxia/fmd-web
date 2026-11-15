import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChangedModule } from '../../../src/sync/modules/diff.js';
import {
  diffModuleInventories,
  type ModuleInventoryEntry,
} from '../../../src/sync/modules/diff.js';
import { FIXTURE_IDS } from './fixture-zipball.js';

/**
 * Diff report golden (D9 review gate): added/removed/changed detection by
 * module ID over known inventories. The inventories use the REAL fixture
 * module IDs (same keys the integration syncs produce), so the golden file
 * documents exactly what a v1→v2 pin bump reports. Regenerate with
 * UPDATE_GOLDEN=1 after an intentional change.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(testDir, '..', 'golden', 'module-diff.golden.json');

const v1: readonly ModuleInventoryEntry[] = [
  { id: FIXTURE_IDS.elevenToon, name: '11Toon', sourceFile: 'modules/11Toon.lua' },
  { id: FIXTURE_IDS.asuraScans, name: 'Asura Scans', sourceFile: 'modules/AsuraScans.lua' },
  { id: FIXTURE_IDS.hentai2Read, name: 'Hentai2Read', sourceFile: 'modules/Hentai2Read.lua' },
  { id: FIXTURE_IDS.youngAceUp, name: 'YoungAceUp', sourceFile: 'modules/YoungAceUp.lua' },
];

const v2: readonly ModuleInventoryEntry[] = [
  // same ID, renamed upstream → changed
  { id: FIXTURE_IDS.elevenToon, name: '11Toon Classic', sourceFile: 'modules/11Toon.lua' },
  { id: FIXTURE_IDS.asuraScans, name: 'Asura Scans', sourceFile: 'modules/AsuraScans.lua' },
  // untouched
  { id: FIXTURE_IDS.youngAceUp, name: 'YoungAceUp', sourceFile: 'modules/YoungAceUp.lua' },
  // new ID → added
  { id: FIXTURE_IDS.craftedFixture, name: 'CraftedFixture', sourceFile: 'modules/CraftedFixture.lua' },
  // Hentai2Read absent → removed
];

describe('module diff report (D9 review gate) vs golden JSON', (): void => {
  it('detects added/removed/changed by module ID and matches the committed golden', (): void => {
    const diff = diffModuleInventories(v1, v2);
    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(diff, null, 2)}\n`);
    }
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as typeof diff;
    expect(diff).toEqual(golden);

    expect(diff.added.map((m) => m.id)).toEqual([FIXTURE_IDS.craftedFixture]);
    expect(diff.removed.map((m) => m.id)).toEqual([FIXTURE_IDS.hentai2Read]);
    expect(diff.changed.map((m) => m.id)).toEqual([FIXTURE_IDS.elevenToon]);
    const rename = diff.changed[0] as ChangedModule;
    expect(rename.previousName).toBe('11Toon');
    expect(rename.currentName).toBe('11Toon Classic');
  });

  it('is empty for identical inventories and treats the first sync as all-added', (): void => {
    expect(diffModuleInventories(v1, v1)).toEqual({ added: [], removed: [], changed: [] });
    const firstSync = diffModuleInventories([], v1);
    expect(firstSync.added.length).toBe(4);
    expect(firstSync.removed).toEqual([]);
    expect(firstSync.changed).toEqual([]);
    // deterministic: sorted by ID on every run
    const ids = firstSync.added.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('flags file moves of unchanged IDs as changed (with name context)', (): void => {
    const moved: readonly ModuleInventoryEntry[] = [
      { id: FIXTURE_IDS.youngAceUp, name: 'YoungAceUp', sourceFile: 'modules/site/YoungAceUp.lua' },
    ];
    const diff = diffModuleInventories(
      [{ id: FIXTURE_IDS.youngAceUp, name: 'YoungAceUp', sourceFile: 'modules/YoungAceUp.lua' }],
      moved,
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]?.previousName).toBe(diff.changed[0]?.currentName);
    expect(diff.changed[0]?.currentSourceFile).toBe('modules/site/YoungAceUp.lua');
  });
});
