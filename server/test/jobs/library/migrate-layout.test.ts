/**
 * [library-layout] One-time migration onto the flat series convention:
 * old-layout detection (the recorded depth-3 segment triple only —
 * saveTo rows never match), moves + ledger re-points, the
 * duplicate-suffix rule during migration (first module keeps the clean
 * name), the unattributed on-disk folder, the occupied-target
 * collision, missing-file re-points, empty-shell pruning, and
 * IDEMPOTENCY (a migrated tree re-runs as a no-op).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import {
  isOldLayoutRow,
  migrateLibraryLayout,
} from '../../../src/jobs/library/migrate.js';
import type { LibraryLedgerRow } from '../../../src/jobs/library/reconcile.js';

const MODULE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MODULE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let dir = '';

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

interface Harness {
  readonly store: SqliteLibraryStore;
  readonly root: string;
  readonly logs: string[];
  readonly run: () => ReturnType<typeof migrateLibraryLayout>;
}

function open(): Harness {
  dir = join(tmpdir(), `fmd-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const root = join(dir, 'library');
  mkdirSync(root, { recursive: true });
  const raw = new Database(join(dir, 'app.db'));
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: root });
  const logs: string[] = [];
  return {
    store,
    root,
    logs,
    run: (): ReturnType<typeof migrateLibraryLayout> =>
      migrateLibraryLayout({ store, root, log: (m): void => { logs.push(m); } }),
  };
}

/** Seed an OLD-layout recorded file: on disk at <module>/<manga>/<file>. */
function oldRow(
  h: Harness,
  opts: { moduleId?: string; manga: string; file: string; onDisk?: boolean; bytes?: number },
): void {
  const moduleId = opts.moduleId ?? MODULE_A;
  const abs = join(h.root, moduleId, opts.manga, opts.file);
  if (opts.onDisk !== false) {
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, Buffer.alloc(opts.bytes ?? 10, 7));
  }
  h.store.recordLibraryFile({
    moduleId,
    manga: opts.manga,
    fileName: opts.file,
    path: abs,
    bytes: opts.bytes ?? 10,
  });
}

describe('isOldLayoutRow (detection)', (): void => {
  it('matches the recorded depth-3 segment triple and nothing else', (): void => {
    const h = open();
    oldRow(h, { manga: 'mangam', file: 'ch-001.cbz' });
    const base = h.store.allLibraryLedgerRows()[0];
    expect(base).toBeDefined();
    if (base === undefined) {
      throw new Error('seeded row missing');
    }
    const row: LibraryLedgerRow = { ...base, path: join(h.root, MODULE_A, 'mangam', 'ch-001.cbz') };
    expect(isOldLayoutRow(h.root, row)).toBe(true);
    // New flat layout — not old.
    expect(isOldLayoutRow(h.root, { ...row, path: join(h.root, 'mangam', 'ch-001.cbz') })).toBe(false);
    // Depth-3 but segments disagree with the recorded components (a
    // saveTo shape) — not old.
    expect(isOldLayoutRow(h.root, { ...row, path: join(h.root, 'custom', 'deeper', 'ch-001.cbz') })).toBe(false);
    expect(isOldLayoutRow(h.root, { ...row, path: join(h.root, MODULE_A, 'OTHER', 'ch-001.cbz') })).toBe(false);
    // Outside the root — never.
    expect(isOldLayoutRow(h.root, { ...row, path: join(dir, 'elsewhere', 'ch-001.cbz') })).toBe(false);
  });
});

describe('migrateLibraryLayout', (): void => {
  it('moves old-layout files onto the flat convention and re-points the ledger', (): void => {
    const h = open();
    const abs = join(h.root, MODULE_A, 'mangam', 'ch-001.cbz');
    oldRow(h, { manga: 'mangam', file: 'ch-001.cbz' });
    const id = h.store.allLibraryLedgerRows()[0]?.id ?? 0;

    const summary = h.run();

    expect(summary.moved).toBe(1);
    expect(summary.suffixed).toBe(0);
    expect(summary.collisions).toBe(0);
    const newRow = h.store.allLibraryLedgerRows()[0];
    expect(newRow?.id).toBe(id);
    expect(newRow?.path).toBe(join(h.root, 'mangam', 'ch-001.cbz'));
    expect(newRow?.manga).toBe('mangam');
    expect(newRow?.state).toBe('downloaded');
    expect(newRow?.verifiedAt).not.toBeNull();
    // The file physically lives at the new path; the old tree is gone.
    expect(existsSync(join(h.root, 'mangam', 'ch-001.cbz'))).toBe(true);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(join(h.root, MODULE_A))).toBe(false);
  });

  it('duplicate titles across modules: first writer keeps the clean name, the second is suffixed', (): void => {
    const h = open();
    oldRow(h, { moduleId: MODULE_A, manga: 'Naruto', file: 'ch-001.cbz' });
    oldRow(h, { moduleId: MODULE_B, manga: 'Naruto', file: 'ch-001.cbz' });

    const summary = h.run();

    expect(summary.moved).toBe(2);
    expect(summary.suffixed).toBe(1);
    const rows = h.store.allLibraryLedgerRows();
    const paths = rows.map((r): string => r.path).sort();
    // ' ' sorts before the path separator — the suffixed home is first.
    expect(paths).toEqual([
      join(h.root, `Naruto [${MODULE_B}]`, 'ch-001.cbz'),
      join(h.root, 'Naruto', 'ch-001.cbz'),
    ]);
    // The suffixed row records the effective folder in its manga column.
    const suffixedRow = rows.find((r): boolean => r.path.includes('['));
    expect(suffixedRow?.manga).toBe(`Naruto [${MODULE_B}]`);
    // Both files exist at their new homes.
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('same module, same title: every row stays on the clean name', (): void => {
    const h = open();
    oldRow(h, { moduleId: MODULE_A, manga: 'Naruto', file: 'ch-001.cbz' });
    oldRow(h, { moduleId: MODULE_A, manga: 'Naruto', file: 'ch-002.cbz' });
    const summary = h.run();
    expect(summary.suffixed).toBe(0);
    expect(summary.moved).toBe(2);
    const rows = h.store.allLibraryLedgerRows();
    expect(rows.every((r): boolean => r.path === join(h.root, 'Naruto', r.fileName))).toBe(true);
  });

  it('an unattributed on-disk folder claims the clean name → the old-layout row suffixes', (): void => {
    const h = open();
    mkdirSync(join(h.root, 'Naruto'), { recursive: true });
    writeFileSync(join(h.root, 'Naruto', 'manual-file.cbz'), Buffer.alloc(4, 1));
    oldRow(h, { moduleId: MODULE_A, manga: 'Naruto', file: 'ch-001.cbz' });

    const summary = h.run();

    expect(summary.suffixed).toBe(1);
    const row = h.store.allLibraryLedgerRows()[0];
    expect(row?.path).toBe(join(h.root, `Naruto [${MODULE_A}]`, 'ch-001.cbz'));
    // The manual file stayed exactly where it was (orphan machinery
    // owns it — no adoption).
    expect(existsSync(join(h.root, 'Naruto', 'manual-file.cbz'))).toBe(true);
  });

  it('saveTo rows (segments disagree) are never migrated', (): void => {
    const h = open();
    const custom = join(h.root, 'custom-dir', 'deeper');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'ch-009.cbz'), Buffer.alloc(6, 1));
    h.store.recordLibraryFile({
      moduleId: MODULE_A,
      manga: 'mangam',
      fileName: 'ch-009.cbz',
      path: join(custom, 'ch-009.cbz'),
      bytes: 6,
    });
    const summary = h.run();
    expect(summary.skipped).toBe(1);
    expect(summary.moved).toBe(0);
    expect(h.store.allLibraryLedgerRows()[0]?.path).toBe(join(custom, 'ch-009.cbz'));
  });

  it('a file missing at its old path still re-points (stays missing at the new location)', (): void => {
    const h = open();
    oldRow(h, { manga: 'mangam', file: 'ch-gone.cbz', onDisk: false });
    const summary = h.run();
    expect(summary.repointed).toBe(1);
    expect(summary.moved).toBe(0);
    const row = h.store.allLibraryLedgerRows()[0];
    expect(row?.path).toBe(join(h.root, 'mangam', 'ch-gone.cbz'));
  });

  it('an occupied target is a collision: nothing moves, the row keeps its old path', (): void => {
    const h = open();
    // The clean folder is already LEDGER-claimed by the SAME module (a
    // migrated row), so the old-layout row targets it without a suffix
    // — and a stray file squats the exact target path.
    mkdirSync(join(h.root, 'mangam'), { recursive: true });
    writeFileSync(join(h.root, 'mangam', 'ch-000.cbz'), Buffer.alloc(2, 1));
    h.store.recordLibraryFile({
      moduleId: MODULE_A,
      manga: 'mangam',
      fileName: 'ch-000.cbz',
      path: join(h.root, 'mangam', 'ch-000.cbz'),
      bytes: 2,
    });
    writeFileSync(join(h.root, 'mangam', 'ch-001.cbz'), Buffer.alloc(3, 1));
    oldRow(h, { manga: 'mangam', file: 'ch-001.cbz' });
    const summary = h.run();
    expect(summary.collisions).toBe(1);
    expect(summary.moved).toBe(0);
    // The row still records the OLD layout (retried next boot; the
    // stray stays rescan truth).
    const collided = h.store.allLibraryLedgerRows().find((r): boolean => r.fileName === 'ch-001.cbz');
    expect(collided?.path).toBe(join(h.root, MODULE_A, 'mangam', 'ch-001.cbz'));
    expect(h.logs.some((line) => line.includes('collision'))).toBe(true);
  });

  it('prunes the empty <module> shells but never a dir holding a stray', (): void => {
    const h = open();
    oldRow(h, { moduleId: MODULE_A, manga: 'mangam', file: 'ch-001.cbz' });
    // A stray keeps another old module tree alive.
    mkdirSync(join(h.root, MODULE_B, 'otherm'), { recursive: true });
    writeFileSync(join(h.root, MODULE_B, 'otherm', 'stray.cbz'), Buffer.alloc(2, 1));
    h.run();
    expect(existsSync(join(h.root, MODULE_A))).toBe(false);
    expect(existsSync(join(h.root, MODULE_B, 'otherm', 'stray.cbz'))).toBe(true);
  });

  it('IDEMPOTENT: a migrated tree re-runs as a no-op', (): void => {
    const h = open();
    oldRow(h, { moduleId: MODULE_A, manga: 'Naruto', file: 'ch-001.cbz' });
    oldRow(h, { moduleId: MODULE_B, manga: 'Naruto', file: 'ch-001.cbz' });
    const first = h.run();
    expect(first.moved).toBe(2);
    const second = h.run();
    expect(second).toMatchObject({ moved: 0, repointed: 0, suffixed: 0, collisions: 0, failures: 0 });
    expect(second.skipped).toBe(2);
    // The summary is logged.
    expect(h.logs.some((line) => line.includes('[library-layout-migration] done'))).toBe(true);
  });

  it('rows already on the new layout seed the claims (a partial earlier run wins)', (): void => {
    const h = open();
    // Module B already migrated (flat row on disk).
    mkdirSync(join(h.root, 'Naruto'), { recursive: true });
    writeFileSync(join(h.root, 'Naruto', 'ch-b.cbz'), Buffer.alloc(5, 1));
    h.store.recordLibraryFile({
      moduleId: MODULE_B,
      manga: 'Naruto',
      fileName: 'ch-b.cbz',
      path: join(h.root, 'Naruto', 'ch-b.cbz'),
      bytes: 5,
    });
    // Module A still old-layout — B keeps the clean name.
    oldRow(h, { moduleId: MODULE_A, manga: 'Naruto', file: 'ch-a.cbz' });
    const summary = h.run();
    expect(summary.suffixed).toBe(1);
    expect(h.store.allLibraryLedgerRows().find((r): boolean => r.fileName === 'ch-a.cbz')?.path).toBe(
      join(h.root, `Naruto [${MODULE_A}]`, 'ch-a.cbz'),
    );
  });

  it('an empty library/root is a clean no-op', (): void => {
    const h = open();
    const summary = h.run();
    expect(summary).toMatchObject({ moved: 0, skipped: 0, failures: 0 });
  });
});
