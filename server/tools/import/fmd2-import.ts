#!/usr/bin/env node
/**
 * fmd2-import — the D4 one-shot FMD2 migration CLI (DESIGN.md §8.6 item 6,
 * §5 phase table "accounts+import (D4)"). Three subcommands, each idempotent
 * (re-running never duplicates rows), fully offline:
 *
 *   fmd2-import fmd2-modules   <modules.json>        --db <app.db>
 *       FMD2 module settings (enabled flags + option values incl.
 *       combobox indexes + cookies/UA) → §9 module_state.
 *
 *   fmd2-import fmd2-downloads <downloadedchapters.db> --db <app.db>
 *       FMD2 downloaded-chapters ledger (LowerCase(ModuleID+Link) rows,
 *       merged strings) → §9 downloaded_chapters (merge semantics).
 *
 *   fmd2-import fmd2-accounts  <modules.json>        --db <app.db>
 *       [--secret <text>]   (env FMD_WEB_SECRET when omitted)
 *       Decrypt the FMD2 EncryptString account fields with the FMD2
 *       hardcoded key (uBaseUnit.pas:1557–1572 — the ONLY sanctioned use,
 *       see src/tools/import/fmd2-crypto.ts) and re-seal under
 *       FMD_WEB_SECRET (AES-256-GCM) into §9 account.
 *
 * Output: a JSON summary on stdout. Exit codes: 0 = imported; 1 = failure
 * (JSON error on stderr); 2 = usage error.
 *
 * Run: npx tsx server/tools/import/fmd2-import.ts <args…>
 * (or node server/dist/tools/import/fmd2-import.js after a build).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteAccountStore } from '../../src/accounts/account-store.js';
import { SecretBoxError } from '../../src/accounts/secret-box.js';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import { openAppDb, SqliteImportModuleState } from '../../src/tools/import/appdb.js';
import { importFmd2Accounts } from '../../src/tools/import/fmd2-accounts.js';
import { ImportSourceError, importFmd2Downloads, readFmd2DownloadedDb } from '../../src/tools/import/fmd2-downloads.js';
import { ImportFormatError, importFmd2Modules, parseFmd2ModulesJson } from '../../src/tools/import/fmd2-modules.js';

export type ImportCommand = 'fmd2-modules' | 'fmd2-downloads' | 'fmd2-accounts';

export interface ImportCliArgs {
  readonly command: ImportCommand;
  readonly source: string;
  readonly db: string;
  /** Deployment secret for fmd2-accounts (--secret or env FMD_WEB_SECRET). */
  readonly secret?: string;
}

export function usage(): string {
  return [
    'Usage:',
    '  fmd2-import fmd2-modules <modules.json> --db <app.db>',
    '  fmd2-import fmd2-downloads <downloadedchapters.db> --db <app.db>',
    '  fmd2-import fmd2-accounts <modules.json> --db <app.db> [--secret <text>]',
    '    (the secret defaults to the FMD_WEB_SECRET environment variable)',
  ].join('\n');
}

/** Minimal argv parser (long flags with `=`, space-separated values, or bare). */
export function parseArgs(argv: readonly string[]): ImportCliArgs {
  const positional: string[] = [];
  let db: string | undefined;
  let secret: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--db') {
      db = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--db=')) {
      db = arg.slice('--db='.length);
    } else if (arg === '--secret') {
      secret = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--secret=')) {
      secret = arg.slice('--secret='.length);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const command = positional[0];
  const source = positional[1];
  if (command !== 'fmd2-modules' && command !== 'fmd2-downloads' && command !== 'fmd2-accounts') {
    throw new UsageError(`unknown command: ${command === undefined ? '(none)' : command}`);
  }
  if (source === undefined || source === '') {
    throw new UsageError('missing source file argument');
  }
  if (db === undefined || db === '') {
    throw new UsageError('missing --db <app.db> argument');
  }
  return { command, source, db, ...(secret !== undefined ? { secret } : {}) };
}

export class UsageError extends Error {}

interface SummaryBody {
  readonly command: ImportCommand;
  readonly db: string;
  readonly [key: string]: unknown;
}

/** Run one import subcommand against the SQLite targets. Exported for the
 * offline tool tests (in-process, no spawn/build dependency). */
export async function runImport(args: ImportCliArgs): Promise<SummaryBody> {
  const db = openAppDb(args.db);
  try {
    if (args.command === 'fmd2-modules') {
      const entries = parseFmd2ModulesJson(readFileSync(args.source, 'utf8'));
      const summary = await importFmd2Modules(entries, new SqliteImportModuleState(db));
      return { command: args.command, db: args.db, ...summary };
    }
    if (args.command === 'fmd2-downloads') {
      const rows = readFmd2DownloadedDb(args.source);
      const store = new SqliteLibraryStore({ db });
      const summary = importFmd2Downloads(rows, store);
      return { command: args.command, db: args.db, ...summary };
    }
    const secret = args.secret ?? process.env['FMD_WEB_SECRET'] ?? '';
    const entries = parseFmd2ModulesJson(readFileSync(args.source, 'utf8'));
    const summary = importFmd2Accounts(entries, secret, new SqliteAccountStore(db));
    return {
      command: args.command,
      db: args.db,
      // Never echo the secret or any decrypted value.
      ...summary,
    };
  } finally {
    db.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let args: ImportCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err: unknown) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${usage()}\n`);
      return 2;
    }
    throw err;
  }
  try {
    const summary = await runImport(args);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (err: unknown) {
    if (err instanceof SecretBoxError) {
      process.stderr.write(`${JSON.stringify({ error: 'secret_box', message: err.message }, null, 2)}\n`);
      return 1;
    }
    if (err instanceof ImportFormatError || err instanceof ImportSourceError) {
      process.stderr.write(`${JSON.stringify({ error: 'import_format', message: err.message }, null, 2)}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: 'import_failed', message }, null, 2)}\n`);
    return 1;
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code): void => {
      process.exitCode = code;
    })
    .catch((err: unknown): void => {
      process.stderr.write(`${JSON.stringify({ error: 'import_failed', message: err instanceof Error ? err.message : String(err) }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
