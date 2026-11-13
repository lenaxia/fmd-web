import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Golden-file helper (Phase-0 seed flows): committed JSON evidence of
 * expected vs actual per flow. Regenerate with UPDATE_GOLDEN=1 after an
 * intentional change; CI (vitest) compares byte-exact JSON.
 */

export function goldenPath(name: string): string {
  return join(import.meta.dirname, '..', 'golden', 'e2e', `${name}.golden.json`);
}

export function compareOrUpdateGolden(name: string, actual: unknown): void {
  const path = goldenPath(name);
  const actualJson = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actualJson);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `golden missing: ${path} — run with UPDATE_GOLDEN=1 to record expected vs actual`,
    );
  }
  const expected = readFileSync(path, 'utf8');
  if (expected !== actualJson) {
    throw new Error(
      `golden mismatch for ${name}:\n--- expected (committed) ---\n${expected}\n--- actual ---\n${actualJson}`,
    );
  }
}
