/**
 * FMD2-key isolation (D4 acceptance criterion 3): the FMD2 hardcoded
 * EncryptString key (uBaseUnit.pas:1556) exists ONLY in the migration
 * module (`server/src/tools/import/fmd2-crypto.ts`) — a source scan
 * proves the literal leaks nowhere else, the import-boundary importers
 * are exactly the whitelist, the native-storage modules never reference
 * it, and the eslint boundary rule stands.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..', '..', '..');
const FMD2_KEY_LITERAL = 'B74945FB50E84FD58BF9FEAB8E4BEA6B';

/** Every TS source file under the repo (tests included — the scan is
 * total; the assertions distinguish source vs test locations). */
function walkTs(dir: string, out: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) {
        continue;
      }
      walkTs(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function rel(path: string): string {
  const r = relative(REPO_ROOT, path);
  return r.split(sep).join('/');
}

function isTestFile(path: string): boolean {
  return rel(path).startsWith('server/test/');
}

/** Import specifiers reaching the migration module (relative paths only —
 * the repo has no package-name alias for it; the sibling form
 * `./fmd2-crypto.js` must match too). */
function importsMigrationModule(content: string): boolean {
  return /['"][^'"]*fmd2-crypto\.js['"]/.test(content);
}

describe('FMD2-key isolation (criterion 3)', (): void => {
  const files = walkTs(REPO_ROOT);

  it('the key literal appears in EXACTLY ONE module: the migration module', (): void => {
    const holders = files.filter((file) => readFileSync(file, 'utf8').includes(FMD2_KEY_LITERAL));
    const nonTest = holders.filter((file) => !isTestFile(file));
    expect(nonTest).toHaveLength(1);
    expect(rel(nonTest[0] as string)).toBe('server/src/tools/import/fmd2-crypto.ts');
    // Tests may derive it (oracle) or import it — the test holders must be
    // under server/test only.
    for (const holder of holders) {
      if (holder !== nonTest[0]) {
        expect(isTestFile(holder), `test-only holder, got ${rel(holder)}`).toBe(true);
      }
    }
  });

  it('server/src importers of the migration module are EXACTLY the whitelist', (): void => {
    const srcFiles = files.filter((file) => rel(file).startsWith('server/src/'));
    const importers = srcFiles.filter((file) => importsMigrationModule(readFileSync(file, 'utf8')));
    expect(importers.map(rel).sort()).toEqual([
      'server/src/engine/shims/install.ts', // fmd.crypto surface wiring (documented)
      'server/src/tools/import/fmd2-accounts.ts', // the import path itself
    ]);
  });

  it('NATIVE STORAGE never references the key nor the migration module', (): void => {
    const storageModules = [
      'server/src/accounts/secret-box.ts',
      'server/src/accounts/account-store.ts',
      'server/src/accounts/account-service.ts',
      'server/src/tools/import/appdb.ts',
      'server/src/tools/import/fmd2-downloads.ts',
      'server/src/tools/import/fmd2-modules.ts',
    ];
    for (const relPath of storageModules) {
      const content = readFileSync(join(REPO_ROOT, ...relPath.split('/')), 'utf8');
      expect(content.includes(FMD2_KEY_LITERAL), `${relPath} embeds the FMD2 key`).toBe(false);
      expect(importsMigrationModule(content), `${relPath} imports the migration module`).toBe(false);
    }
  });

  it('the eslint boundary rule forbids the import outside the whitelist', (): void => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain('no-restricted-imports');
    expect(config).toContain('server/src/tools/import/**');
    expect(config).toContain('server/src/engine/shims/install.ts');
  });

  it('the secret-box deploys FMD_WEB_SECRET (AES-256-GCM), never the FMD2 key', (): void => {
    const secretBox = readFileSync(join(REPO_ROOT, 'server', 'src', 'accounts', 'secret-box.ts'), 'utf8');
    expect(secretBox).toContain('aes-256-gcm');
    expect(secretBox).toContain('FMD_WEB_SECRET');
    expect(secretBox.includes(FMD2_KEY_LITERAL)).toBe(false);
  });
});
