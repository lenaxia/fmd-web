/**
 * The three D4 one-shot import commands (server/tools/import) against
 * SYNTHETIC FMD2-format fixtures:
 *   - fmd2-modules:   modules.json (TWebsiteModules.SaveToFile shape,
 *                     WebsiteModules.pas:635-693) → §9 module_state;
 *   - fmd2-downloads: downloadedchapters.db (TDownloadedChaptersDB schema,
 *                     DownloadedChaptersDB.pas:44-50) → §9 downloaded_chapters;
 *   - fmd2-accounts:  modules.json Account objects, FMD2 EncryptString
 *                     ciphertext (uBaseUnit.pas:1557-1572) → sealed §9
 *                     account rows.
 * Every fixture is built IN-TEST to the FMD2 formats (the EncryptString
 * ciphertext re-implements the DCP derivation here — the oracle note
 * below) and every import is asserted round-trip + IDEMPOTENT (re-runs
 * never duplicate). Also: the wrong/missing-secret failure is clean, and
 * a real CLI spawn proves the commands run as tools.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { runImport, parseArgs, usage, UsageError } from '../../../tools/import/fmd2-import.js';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { openAppDb, SqliteImportModuleState } from '../../../src/tools/import/appdb.js';
import { SqliteAccountStore } from '../../../src/accounts/account-store.js';
import { openSecret, SecretBoxError } from '../../../src/accounts/secret-box.js';
import { parseFmd2ModulesJson, ImportFormatError } from '../../../src/tools/import/fmd2-modules.js';

const SECRET = 'test-deployment-secret';

const MODULE_A = 'deadbeefdeadbeefdeadbeefdeadbeef';
const MODULE_B = 'feedfacefeedfacefeedfacefeedface';

// ── the FMD2 EncryptString derivation oracle (test-side reimplementation)
//
// Derivation notes (uBaseUnit.pas:1557-1572 + COMPAT.md "DCP cipher
// semantics", openssl cross-checked in crypto-composed.test.ts):
//   1. `aes.InitStr(EncryptKey, TDCP_sha512)` — DCP InitStr hashes the key
//      string (raw ASCII) with SHA-512 and uses the digest as key material
//      truncated to the cipher's MaxKeySize → AES-256 key =
//      SHA512('B74945FB50E84FD58BF9FEAB8E4BEA6B', latin1)[0..31];
//   2. `aes.Init` receives no IV → DCP's nil-IV default seeds the chaining
//      value with E_K(zero block) (DCPblockciphers.pas:479-491);
//   3. `aes.EncryptString` — the canonical DCPcrypt2 2.0.4 blockcipher
//      override is CFB8bit, and the result is standard base64.
const FMD2_KEY = 'B74945FB50E84FD58BF9FEAB8E4BEA6B';

function fmd2Encrypt(plaintext: string): string {
  const key = createHash('sha512').update(FMD2_KEY, 'latin1').digest().subarray(0, 32);
  const ecb = createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const iv = ecb.update(Buffer.alloc(16));
  const cipher = createCipheriv('aes-256-cfb8', key, iv);
  return Buffer.concat([cipher.update(plaintext, 'latin1'), cipher.final()]).toString('base64');
}

// ── fixture builders (FMD2 formats) ──────────────────────────────────

/** modules.json — TWebsiteModules.SaveToFile projection (per-module object:
 * ID, Settings (Enabled + HTTP.Cookies/UserAgent), Options (checkbox bool /
 * edit string / SpinEdit+ComboBox integer — the combobox stores the INDEX),
 * Account (encrypted Username/Password/Cookies + Status ordinal), Cookies
 * (persistent cookie objects)). */
function makeModulesJson(): string {
  return JSON.stringify([
    {
      ID: MODULE_A,
      Settings: {
        Enabled: true,
        MaxTaskLimit: 0,
        MaxThreadPerTaskLimit: 0,
        MaxConnectionLimit: 0,
        HTTP: {
          Cookies: 'cf_clearance=abc; theme=dark',
          UserAgent: 'FMD2/3.9.9',
          Proxy: { ProxyType: 0, ProxyHost: '', ProxyPort: '', ProxyUsername: '', ProxyPassword: '' },
        },
        OverrideSettings: { SaveToPath: '' },
      },
      Options: {
        UseMobile: true, // checkbox → boolean
        Delay: 2, // spinedit → integer
        Language: 1, // combobox → INTEGER item index
      },
      Account: {
        Enabled: true,
        Username: fmd2Encrypt('gooduser'),
        Password: fmd2Encrypt('goodpass'),
        Status: 1, // asChecking — FMD2 resets this to asUnknown on load
        Cookies: fmd2Encrypt('sid=fmd2-session'),
      },
      Cookies: [
        {
          Name: 'persistent_cookie',
          Value: 'pvalue',
          Domain: '.example.org',
          Path: '/',
          SameSite: '',
          Expires: '2035-01-01T00:00:00.000Z',
          HostOnly: false,
          HttpOnly: true,
          Secure: true,
          Persistent: true,
        },
      ],
    },
    {
      ID: MODULE_B,
      Settings: { Enabled: false, HTTP: { Cookies: '', UserAgent: '' } },
      Options: {},
      Account: {
        Enabled: false,
        Username: '',
        Password: fmd2Encrypt('second-pass'),
        Status: 2, // asValid persists as-is
        Cookies: '',
      },
    },
    // A module WITHOUT an Account object — skipped by fmd2-accounts.
    {
      ID: 'abababababababababababababababab',
      Settings: { Enabled: true, HTTP: { Cookies: 'a=1', UserAgent: '' } },
      Options: {},
    },
  ]);
}

/** downloadedchapters.db — TDownloadedChaptersDB schema (CreateParams:
 * "id" VARCHAR(3000) NOT NULL PRIMARY KEY, "chapters" TEXT; rows keyed by
 * LowerCase(ModuleID+Link), chapters = merged list text). */
function makeFmd2DownloadsDb(path: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE "downloadedchapters" ("id" VARCHAR(3000) NOT NULL PRIMARY KEY, "chapters" TEXT)');
  const insert = db.prepare('INSERT INTO "downloadedchapters" ("id", "chapters") VALUES (?, ?)');
  insert.run(
    (MODULE_A + 'https://ex.org/manga/one').toLowerCase(),
    'https://EX.org/ch/1\nhttps://ex.org/ch/2\n',
  );
  insert.run(
    (MODULE_A + 'https://ex.org/manga/two').toLowerCase(),
    'https://ex.org/ch/10\n',
  );
  insert.run(
    (MODULE_B + 'https://ex.org/manga/other').toLowerCase(),
    'https://ex.org/ch/99\n',
  );
  db.close();
}

interface TempDir {
  readonly dir: string;
  readonly modulesJson: string;
  readonly downloadsDb: string;
  readonly appDb: string;
}

const tempDirs: TempDir[] = [];

function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), 'fmd2-import-'));
  const modulesJson = join(dir, 'modules.json');
  const downloadsDb = join(dir, 'downloadedchapters.db');
  const appDb = join(dir, 'app.db');
  writeFileSync(modulesJson, makeModulesJson(), 'utf8');
  tempDirs.push({ dir, modulesJson, downloadsDb, appDb });
  return { dir, modulesJson, downloadsDb, appDb };
}

afterAll((): void => {
  for (const temp of tempDirs.splice(0)) {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

// ── fmd2-modules ─────────────────────────────────────────────────────

describe('fmd2-modules: modules.json → module_state', (): void => {
  it('round-trip: enabled flags, options (combobox INDEX), cookies (folded), UA', async (): Promise<void> => {
    const temp = makeTempDir();
    const summary = await runImport(parseArgs(['fmd2-modules', temp.modulesJson, '--db', temp.appDb]));
    expect(summary).toEqual({ command: 'fmd2-modules', db: temp.appDb, total: 3, imported: 3 });

    const db = openAppDb(temp.appDb);
    try {
      const state = new SqliteImportModuleState(db);
      const a = state.row(MODULE_A);
      expect(a).toBeDefined();
      expect(a?.enabled).toBe(true);
      expect(a?.ua).toBe('FMD2/3.9.9');
      // Settings cookies + the persistent cookie object fold into the jar text.
      expect(a?.cookies).toContain('cf_clearance=abc');
      expect(a?.cookies).toContain('persistent_cookie=pvalue');
      // Options keep their FMD2 value kinds — combobox stays the INDEX.
      expect(a?.options).toEqual({ UseMobile: true, Delay: 2, Language: 1 });
      const b = state.row(MODULE_B);
      expect(b?.enabled).toBe(false);
      expect(b?.cookies).toBe('');
    } finally {
      db.close();
    }
  });

  it('idempotent re-run: no duplicate module_state rows', async (): Promise<void> => {
    const temp = makeTempDir();
    await runImport(parseArgs(['fmd2-modules', temp.modulesJson, '--db', temp.appDb]));
    await runImport(parseArgs(['fmd2-modules', temp.modulesJson, '--db', temp.appDb]));
    const db = new Database(temp.appDb, { readonly: true });
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM module_state').get() as { n: number }).n;
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });
});

// ── fmd2-downloads ───────────────────────────────────────────────────

describe('fmd2-downloads: downloadedchapters.db → downloaded_chapters', (): void => {
  it('round-trip: rows land under the identical LowerCase(ModuleID+Link) keys', async (): Promise<void> => {
    const temp = makeTempDir();
    makeFmd2DownloadsDb(temp.downloadsDb);
    const summary = await runImport(parseArgs(['fmd2-downloads', temp.downloadsDb, '--db', temp.appDb]));
    expect(summary.command).toBe('fmd2-downloads');
    expect(summary.total).toBe(3);
    expect(summary.imported).toBe(3);

    const db = openAppDb(temp.appDb);
    try {
      const store = new SqliteLibraryStore({ db });
      const one = store.getDownloadedChapters(MODULE_A, 'https://ex.org/manga/one');
      expect(one).toContain('https://EX.org/ch/1');
      expect(one).toContain('https://ex.org/ch/2');
      expect(store.getDownloadedChapters(MODULE_A, 'https://ex.org/manga/two')).toContain('https://ex.org/ch/10');
      expect(store.getDownloadedChapters(MODULE_B, 'https://ex.org/manga/other')).toContain('https://ex.org/ch/99');
      const count = (db.prepare('SELECT COUNT(*) AS n FROM downloaded_chapters').get() as { n: number }).n;
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });

  it('idempotent re-run: dupIgnore merge keeps row count and lists stable', async (): Promise<void> => {
    const temp = makeTempDir();
    makeFmd2DownloadsDb(temp.downloadsDb);
    await runImport(parseArgs(['fmd2-downloads', temp.downloadsDb, '--db', temp.appDb]));
    const second = await runImport(parseArgs(['fmd2-downloads', temp.downloadsDb, '--db', temp.appDb]));
    // Every row fully present already → unchanged, nothing "imported" twice.
    expect(second.imported).toBe(0);
    expect(second.unchanged).toBe(3);

    const db = new Database(temp.appDb, { readonly: true });
    try {
      const rows = db.prepare('SELECT id, chapters FROM downloaded_chapters ORDER BY id').all() as {
        id: string;
        chapters: string;
      }[];
      expect(rows).toHaveLength(3);
      // Case-insensitive dupIgnore: the EX.org/ch/1 case variant did NOT duplicate.
      const one = rows.find((r) => r.id === (MODULE_A + 'https://ex.org/manga/one').toLowerCase());
      expect(one?.chapters.match(/ex\.org\/ch\/1/gi)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('a non-FMD2 source db fails cleanly (typed error)', async (): Promise<void> => {
    const temp = makeTempDir();
    const notFmd2 = join(temp.dir, 'wrong.db');
    const db = new Database(notFmd2);
    db.exec('CREATE TABLE something_else (x INTEGER)');
    db.close();
    await expect(runImport(parseArgs(['fmd2-downloads', notFmd2, '--db', temp.appDb]))).rejects.toThrow(/downloadedchapters/);
  });
});

// ── fmd2-accounts ────────────────────────────────────────────────────

describe('fmd2-accounts: FMD2 EncryptString → sealed account rows', (): void => {
  it('round-trip: FMD2 ciphertext decrypts, re-seals under FMD_WEB_SECRET; asChecking→asUnknown', async (): Promise<void> => {
    const temp = makeTempDir();
    const summary = await runImport(
      parseArgs(['fmd2-accounts', temp.modulesJson, '--db', temp.appDb, '--secret', SECRET]),
    );
    expect(summary).toEqual({ command: 'fmd2-accounts', db: temp.appDb, total: 2, imported: 2, undecryptable: 0 });

    const db = new Database(temp.appDb, { readonly: true });
    try {
      const store = new SqliteAccountStore(db);
      const a = store.get(MODULE_A);
      expect(a).toBeDefined();
      expect(openSecret(a?.usernameEnc as string, SECRET)).toBe('gooduser');
      expect(openSecret(a?.passwordEnc as string, SECRET)).toBe('goodpass');
      expect(openSecret(a?.cookiesEnc as string, SECRET)).toBe('sid=fmd2-session');
      // FMD2 LoadFromFile parity: the source's asChecking imports as asUnknown.
      expect(a?.status).toBe(0);
      expect(a?.enabled).toBe(true);
      const b = store.get(MODULE_B);
      expect(openSecret(b?.passwordEnc as string, SECRET)).toBe('second-pass');
      expect(b?.status).toBe(2); // asValid persists
      expect(b?.enabled).toBe(false);
      // The module WITHOUT an Account object is skipped.
      expect(store.get('abababababababababababababababab')).toBeUndefined();
      expect(store.size).toBe(2);
    } finally {
      db.close();
    }
  });

  it('idempotent re-run: upsert, no duplicate account rows', async (): Promise<void> => {
    const temp = makeTempDir();
    await runImport(parseArgs(['fmd2-accounts', temp.modulesJson, '--db', temp.appDb, '--secret', SECRET]));
    await runImport(parseArgs(['fmd2-accounts', temp.modulesJson, '--db', temp.appDb, '--secret', SECRET]));
    const db = new Database(temp.appDb, { readonly: true });
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n;
      expect(count).toBe(2);
      const store = new SqliteAccountStore(db);
      expect(openSecret(store.get(MODULE_A)?.passwordEnc as string, SECRET)).toBe('goodpass');
    } finally {
      db.close();
    }
  });

  it('wrong/missing secret: clean failure — never a plaintext write', async (): Promise<void> => {
    const temp = makeTempDir();
    await expect(
      runImport(parseArgs(['fmd2-accounts', temp.modulesJson, '--db', temp.appDb, '--secret', ''])),
    ).rejects.toThrow(SecretBoxError);
    const countDb = existsSync(temp.appDb)
      ? new Database(temp.appDb, { readonly: true })
      : undefined;
    try {
      const count = countDb === undefined ? 0 : (countDb.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      countDb?.close();
    }
  });
});

// ── format guard rails ───────────────────────────────────────────────

describe('modules.json format guards', (): void => {
  it('non-array payload, bad ids and duplicate ids are clean format errors', (): void => {
    expect(() => parseFmd2ModulesJson('{"not":"an array"}')).toThrow(ImportFormatError);
    expect(() => parseFmd2ModulesJson('[{"ID":"tooshort"}]')).toThrow(/32-hex/);
    expect(() =>
      parseFmd2ModulesJson(
        JSON.stringify([
          { ID: MODULE_A, Settings: { Enabled: true, HTTP: {} } },
          { ID: MODULE_A, Settings: { Enabled: true, HTTP: {} } },
        ]),
      ),
    ).toThrow(/duplicate module ID/);
  });
});

// ── CLI smoke (spawn-based, offline) ─────────────────────────────────

describe('fmd2-import CLI (tsx spawn)', (): void => {
  it('all three commands run green through the real CLI', (): void => {
    const temp = makeTempDir();
    makeFmd2DownloadsDb(temp.downloadsDb);
    // server/test/tools/import → the CLI lives at server/tools/import.
    const cli = fileURLToPath(new URL('../../../tools/import/fmd2-import.ts', import.meta.url));
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const run = (args: string[]): string =>
      execFileSync('node_modules/.bin/tsx', [cli, ...args], {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });

    const modulesOut = JSON.parse(run(['fmd2-modules', temp.modulesJson, '--db', temp.appDb])) as { imported: number };
    expect(modulesOut.imported).toBe(3);
    const downloadsOut = JSON.parse(run(['fmd2-downloads', temp.downloadsDb, '--db', temp.appDb])) as { imported: number };
    expect(downloadsOut.imported).toBe(3);
    const accountsOut = JSON.parse(
      run(['fmd2-accounts', temp.modulesJson, '--db', temp.appDb, '--secret', SECRET]),
    ) as { imported: number };
    expect(accountsOut.imported).toBe(2);

    // The wrong-secret run fails cleanly with exit code 1 + JSON error.
    let failed = false;
    try {
      run(['fmd2-accounts', temp.modulesJson, '--db', join(temp.dir, 'fresh.db'), '--secret', '']);
    } catch (err: unknown) {
      failed = true;
      const execErr = err as { status?: number };
      expect(execErr.status).toBe(1);
    }
    expect(failed).toBe(true);
  });
});

describe('argv parsing + usage', (): void => {
  it('parseArgs handles space/equals flags and rejects unknown commands', (): void => {
    expect(parseArgs(['fmd2-modules', 'a.json', '--db', 'x.db'])).toEqual({
      command: 'fmd2-modules',
      source: 'a.json',
      db: 'x.db',
    });
    expect(parseArgs(['fmd2-accounts', 'a.json', '--db=x.db', '--secret=s'])).toEqual({
      command: 'fmd2-accounts',
      source: 'a.json',
      db: 'x.db',
      secret: 's',
    });
    expect(() => parseArgs(['bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['fmd2-modules'])).toThrow(/missing source/);
    expect(() => parseArgs(['fmd2-modules', 'a.json'])).toThrow(/--db/);
    expect(usage()).toContain('fmd2-accounts');
  });
});
