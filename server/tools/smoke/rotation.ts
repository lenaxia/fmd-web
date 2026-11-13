/**
 * Rotating module-sample selection for the nightly smoke harness
 * (DESIGN.md §13 nightly live smoke): the seed corpus is walked with a
 * deterministic window that advances one slot per rotation index (one
 * night = one index), so consecutive runs cover the whole set without
 * ever repeating the same slice back-to-back.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One selectable seed module (a corpus/fixtures/seed/<Name> dir). */
export interface SeedModuleRef {
  readonly name: string;
  /** Absolute path of the seed directory (manifest.json lives here). */
  readonly dir: string;
}

/** Load the seed-module list (sorted dirs carrying a manifest.json). */
export function listSeedModules(seedDir: string): SeedModuleRef[] {
  const names = readdirSync(seedDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(seedDir, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return names.map((name) => ({ name, dir: join(seedDir, name) }));
}

/**
 * Deterministic rotation: the sample is the `sampleSize`-wide window
 * starting at `(rotationIndex * sampleSize) mod total`, wrapping around
 * the sorted list. rotationIndex defaults to the UTC day number (one
 * window per night, cycling the whole corpus). Sample sizes larger than
 * the corpus clamp to the whole corpus.
 */
export function rotateSample(
  modules: readonly SeedModuleRef[],
  sampleSize: number,
  rotationIndex: number,
): SeedModuleRef[] {
  if (modules.length === 0) {
    return [];
  }
  const size = Math.min(Math.max(sampleSize, 1), modules.length);
  const start = ((rotationIndex * size) % modules.length + modules.length) % modules.length;
  const out: SeedModuleRef[] = [];
  for (let i = 0; i < size; i += 1) {
    out.push(modules[(start + i) % modules.length] as SeedModuleRef);
  }
  return out;
}

/** UTC day number for a timestamp (defaults to now) — the rotation clock. */
export function utcDayNumber(at: Date = new Date()): number {
  return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / 86_400_000);
}
