/**
 * Import-from-FMD2 feature service (two-phase API):
 *
 * - `analyze` parses the uploaded FMD2 files (see parse.ts — PINNED
 *   desktop-source semantics) WITHOUT writing anything and projects a
 *   preview: favorites by site (mapped + unmapped), mappable settings,
 *   detected credential fields (names only — values never echoed).
 * - `apply` performs the confirmed import: favorites upsert idempotently
 *   keyed by module id + RootURL-canonicalized mangaUrl (the ONE
 *   favorites import code path — FavoriteService.import with an offline
 *   seed, MD_ImportToFavorites parity), opt-in per-site credentials,
 *   opt-in settings mapped onto the fmd-web surface; everything the
 *   server does not support is enumerated as 'not imported' (R5:
 *   web-native is the design authority).
 *
 * Uploads arrive multipart (db.sqlite and/or config.json-style JSON
 * files, or a zip of the FMD2 data dir); `apply` accepts the same
 * upload or a server-held analyze token (staged bytes, TTL-bounded).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../api/errors.js';
import type { AccountService } from '../../accounts/account-service.js';
import type { ModuleService, SettingsService } from '../../api/services.js';
import type { FavoriteService } from '../../api/services.js';
import { downloadedChaptersKey } from '../../jobs/library/merge.js';
import { parseFmd2Upload, Fmd2ParseError, type Fmd2Upload, type Fmd2FavoriteRow, type Fmd2SettingItem } from './parse.js';
import { decryptFmd2Secret } from './secrets.js';

/**
 * Parse one upload, mapping every parse failure to the typed 400 the
 * API contract promises (corrupt sqlite / invalid JSON / unreadable
 * zip — never a 500).
 */
function parseUploadOr400(parts: readonly UploadedPart[]): Fmd2Upload {
  try {
    return parseFmd2Upload(parts);
  } catch (err: unknown) {
    if (err instanceof Fmd2ParseError) {
      throw new ApiError(400, 'bad_request', err.message);
    }
    throw err;
  }
}

/** Upload cap: 100 MB per file (DESIGN). */
export const FMD2_IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/** Staged analyze-token lifetime. */
const STAGING_TTL_MS = 15 * 60 * 1000;
/** How many staged uploads may coexist ( runaway-stage guard). */
const STAGING_MAX_ENTRIES = 8;

export interface UploadedPart {
  readonly name: string;
  readonly bytes: Buffer;
}

// ── preview model ────────────────────────────────────────────────────

export interface PreviewSiteGroup {
  /** fmd-web module id when resolved; the raw file id otherwise. */
  readonly moduleId: string;
  /** Resolved site name, or the raw id when unmapped. */
  readonly siteName: string;
  readonly count: number;
  readonly mapped: boolean;
}

export interface PreviewCredentialSite {
  /** fmd-web module id ('proxy' = the global proxy credentials). */
  readonly moduleId: string;
  readonly siteName: string;
  /** Which secret-bearing fields were detected (names only). */
  readonly fields: readonly string[];
}

export interface MappableSettingView {
  readonly key: string;
  readonly label: string;
  /** Where the value comes from (report surface). */
  readonly source: string;
  /** Sanitized human preview of the target value (never a secret). */
  readonly preview: string;
  /** True when applying needs the explicit credential opt-in. */
  readonly requiresCredentials: boolean;
}

export interface NotImportableView {
  readonly source: string;
  readonly reason: string;
}

export interface Fmd2ImportPreview {
  readonly files: readonly string[];
  readonly ignored: readonly NotImportableView[];
  readonly favorites: {
    readonly total: number;
    readonly importable: number;
    readonly bySite: readonly PreviewSiteGroup[];
    readonly unmappedSiteIds: readonly { readonly id: string; readonly count: number }[];
  };
  readonly downloadedLedger: {
    readonly rows: number;
    readonly matched: number;
  };
  readonly settings: {
    readonly mappable: readonly MappableSettingView[];
    readonly notImportable: readonly NotImportableView[];
  };
  readonly credentials: {
    readonly sites: readonly PreviewCredentialSite[];
    readonly globalProxyAuth: boolean;
  };
  readonly analyzeToken: string;
}

export interface Fmd2ApplySelections {
  /** Import favorites (default true — the feature's core). */
  readonly favorites?: boolean | undefined;
  /** Setting keys from the preview's mappable list. */
  readonly settings?: readonly string[] | undefined;
  /** Credential opt-ins: module ids + 'proxy' for the global proxy auth. */
  readonly credentials?: readonly string[] | undefined;
}

export interface Fmd2ApplyReport {
  readonly favorites: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly skipped: readonly { readonly label: string; readonly reason: string }[];
    readonly unmappedSiteIds: readonly { readonly id: string; readonly count: number }[];
    /** Desktop save-to paths deliberately not carried (server paths differ). */
    readonly saveToPathsDropped: number;
  };
  readonly downloadedLedgerRowsApplied: number;
  readonly credentials: {
    readonly imported: readonly { readonly moduleId: string; readonly fields: readonly string[] }[];
    readonly skipped: readonly { readonly moduleId: string; readonly reason: string }[];
  };
  readonly settings: {
    readonly applied: readonly { readonly key: string; readonly detail: string }[];
    readonly notImportable: readonly NotImportableView[];
  };
}

// ── module resolution ────────────────────────────────────────────────

interface ModuleIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly rootURL: string;
}

interface ModuleIndex {
  readonly byIdLower: Map<string, ModuleIndexEntry>;
  readonly byNameLower: Map<string, ModuleIndexEntry>;
  readonly byHostLower: Map<string, ModuleIndexEntry>;
}

export function buildModuleIndex(modules: ModuleService): ModuleIndex {
  const list = modules.list();
  const byIdLower = new Map<string, ModuleIndexEntry>();
  const byNameLower = new Map<string, ModuleIndexEntry>();
  const byHostLower = new Map<string, ModuleIndexEntry>();
  for (const module of list) {
    const entry: ModuleIndexEntry = { id: module.id, name: module.name, rootURL: module.rootURL };
    byIdLower.set(module.id.toLowerCase(), entry);
    byNameLower.set(module.name.toLowerCase(), entry);
    try {
      const host = new URL(module.rootURL).hostname.toLowerCase();
      if (!byHostLower.has(host)) {
        byHostLower.set(host, entry);
      }
    } catch {
      // malformed rootURL — the id/name indices still carry the module
    }
  }
  return { byIdLower, byNameLower, byHostLower };
}

/**
 * Resolve one file-side site reference to the installed catalog:
 * moduleid first, then the module NAME, then the RootURL host —
 * frmImportFavorites' LocateModule / LocateModuleByHost parity. A raw
 * id that resolves to nothing (dead/renamed/typo'd catalog id, e.g. a
 malformed ColorcitoScan-style id) stays unmapped; it is SURFACED and
 never crashes anything (the v0.3.1 search-500 lesson).
 */
export function resolveModule(index: ModuleIndex, ref: string): ModuleIndexEntry | undefined {
  const trimmed = ref.trim();
  if (trimmed === '') {
    return undefined;
  }
  const byId = index.byIdLower.get(trimmed.toLowerCase());
  if (byId !== undefined) {
    return byId;
  }
  const byName = index.byNameLower.get(trimmed.toLowerCase());
  if (byName !== undefined) {
    return byName;
  }
  const bareHost = trimmed.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return index.byHostLower.get(bareHost);
}

/**
 * The v0.3.1 /api/info + enqueue canonicalization: FMD2 stores links
 * HOST-RELATIVE (§5.8 RemoveHostFromURLsPair); the canonical absolute
 * form is `new URL(link, rootURL)` — the same key the downloaded-
 * chapters ledger and /api/info use.
 */
export function canonicalizeMangaUrl(rootURL: string, link: string): string | null {
  if (/^https?:\/\//i.test(link)) {
    return link;
  }
  if (rootURL === '') {
    return null;
  }
  try {
    return new URL(link, rootURL).toString();
  } catch {
    return null;
  }
}

interface ResolvedFavorite {
  readonly row: Fmd2FavoriteRow;
  readonly module: ModuleIndexEntry;
  readonly url: string;
  /** LowerCase(fileModuleId + fileLink) — the downloadedchapters.db key. */
  readonly sourceId: string;
}

export function resolveFavorites(
  upload: Fmd2Upload,
  index: ModuleIndex,
): {
  readonly resolved: ResolvedFavorite[];
  readonly unmapped: readonly { row: Fmd2FavoriteRow; reason: string }[];
} {
  const resolved: ResolvedFavorite[] = [];
  const unmapped: { row: Fmd2FavoriteRow; reason: string }[] = [];
  const seen = new Map<string, ResolvedFavorite>();
  for (const row of upload.favorites) {
    const module = resolveModule(index, row.moduleId);
    if (module === undefined) {
      unmapped.push({ row, reason: 'site not installed (unknown catalog id)' });
      continue;
    }
    if (row.link.trim() === '') {
      unmapped.push({ row, reason: 'missing link' });
      continue;
    }
    const url = canonicalizeMangaUrl(module.rootURL, row.link);
    if (url === null) {
      unmapped.push({ row, reason: 'malformed link (cannot join against the site root URL)' });
      continue;
    }
    const entry: ResolvedFavorite = { row, module, url, sourceId: downloadedChaptersKey(row.moduleId, row.link) };
    const key = downloadedChaptersKey(module.id, url);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, entry);
      resolved.push(entry);
      continue;
    }
    // In-file duplicate: keep the first, fold the duplicate's chapters.
    void prior;
    unmapped.push({ row, reason: 'duplicate of another entry for the same manga' });
  }
  return { resolved, unmapped };
}

// ── settings mapping (R5: web-native surface is the authority) ───────

interface SettingGet {
  (section: string, key: string): string | number | boolean | undefined;
}

function settingGetter(items: readonly Fmd2SettingItem[]): SettingGet {
  const map = new Map<string, string | number | boolean>();
  for (const item of items) {
    map.set(`${item.section.toLowerCase()}/${item.key.toLowerCase()}`, item.value);
  }
  return (section, key): string | number | boolean | undefined =>
    map.get(`${section.toLowerCase()}/${key.toLowerCase()}`);
}

function asBool(value: string | number | boolean | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const lowered = value.toLowerCase();
  if (lowered === '1' || lowered === 'true') {
    return true;
  }
  if (lowered === '0' || lowered === 'false' || lowered === '') {
    return false;
  }
  return undefined;
}

function asInt(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : undefined;
}

const COMPRESS_FORMATS = ['None', 'zip', 'cbz', 'pdf', 'epub'] as const;

interface MappedSetting {
  readonly key: string;
  readonly label: string;
  readonly source: string;
  readonly preview: string;
  readonly requiresCredentials: boolean;
  /** Apply closure over the parsed values. */
  readonly apply: (deps: ApplyDeps, credentialConsent: boolean) => string;
}

interface ProxyValues {
  readonly enabled: boolean;
  readonly type: 'HTTP' | 'SOCKS4' | 'SOCKS5';
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly pass: string;
}

function readProxy(get: SettingGet): ProxyValues | undefined {
  const useProxy = asBool(get('connections', 'UseProxy'));
  if (useProxy !== true) {
    return undefined;
  }
  const rawType = String(get('connections', 'ProxyType') ?? 'HTTP').toUpperCase();
  const type = rawType === 'SOCKS4' || rawType === 'SOCKS5' ? rawType : 'HTTP';
  const host = String(get('connections', 'Host') ?? '');
  if (host === '') {
    return undefined;
  }
  return {
    enabled: true,
    type,
    host,
    port: String(get('connections', 'Port') ?? ''),
    user: decryptQuiet(String(get('connections', 'User') ?? '')),
    pass: decryptQuiet(String(get('connections', 'Pass') ?? '')),
  };
}

function decryptQuiet(sealed: string): string {
  if (sealed === '') {
    return '';
  }
  try {
    return decryptFmd2Secret(sealed);
  } catch {
    return '';
  }
}

interface ApplyDeps {
  readonly settings: SettingsService;
  readonly modules: ModuleService;
  readonly accounts?: AccountService;
}

function buildMappedSettings(upload: Fmd2Upload, index: ModuleIndex): {
  readonly mappable: MappedSetting[];
  readonly notImportable: NotImportableView[];
} {
  const get = settingGetter(upload.settings);
  const mappable: MappedSetting[] = [];
  const notImportable: NotImportableView[] = [];
  const saw = (section: string, key: string): boolean => get(section, key) !== undefined;

  // ── global proxy ([connections]) ─────────────────────────────────
  const proxy = readProxy(get);
  if (proxy !== undefined) {
    mappable.push({
      key: 'proxy',
      label: 'Global proxy',
      source: 'settings.json [connections] UseProxy, ProxyType, Host, Port',
      preview: `${proxy.type} ${proxy.host}${proxy.port !== '' ? `:${proxy.port}` : ''}${
        proxy.user !== '' ? ' (with login)' : ''
      }`,
      requiresCredentials: proxy.user !== '' || proxy.pass !== '',
      apply: (deps, consent): string => {
        const user = consent ? proxy.user : '';
        const pass = consent ? proxy.pass : '';
        deps.settings.setProxy({ type: proxy.type, host: proxy.host, port: proxy.port, user, pass });
        return consent
          ? `proxy set to ${proxy.type} ${proxy.host}:${proxy.port} (login imported)`
          : `proxy set to ${proxy.type} ${proxy.host}:${proxy.port} (login NOT imported — credentials were not opted in)`;
      },
    });
  } else if (saw('connections', 'UseProxy')) {
    notImportable.push({ source: 'settings.json [connections] UseProxy', reason: 'proxy disabled in the file — nothing to import' });
  }

  // ── performance ([connections] subset) ───────────────────────────
  const timeout = asInt(get('connections', 'ConnectionTimeout'));
  const retry = asInt(get('connections', 'Retry'));
  const parallel = asInt(get('connections', 'NumberOfTasks'));
  const threads = asInt(get('connections', 'NumberOfThreadsPerTask'));
  const perfParts: string[] = [];
  if (timeout !== undefined && timeout >= 1 && timeout <= 300) {
    perfParts.push(`timeout ${String(timeout)}s`);
  }
  if (retry !== undefined && retry >= 0 && retry <= 10) {
    perfParts.push(`retry ${String(retry)}`);
  }
  if (parallel !== undefined && parallel >= 1 && parallel <= 8) {
    perfParts.push(`${String(parallel)} parallel chapters`);
  }
  if (threads !== undefined && threads >= 1 && threads <= 8) {
    perfParts.push(`${String(threads)} threads/chapter`);
  }
  if (perfParts.length > 0) {
    mappable.push({
      key: 'performance',
      label: 'Performance (connections subset)',
      source: 'settings.json [connections] ConnectionTimeout, Retry, NumberOfTasks, NumberOfThreadsPerTask',
      preview: perfParts.join(', '),
      requiresCredentials: false,
      apply: (deps): string => {
        const current = deps.settings.get().performance;
        deps.settings.setPerformance({
          requestTimeoutSeconds: timeout !== undefined && timeout >= 1 && timeout <= 300 ? timeout : current.requestTimeoutSeconds,
          retryCount: retry !== undefined && retry >= 0 && retry <= 10 ? retry : current.retryCount,
          parallelChapters: parallel !== undefined && parallel >= 1 && parallel <= 8 ? parallel : current.parallelChapters,
          threadsPerChapter: threads !== undefined && threads >= 1 && threads <= 8 ? threads : current.threadsPerChapter,
        });
        return `performance set (${perfParts.join(', ')})`;
      },
    });
  }
  for (const [value, name] of [
    [timeout, 'ConnectionTimeout'],
    [retry, 'Retry'],
    [parallel, 'NumberOfTasks'],
    [threads, 'NumberOfThreadsPerTask'],
  ] as const) {
    if (value !== undefined && !(
      (name === 'ConnectionTimeout' && value >= 1 && value <= 300) ||
      (name === 'Retry' && value >= 0 && value <= 10) ||
      (name === 'NumberOfTasks' && value >= 1 && value <= 8) ||
      (name === 'NumberOfThreadsPerTask' && value >= 1 && value <= 8)
    )) {
      notImportable.push({ source: `settings.json [connections] ${name}`, reason: `value ${String(value)} outside the supported range` });
    }
  }

  // ── output defaults ([saveto] subset) ────────────────────────────
  const compress = asInt(get('saveto', 'Compress'));
  const unicode = asBool(get('saveto', 'ChangeUnicodeCharacter'));
  const unicodeChar = String(get('saveto', 'ChangeUnicodeCharacterStr') ?? '');
  const removeName = asBool(get('saveto', 'RemoveMangaNameFromChapter'));
  const outputParts: string[] = [];
  if (compress !== undefined && compress >= 1 && compress <= 4) {
    outputParts.push(`format ${COMPRESS_FORMATS[compress]}`);
  } else if (compress === 0) {
    notImportable.push({ source: 'settings.json [saveto] Compress', reason: "'None' (loose images) is not a server output mode" });
  }
  if (unicode === true) {
    outputParts.push(`unicode replacement${unicodeChar !== '' ? ` '${unicodeChar}'` : ''}`);
  }
  if (removeName === true) {
    outputParts.push('remove manga name from chapter filenames');
  }
  if (outputParts.length > 0) {
    mappable.push({
      key: 'output',
      label: 'Output defaults',
      source: 'settings.json [saveto] Compress, ChangeUnicodeCharacter(Str), RemoveMangaNameFromChapter',
      preview: outputParts.join(', '),
      requiresCredentials: false,
      apply: (deps): string => {
        const current = deps.settings.get().output;
        deps.settings.setOutput({
          ...current,
          ...(compress !== undefined && compress >= 1 && compress <= 4
            ? { format: COMPRESS_FORMATS[compress] as 'zip' | 'cbz' | 'pdf' | 'epub' }
            : {}),
          ...(unicode !== undefined ? { unicodeReplacement: unicode } : {}),
          ...(unicode === true && unicodeChar !== '' ? { unicodeReplacementChar: unicodeChar.slice(0, 1) } : {}),
          ...(removeName !== undefined ? { removeMangaName: removeName } : {}),
        });
        return `output defaults set (${outputParts.join(', ')})`;
      },
    });
  }

  // ── favorites scheduler ([update]) ───────────────────────────────
  const startup = asBool(get('update', 'AutoCheckFavStartup'));
  const intervalOn = asBool(get('update', 'AutoCheckFavInterval'));
  const intervalMinutes = asInt(get('update', 'AutoCheckFavIntervalMinutes'));
  if (startup !== undefined || intervalOn !== undefined) {
    const minutes = intervalOn === false ? 0 : intervalMinutes ?? 60;
    mappable.push({
      key: 'favorites-scheduler',
      label: 'Favorites check schedule',
      source: 'settings.json [update] AutoCheckFavStartup, AutoCheckFavInterval(Minutes)',
      preview: `${startup !== false ? 'check at startup' : 'no startup check'}, every ${String(minutes)} min`,
      requiresCredentials: false,
      apply: (deps): string => {
        const current = deps.settings.getFavoritesSettings();
        deps.settings.setFavoritesSettings({
          checkAtStartup: startup ?? current.checkAtStartup,
          intervalMinutes: Math.min(Math.max(minutes, 0), 20160),
        });
        return `favorites scheduler set (${startup !== false ? 'startup check on' : 'startup check off'}, every ${String(Math.min(Math.max(minutes, 0), 20160))} min)`;
      },
    });
  }

  // ── favorites auto-download default ([update]) ───────────────────
  const autoDownload = asBool(get('update', 'AutoCheckFavAutoDownload'));
  if (autoDownload !== undefined) {
    mappable.push({
      key: 'favorites-auto-download',
      label: 'Auto-download new chapters (applies to imported favorites)',
      source: 'settings.json [update] AutoCheckFavAutoDownload',
      preview: autoDownload ? 'on' : 'off',
      requiresCredentials: false,
      apply: (): string => (autoDownload ? 'imported favorites will auto-download new chapters' : 'auto-download stays off'),
    });
  }

  // ── per-website settings (modules.json) ──────────────────────────
  const enabledSites = upload.websites.filter((site): boolean => site.enabled !== null && resolveModule(index, site.moduleId) !== undefined);
  if (enabledSites.length > 0) {
    mappable.push({
      key: 'website-enabled',
      label: `Website enabled states (${String(enabledSites.length)} sites)`,
      source: 'modules.json Settings.Enabled',
      preview: `${String(enabledSites.filter((site): boolean => site.enabled === true).length)} enabled / ${String(enabledSites.filter((site): boolean => site.enabled === false).length)} disabled`,
      requiresCredentials: false,
      apply: (deps): string => {
        let applied = 0;
        for (const site of enabledSites) {
          const module = resolveModule(index, site.moduleId);
          if (module === undefined) {
            continue;
          }
          deps.modules.update(module.id, { enabled: site.enabled === true });
          applied += 1;
        }
        return `${String(applied)} website enable states applied`;
      },
    });
  }
  const proxySites = upload.websites.filter(
    (site): boolean => site.proxy !== null && site.proxy.kind !== 'unset' && resolveModule(index, site.moduleId) !== undefined,
  );
  if (proxySites.length > 0) {
    mappable.push({
      key: 'website-proxy',
      label: `Per-website proxy overrides (${String(proxySites.length)} sites)`,
      source: 'modules.json Settings.HTTP.Proxy',
      preview: proxySites
        .slice(0, 4)
        .map((site): string => `${resolveModule(index, site.moduleId)?.name ?? site.moduleId}: ${site.proxy?.kind ?? ''}`)
        .join(', ') + (proxySites.length > 4 ? ', …' : ''),
      requiresCredentials: proxySites.some((site): boolean => (site.proxy?.user ?? '') !== '' || (site.proxy?.pass ?? '') !== ''),
      apply: (deps, consent): string => {
        let applied = 0;
        for (const site of proxySites) {
          const module = resolveModule(index, site.moduleId);
          if (module === undefined) {
            continue;
          }
          const proxy = site.proxy;
          if (proxy === null || proxy.kind === 'unset') {
            continue;
          }
          if (proxy.kind === '') {
            deps.modules.update(module.id, { proxy: null });
            applied += 1;
            continue;
          }
          const user = consent ? proxy.user : '';
          const pass = consent ? proxy.pass : '';
          deps.modules.update(module.id, { proxy: { type: proxy.kind, host: proxy.host, port: proxy.port, user, pass } });
          applied += 1;
        }
        return `${String(applied)} per-website proxy overrides applied`;
      },
    });
  }

  // ── present-but-unmappable enumeration (report surface) ─────────
  const KNOWN = new Set([
    'connections/useproxy', 'connections/proxytype', 'connections/host', 'connections/port', 'connections/user', 'connections/pass',
    'connections/connectiontimeout', 'connections/retry', 'connections/numberoftasks', 'connections/numberofthreadsperTask'.toLowerCase(),
    'saveto/compress', 'saveto/changeunicodecharacter', 'saveto/changeunicodecharacterstr', 'saveto/removemanganamefromchapter',
    'update/autocheckfavstartup', 'update/autocheckfavinterval', 'update/autocheckfavintervalminutes', 'update/autocheckfavautodownload',
  ]);
  const REASONS: readonly (readonly [RegExp, string])[] = [
    [/^saveto\/saveto$/, 'desktop download path — the server manages its own library layout'],
    [/^saveto\/pdfquality$/, 'PDF re-encode quality is deferred (the packer streams pages untouched)'],
    [/^saveto\//, 'desktop Save-to option outside the server output surface'],
    [/^connections\/defaultuseragent$/, 'global user-agent override is not a server setting'],
    [/^connections\//, 'desktop connection tuning outside the server performance group'],
    [/^update\//, 'desktop update option outside the server scheduler surface'],
    [/^favorites\//, 'desktop favorites option outside the server surface'],
    [/^droptarget\//, 'desktop drop-target widget — no web equivalent'],
    [/^downloadlist\//, 'desktop list-view preference'],
    [/^filters\//, 'desktop filter-panel layout'],
    [/^general\//, 'desktop shell preference'],
  ];
  for (const item of upload.settings) {
    const key = `${item.section.toLowerCase()}/${item.key.toLowerCase()}`;
    if (KNOWN.has(key)) {
      continue;
    }
    const reason = REASONS.find(([pattern]): boolean => pattern.test(key))?.[1];
    notImportable.push({
      source: `settings.json [${item.section}] ${item.key}`,
      reason: reason ?? 'no fmd-web equivalent (R5: web-native surface is the authority)',
    });
  }

  return { mappable, notImportable };
}

// ── credentials preview ─────────────────────────────────────────────

function credentialSites(upload: Fmd2Upload, index: ModuleIndex): {
  readonly sites: PreviewCredentialSite[];
  readonly globalProxyAuth: boolean;
} {
  const sites: PreviewCredentialSite[] = [];
  for (const website of upload.websites) {
    const module = resolveModule(index, website.moduleId);
    if (module === undefined) {
      continue;
    }
    const fields: string[] = [];
    const account = website.account;
    if (account !== null) {
      if (account.username !== '') {
        fields.push('username');
      }
      if (account.password !== '') {
        fields.push('password');
      }
      if (account.cookies !== '') {
        fields.push('cookies');
      }
    }
    if (website.cookieCount > 0) {
      fields.push(`site cookies (${String(website.cookieCount)})`);
    }
    if (website.proxy !== null && (website.proxy.user !== '' || website.proxy.pass !== '')) {
      fields.push('proxy login');
    }
    if (fields.length > 0) {
      sites.push({ moduleId: module.id, siteName: module.name, fields });
    }
  }
  return { sites, globalProxyAuth: false };
}

// ── staging (analyze → apply token) ─────────────────────────────────

interface StagedUpload {
  readonly dir: string;
  readonly names: readonly string[];
  readonly expiresAt: number;
}

export class Fmd2ImportStaging {
  private readonly entries = new Map<string, StagedUpload>();

  public constructor() {
    const sweep = setInterval((): void => this.sweep(), 60 * 1000);
    sweep.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, staged] of this.entries) {
      if (staged.expiresAt <= now) {
        this.drop(token);
      }
    }
  }

  private drop(token: string): void {
    const staged = this.entries.get(token);
    if (staged !== undefined) {
      rmSync(staged.dir, { recursive: true, force: true });
      this.entries.delete(token);
    }
  }

  public stage(parts: readonly UploadedPart[]): string {
    // Evict oldest when full (bounded disk footprint).
    while (this.entries.size >= STAGING_MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b): number => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest === undefined) {
        break;
      }
      this.drop(oldest[0]);
    }
    const token = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), 'fmd2-import-stage-'));
    const names: string[] = [];
    parts.forEach((part, index): void => {
      const safe = `part-${String(index).padStart(3, '0')}`;
      writeFileSync(join(dir, safe), part.bytes, { flag: 'wx' });
      names.push(part.name);
    });
    this.entries.set(token, { dir, names, expiresAt: Date.now() + STAGING_TTL_MS });
    return token;
  }

  public load(token: string): UploadedPart[] {
    const staged = this.entries.get(token);
    if (staged === undefined) {
      throw new ApiError(404, 'not_found', 'unknown or expired analyze token — upload the file again');
    }
    if (staged.expiresAt <= Date.now()) {
      this.drop(token);
      throw new ApiError(404, 'not_found', 'analyze token expired — upload the file again');
    }
    return staged.names.map((name, index): UploadedPart => ({
      name,
      bytes: readFileSync(join(staged.dir, `part-${String(index).padStart(3, '0')}`)),
    }));
  }
}

// ── the service facade ──────────────────────────────────────────────

export class Fmd2ImportService {
  private readonly staging = new Fmd2ImportStaging();

  public constructor(
    private readonly modules: ModuleService,
    private readonly settings: SettingsService,
    private readonly favorites: FavoriteService,
    private readonly accounts?: AccountService,
  ) {}

  /** Reload the staged upload behind an analyze token (apply route). */
  public stagedParts(token: string): UploadedPart[] {
    return this.staging.load(token);
  }

  public analyze(parts: readonly UploadedPart[]): Fmd2ImportPreview {
    const index = buildModuleIndex(this.modules);
    const upload = parseUploadOr400(parts);
    if (upload.files.length === 0) {
      throw new ApiError(400, 'bad_request', 'no recognizable FMD2 file in the upload (expected favorites.db / downloadedchapters.db / settings.json / modules.json / config.json or a zip of them)');
    }
    const { resolved, unmapped } = resolveFavorites(upload, index);
    const bySite = new Map<string, PreviewSiteGroup>();
    const unmappedIds = new Map<string, number>();
    for (const entry of resolved) {
      const group = bySite.get(entry.module.id);
      if (group === undefined) {
        bySite.set(entry.module.id, { moduleId: entry.module.id, siteName: entry.module.name, count: 1, mapped: true });
      } else {
        bySite.set(entry.module.id, { ...group, count: group.count + 1 });
      }
    }
    for (const miss of unmapped) {
      if (miss.reason.startsWith('site not installed')) {
        const id = miss.row.moduleId;
        unmappedIds.set(id, (unmappedIds.get(id) ?? 0) + 1);
      }
    }
    const ledgerById = new Map(upload.ledger.map((row): [string, string] => [row.id, row.chapters]));
    let ledgerMatched = 0;
    for (const entry of resolved) {
      if (ledgerById.has(entry.sourceId)) {
        ledgerMatched += 1;
      }
    }
    const { mappable, notImportable } = buildMappedSettings(upload, index);
    const credentials = credentialSites(upload, index);
    const globalProxyAuth = mappable.some((setting): boolean => setting.key === 'proxy' && setting.requiresCredentials);
    const token = this.staging.stage(parts);
    return {
      files: upload.files,
      ignored: upload.ignored.map((entry): NotImportableView => ({ source: entry.name, reason: entry.reason })),
      favorites: {
        total: upload.favorites.length,
        importable: resolved.length,
        bySite: [...bySite.values()].sort((a, b): number => b.count - a.count),
        unmappedSiteIds: [...unmappedIds.entries()]
          .map(([id, count]): { id: string; count: number } => ({ id, count }))
          .sort((a, b): number => b.count - a.count),
      },
      downloadedLedger: { rows: upload.ledger.length, matched: ledgerMatched },
      settings: {
        mappable: mappable.map(({ key, label, source, preview, requiresCredentials }): MappableSettingView => ({
          key,
          label,
          source,
          preview,
          requiresCredentials,
        })),
        notImportable,
      },
      credentials: { sites: credentials.sites, globalProxyAuth },
      analyzeToken: token,
    };
  }

  public async apply(
    parts: readonly UploadedPart[],
    selections: Fmd2ApplySelections,
  ): Promise<Fmd2ApplyReport> {
    const index = buildModuleIndex(this.modules);
    const upload = parseUploadOr400(parts);
    const { resolved, unmapped } = resolveFavorites(upload, index);
    const ledgerById = new Map(upload.ledger.map((row): [string, string] => [row.id, row.chapters]));
    const credentialConsent = new Set(selections.credentials ?? []);
    const settingKeys = new Set(selections.settings ?? []);
    const importFavorites = selections.favorites !== false;

    // ── favorites (the ONE import path: FavoriteService.import + seed) ──
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let ledgerRowsApplied = 0;
    let saveToPathsDropped = 0;
    const skipped: { label: string; reason: string }[] = [];
    const unmappedSiteIds = new Map<string, number>();
    const autoDownloadDefault = settingKeys.has('favorites-auto-download')
      ? asBool(settingGetter(upload.settings)('update', 'AutoCheckFavAutoDownload')) === true
      : undefined;
    if (importFavorites) {
      for (const entry of resolved) {
        const { importOutcome } = await this.favorites.import({
          moduleId: entry.module.id,
          url: entry.url,
          ...(entry.row.title !== '' ? { title: entry.row.title } : {}),
          ...(autoDownloadDefault !== undefined ? { autoDownload: autoDownloadDefault } : {}),
          seed: {
            ...(entry.row.status !== '' ? { status: entry.row.status } : {}),
            ...(entry.row.currentChapter !== null ? { currentChapter: entry.row.currentChapter } : {}),
            ...(entry.row.downloadedChapterList !== '' ? { downloadedChapterList: entry.row.downloadedChapterList } : {}),
            enabled: entry.row.enabled,
            ...(entry.row.dateAddedMs !== null ? { dateAdded: entry.row.dateAddedMs } : {}),
            ...(ledgerById.has(entry.sourceId)
              ? { ledgerChapters: ledgerById.get(entry.sourceId) ?? '' }
              : {}),
          },
        });
        if (importOutcome === 'created') {
          created += 1;
        } else if (importOutcome === 'updated') {
          updated += 1;
        } else {
          unchanged += 1;
        }
        if (ledgerById.has(entry.sourceId)) {
          ledgerRowsApplied += 1;
        }
        if (entry.row.saveTo !== '') {
          saveToPathsDropped += 1;
        }
      }
    }

    for (const miss of unmapped) {
      const label = `${miss.row.title !== '' ? miss.row.title : miss.row.link} <${miss.row.moduleId}${miss.row.link}>`;
      skipped.push({ label, reason: miss.reason });
      if (miss.reason.startsWith('site not installed')) {
        unmappedSiteIds.set(miss.row.moduleId, (unmappedSiteIds.get(miss.row.moduleId) ?? 0) + 1);
      }
    }

    // ── credentials (opt-in only) ───────────────────────────────────
    const importedCredentials: { moduleId: string; fields: string[] }[] = [];
    const skippedCredentials: { moduleId: string; reason: string }[] = [];
    for (const website of upload.websites) {
      const module = resolveModule(index, website.moduleId);
      if (module === undefined || website.account === null) {
        continue;
      }
      const hasAny =
        website.account.username !== '' || website.account.password !== '' || website.account.cookies !== '';
      if (!hasAny) {
        continue;
      }
      if (!credentialConsent.has(module.id)) {
        continue; // not opted in — silently out of scope, preview said so
      }
      if (this.accounts === undefined) {
        skippedCredentials.push({ moduleId: module.id, reason: 'accounts store unavailable on this server' });
        continue;
      }
      const fields: string[] = [];
      if (website.account.username !== '') {
        fields.push('username');
      }
      if (website.account.password !== '') {
        fields.push('password');
      }
      if (website.account.cookies !== '') {
        fields.push('cookies');
      }
      this.accounts.upsert({
        moduleId: module.id,
        username: website.account.username,
        ...(website.account.password !== '' ? { password: website.account.password } : {}),
        ...(website.account.cookies !== '' ? { cookies: website.account.cookies } : {}),
        enabled: website.account.enabled,
      });
      importedCredentials.push({ moduleId: module.id, fields });
    }

    // ── settings (only the supported surface; everything else listed) ──
    const { mappable, notImportable } = buildMappedSettings(upload, index);
    const appliedSettings: { key: string; detail: string }[] = [];
    const deps: ApplyDeps = {
      settings: this.settings,
      modules: this.modules,
      ...(this.accounts !== undefined ? { accounts: this.accounts } : {}),
    };
    const proxyConsent = credentialConsent.has('proxy');
    for (const setting of mappable) {
      if (!settingKeys.has(setting.key)) {
        continue;
      }
      appliedSettings.push({ key: setting.key, detail: setting.apply(deps, proxyConsent) });
    }

    return {
      favorites: {
        created,
        updated,
        unchanged,
        skipped,
        unmappedSiteIds: [...unmappedSiteIds.entries()]
          .map(([id, count]): { id: string; count: number } => ({ id, count }))
          .sort((a, b): number => b.count - a.count),
        saveToPathsDropped,
      },
      downloadedLedgerRowsApplied: ledgerRowsApplied,
      credentials: { imported: importedCredentials, skipped: skippedCredentials },
      settings: { applied: appliedSettings, notImportable },
    };
  }
}
