/**
 * FMD2 data-file parsing (PINNED desktop source oracle — /workspace/FMD2):
 *
 * - favorites.db — `favorites` table (baseunits/FavoritesDB.pas:56-71):
 *   id (LowerCase(moduleid+link)), "order", enabled (0/1), moduleid,
 *   link, title, status, currentchapter (TEXT digits), downloadedchapterlist
 *   (chapter names, line-separated), saveto, dateadded/datelastchecked/
 *   datelastupdated ('YYYY-MM-DD HH:MM:SS.mmm' — SQLiteData.pas
 *   PrepSQLValue(TDateTime)). Legacy FMD1 layouts carry a `website`
 *   column instead of moduleid (frmImportFavorites.pas:94-135).
 * - downloadedchapters.db — `downloadedchapters` (id, chapters) with
 *   id = LowerCase(moduleid+link) (DownloadedChaptersDB.pas:118-129).
 * - settings.json — TJSONIniFile: {section: {key: value}} (sections
 *   enumerated from frmMain LoadSettings: connections / saveto /
 *   update / favorites / droptarget …); the flat "section/key" variant
 *   parses too (both shapes carry identical semantics).
 * - modules.json — array of {ID, Settings{Enabled, HTTP{Cookies,
 *   UserAgent, Proxy{…}}, OverrideSettings{SaveToPath}, …}, Options,
 *   Account{Enabled, Username, Password, Cookies — EncryptString-sealed}}
 *   (WebsiteModules.pas:609-687 SaveToFile).
 * - config.json — install-dir bootstrap {config:{db_url, update_url,…}}
 *   (FMDOptions.pas:246-261): detected, nothing importable.
 *
 * Classification is CONTENT-first (sqlite tables / JSON shape); file
 * names are hints only, so a backup copy named `db.sqlite` parses the
 * same as `favorites.db`. Everything malformed throws `Fmd2ParseError`
 * — the API boundary maps that to a typed 400, never a 500.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { decryptFmd2Secret } from './secrets.js';
import { readZip, ZipError } from './zip.js';

export class Fmd2ParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'Fmd2ParseError';
  }
}

/** One favorites.db row (FavoritesDB.pas column semantics). */
export interface Fmd2FavoriteRow {
  readonly moduleId: string;
  /** Host-relative most of the time (§5.8 RemoveHostFromURLsPair). */
  readonly link: string;
  readonly title: string;
  readonly status: string;
  readonly currentChapter: number | null;
  readonly downloadedChapterList: string;
  readonly saveTo: string;
  readonly enabled: boolean;
  readonly dateAddedMs: number | null;
}

/** One downloadedchapters.db row. */
export interface Fmd2LedgerRow {
  readonly id: string;
  readonly chapters: string;
}

/** One flattened settings.json entry. */
export interface Fmd2SettingItem {
  readonly section: string;
  readonly key: string;
  readonly value: string | number | boolean;
}

/** modules.json row — the per-website settings surface we consume. */
export interface Fmd2WebsiteSettings {
  readonly moduleId: string;
  readonly enabled: boolean | null;
  /** Per-site proxy exactly as stored ('' fields = unset). */
  readonly proxy: {
    readonly kind: '' | 'HTTP' | 'SOCKS4' | 'SOCKS5' | 'unset';
    readonly host: string;
    readonly port: string;
    readonly user: string;
    readonly pass: string;
  } | null;
  /** Account block (encrypted at rest; decrypted HERE, in memory only). */
  readonly account: {
    readonly enabled: boolean;
    readonly username: string;
    readonly password: string;
    readonly cookies: string;
  } | null;
  /** Per-site module cookies (persistent HTTP cookies array). */
  readonly cookieCount: number;
}

/** The parsed whole of one upload (multipart parts or zip entries). */
export interface Fmd2Upload {
  readonly favorites: readonly Fmd2FavoriteRow[];
  readonly ledger: readonly Fmd2LedgerRow[];
  readonly settings: readonly Fmd2SettingItem[];
  readonly websites: readonly Fmd2WebsiteSettings[];
  /** File names recognized and consumed (report surface). */
  readonly files: readonly string[];
  /** File names detected but with nothing importable (report surface). */
  readonly ignored: readonly { readonly name: string; readonly reason: string }[];
  /** sqlite dbs whose favorites/ledger tables were found (may be same file). */
  readonly hasFavoritesDb: boolean;
  readonly hasLedgerDb: boolean;
}

interface UploadPart {
  readonly name: string;
  readonly bytes: Buffer;
}

// ── sqlite ───────────────────────────────────────────────────────────

const SQLITE_MAGIC = 'SQLite format 3\0';

function isSqlite(bytes: Buffer): boolean {
  return bytes.length >= 16 && bytes.subarray(0, 16).toString('latin1') === SQLITE_MAGIC;
}

/** FMD2 datetime string ('YYYY-MM-DD HH:MM:SS.mmm') → epoch ms. */
export function parseFmd2DateTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(value);
  if (m === null) {
    return null;
  }
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms)).getTime();
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return new Set(rows.map((row): string => row.name));
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(rows.map((row): string => row.name));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function parseFavoritesTable(db: Database.Database, file: string): { rows: Fmd2FavoriteRow[]; unmappedWebsiteOnly: number } {
  const columns = columnsOf(db, 'favorites');
  if (!columns.has('link')) {
    throw new Fmd2ParseError(`${file}: favorites table without a link column`);
  }
  const select = db.prepare('SELECT * FROM "favorites"').all() as Record<string, unknown>[];
  const rows: Fmd2FavoriteRow[] = [];
  let websiteOnly = 0;
  for (const raw of select) {
    const moduleId = text(raw['moduleid']).trim();
    const website = text(raw['website']).trim();
    const link = text(raw['link']);
    if (moduleId === '' && website === '') {
      websiteOnly += 1;
      continue;
    }
    const enabledRaw = raw['enabled'];
    const currentChapterRaw = text(raw['currentchapter']).trim();
    const current = /^\d+$/.test(currentChapterRaw) ? Number(currentChapterRaw) : null;
    rows.push({
      moduleId: moduleId !== '' ? moduleId : website,
      link,
      title: text(raw['title']),
      status: text(raw['status']),
      currentChapter: current,
      downloadedChapterList: text(raw['downloadedchapterlist']),
      saveTo: text(raw['saveto']),
      enabled: !(enabledRaw === 0 || enabledRaw === false || enabledRaw === '0' || enabledRaw === 'false'),
      dateAddedMs: parseFmd2DateTime(raw['dateadded']),
    });
  }
  return { rows, unmappedWebsiteOnly: websiteOnly };
}

function parseLedgerTable(db: Database.Database): Fmd2LedgerRow[] {
  const rows = db.prepare('SELECT "id", "chapters" FROM "downloadedchapters"').all() as Record<string, unknown>[];
  return rows.map((row): Fmd2LedgerRow => ({ id: text(row['id']), chapters: text(row['chapters']) }));
}

/**
 * Open one sqlite payload READ-ONLY (the catalog-store invariant:
 * `readonly: true` passes SQLITE_OPEN_READONLY to sqlite3_open_v2 —
 * the connection physically cannot write the file or create a journal).
 * Corrupt files throw; the caller maps that to Fmd2ParseError.
 */
function withSqlite<T>(file: string, bytes: Buffer, run: (db: Database.Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fmd2-import-'));
  const dbPath = join(dir, 'upload.sqlite');
  let db: Database.Database | undefined;
  try {
    writeFileSync(dbPath, bytes, { flag: 'wx' });
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err: unknown) {
      throw new Fmd2ParseError(
        `${file}: not a readable SQLite database (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    try {
      return run(db);
    } catch (err: unknown) {
      if (err instanceof Fmd2ParseError) {
        throw err;
      }
      // SQLite validates lazily — a magic-header-only file blows up at
      // the FIRST query, not at open. Same typed 400 either way.
      throw new Fmd2ParseError(
        `${file}: not a readable SQLite database (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── JSON files ───────────────────────────────────────────────────────

function parseJson(file: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (err: unknown) {
    throw new Fmd2ParseError(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function normalizeProxyKind(raw: unknown): '' | 'HTTP' | 'SOCKS4' | 'SOCKS5' | 'unset' {
  // Enum arrives as 'ptHTTP' (RTTI identifier), 'HTTP' (settings.json
  // combo text) or the ordinal 0..4 (TProxyType declaration order).
  if (typeof raw === 'number') {
    return (['unset', '', 'HTTP', 'SOCKS4', 'SOCKS5'] as const)[raw] ?? 'unset';
  }
  if (typeof raw !== 'string') {
    return 'unset';
  }
  const kind = raw.replace(/^pt/i, '').toUpperCase();
  if (kind === 'DEFAULT' || kind === '') {
    return 'unset';
  }
  if (kind === 'DIRECT') {
    return '';
  }
  if (kind === 'HTTP' || kind === 'SOCKS4' || kind === 'SOCKS5') {
    return kind;
  }
  return 'unset';
}

function flattenIni(root: Record<string, unknown>, file: string): Fmd2SettingItem[] {
  const out: Fmd2SettingItem[] = [];
  for (const [key, value] of Object.entries(root)) {
    const slash = key.indexOf('/');
    if (slash > 0 && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      // Flat TJSONIniFile variant: {"section/key": value}
      out.push({ section: key.slice(0, slash), key: key.slice(slash + 1), value });
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Fmd2ParseError(`${file}: settings entry '${key}' is not a section object`);
    }
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof innerValue !== 'string' && typeof innerValue !== 'number' && typeof innerValue !== 'boolean') {
        continue; // absent/null entries keep the app default
      }
      out.push({ section: key, key: innerKey, value: innerValue });
    }
  }
  return out;
}

function looksLikeModulesJson(parsed: unknown): parsed is { ID?: unknown; Settings?: unknown }[] {
  return Array.isArray(parsed) && parsed.every((item): boolean => typeof item === 'object' && item !== null);
}

function parseModulesJson(parsed: { ID?: unknown; Settings?: unknown; Account?: unknown; Cookies?: unknown }[]): Fmd2WebsiteSettings[] {
  const out: Fmd2WebsiteSettings[] = [];
  for (const item of parsed) {
    const moduleId = text(item['ID']).trim();
    if (moduleId === '') {
      continue;
    }
    const settings = item['Settings'];
    let enabled: boolean | null = null;
    let proxy: Fmd2WebsiteSettings['proxy'] = null;
    if (typeof settings === 'object' && settings !== null) {
      const record = settings as Record<string, unknown>;
      const enabledRaw = record['Enabled'];
      if (typeof enabledRaw === 'boolean') {
        enabled = enabledRaw;
      }
      const http = record['HTTP'];
      if (typeof http === 'object' && http !== null) {
        const httpRecord = http as Record<string, unknown>;
        const proxyRaw = httpRecord['Proxy'];
        if (typeof proxyRaw === 'object' && proxyRaw !== null) {
          const proxyRecord = proxyRaw as Record<string, unknown>;
          proxy = {
            kind: normalizeProxyKind(proxyRecord['ProxyType']),
            host: text(proxyRecord['ProxyHost']),
            port: text(proxyRecord['ProxyPort']),
            user: text(proxyRecord['ProxyUsername']),
            pass: text(proxyRecord['ProxyPassword']),
          };
        }
      }
    }
    // Account block: TOP-LEVEL on the entry (jo.Add('Account', jo2) —
    // WebsiteModules.pas:660-668), sealed values decrypted HERE, in
    // memory — they never reach any response surface (preview reports
    // field names only; apply writes them only on explicit opt-in).
    let account: Fmd2WebsiteSettings['account'] = null;
    const accountRaw = item['Account'];
    if (typeof accountRaw === 'object' && accountRaw !== null) {
      const accountRecord = accountRaw as Record<string, unknown>;
      const enabledRaw = accountRecord['Enabled'];
      account = {
        enabled: enabledRaw !== false,
        username: decryptOrEmpty(accountRecord['Username']),
        password: decryptOrEmpty(accountRecord['Password']),
        cookies: decryptOrEmpty(accountRecord['Cookies']),
      };
    }
    const cookieCount = Array.isArray(item['Cookies']) ? item['Cookies'].length : 0;
    out.push({ moduleId, enabled, proxy, account, cookieCount });
  }
  return out;
}

/** DecryptString with the empty-string convention; malformed → ''. */
function decryptOrEmpty(value: unknown): string {
  const sealed = text(value);
  if (sealed === '') {
    return '';
  }
  try {
    return decryptFmd2Secret(sealed);
  } catch {
    // Not actually sealed (or truncated) — treat as absent rather than
    // failing the whole upload; the preview shows the field as missing.
    return '';
  }
}

// ── whole-upload orchestration ───────────────────────────────────────

/**
 * Parse every uploaded part (multipart files or zip entries — the
 * caller pre-expands archives into parts named by their inner path).
 */
export function parseFmd2Upload(parts: readonly UploadPart[]): Fmd2Upload {
  const favorites: Fmd2FavoriteRow[] = [];
  const ledger: Fmd2LedgerRow[] = [];
  let settings: Fmd2SettingItem[] = [];
  let websites: Fmd2WebsiteSettings[] = [];
  const files: string[] = [];
  const ignored: { name: string; reason: string }[] = [];
  let hasFavoritesDb = false;
  let hasLedgerDb = false;

  for (const part of parts) {
    if (part.bytes.length === 0) {
      ignored.push({ name: part.name, reason: 'empty file' });
      continue;
    }
    if (isZipBytes(part.bytes)) {
      try {
        const entries = readZip(part.bytes).filter((entry): boolean => !entry.isDirectory);
        const inner = entries.map((entry): UploadPart => ({ name: `${part.name}!${entry.name}`, bytes: entry.data }));
        const nested = parseFmd2Upload(inner);
        favorites.push(...nested.favorites);
        ledger.push(...nested.ledger);
        settings = mergeSettings(settings, nested.settings);
        websites = mergeWebsites(websites, nested.websites);
        files.push(part.name);
        hasFavoritesDb = hasFavoritesDb || nested.hasFavoritesDb;
        hasLedgerDb = hasLedgerDb || nested.hasLedgerDb;
        for (const miss of nested.ignored) {
          ignored.push({ name: miss.name, reason: miss.reason });
        }
      } catch (err: unknown) {
        if (err instanceof Fmd2ParseError) {
          throw err;
        }
        throw new Fmd2ParseError(
          `${part.name}: unreadable zip (${err instanceof ZipError || err instanceof Error ? err.message : String(err)})`,
        );
      }
      continue;
    }
    if (isSqlite(part.bytes)) {
      withSqlite(part.name, part.bytes, (db): void => {
        const tables = tableNames(db);
        if (tables.has('favorites')) {
          const parsed = parseFavoritesTable(db, part.name);
          favorites.push(...parsed.rows);
          hasFavoritesDb = true;
          files.push(part.name);
          return;
        }
        if (tables.has('downloadedchapters')) {
          ledger.push(...parseLedgerTable(db));
          hasLedgerDb = true;
          files.push(part.name);
          return;
        }
        if (tables.has('downloads')) {
          ignored.push({ name: part.name, reason: 'downloads.db queue — fmd-web manages its own job queue' });
          return;
        }
        ignored.push({ name: part.name, reason: 'no FMD2 tables found (favorites/downloadedchapters)' });
      });
      continue;
    }
    // JSON / name-based classification. Names are HINTS, content rules:
    // a .json-named file MUST parse (a corrupt settings.json is a 400);
    // a .db/.sqlite-named file without the sqlite magic is an explicit
    // corrupt-upload 400; anything else unrecognized is REPORTED, not
    // fatal (stray files may ride along a multipart upload).
    const lower = part.name.toLowerCase();
    const sqliteNamed = lower.endsWith('.sqlite') || lower.endsWith('.db');
    let parsed: unknown;
    try {
      parsed = parseJson(part.name, part.bytes);
    } catch (err: unknown) {
      if (sqliteNamed) {
        throw new Fmd2ParseError(`${part.name}: expected an SQLite database but the bytes are not (corrupt upload?)`);
      }
      if (lower.endsWith('.json')) {
        throw err;
      }
      ignored.push({ name: part.name, reason: 'unrecognized file (not favorites.db / downloadedchapters.db / settings.json / modules.json / config.json)' });
      continue;
    }
    if (Array.isArray(parsed) && looksLikeModulesJson(parsed)) {
      websites = mergeWebsites(websites, parseModulesJson(parsed));
      files.push(part.name);
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      if (root['config'] !== undefined && typeof root['config'] === 'object') {
        ignored.push({ name: part.name, reason: 'config.json bootstrap (db/update URLs) — nothing importable' });
        continue;
      }
      settings = mergeSettings(settings, flattenIni(root, part.name));
      files.push(part.name);
      continue;
    }
    ignored.push({ name: part.name, reason: 'unrecognized file (not favorites.db / downloadedchapters.db / settings.json / modules.json / config.json)' });
  }

  return {
    favorites,
    ledger,
    settings,
    websites,
    files,
    ignored,
    hasFavoritesDb,
    hasLedgerDb,
  };
}

function isZipBytes(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
}

function mergeSettings(current: readonly Fmd2SettingItem[], incoming: readonly Fmd2SettingItem[]): Fmd2SettingItem[] {
  if (incoming.length === 0) {
    return [...current];
  }
  const merged = [...current];
  const index = new Map(current.map((item, i): [string, number] => [`${item.section}/${item.key}`, i]));
  for (const item of incoming) {
    const at = index.get(`${item.section}/${item.key}`);
    if (at === undefined) {
      index.set(`${item.section}/${item.key}`, merged.length);
      merged.push(item);
    } else {
      merged[at] = item;
    }
  }
  return merged;
}

function mergeWebsites(current: readonly Fmd2WebsiteSettings[], incoming: readonly Fmd2WebsiteSettings[]): Fmd2WebsiteSettings[] {
  if (incoming.length === 0) {
    return [...current];
  }
  const merged = [...current];
  const index = new Map(current.map((item, i): [string, number] => [item.moduleId, i]));
  for (const item of incoming) {
    const at = index.get(item.moduleId);
    if (at === undefined) {
      index.set(item.moduleId, merged.length);
      merged.push(item);
    } else {
      merged[at] = item;
    }
  }
  return merged;
}
