import type { ModuleId } from '@fmd/contract';
import type { ModuleStatePersistence } from '../../engine/state/persistence.js';

/**
 * fmd2-modules — the FMD2 `modules.json` → module_state import (D4,
 * one-shot migration). The file format is FMD2's `TWebsiteModules
 * .SaveToFile` (WebsiteModules.pas:635-693): a JSON array, one object per
 * module —
 *   { "ID": "<32-hex>",
 *     "Settings": { "Enabled": bool, ..., "HTTP": { "Cookies": "a=1;b=2",
 *                   "UserAgent": "…", "Proxy": {…} }, … },
 *     "Options": { "<name>": bool | string | int },   // combobox = index
 *     "Account": { "Enabled": bool, "Username": "<enc>", "Password":
 *                 "<enc>", "Status": <ordinal>, "Cookies": "<enc>" },
 *     "Cookies": [ { "Name"…, "Value"…, "Persistent": true, … } ] }
 * (`Options` mirrors SaveToFile's per-kind writes — checkbox bool, edit
 * string, SpinEdit/ComboBox integer; the import stores combobox INDEXES
 * as-is). `Account` is consumed by `fmd2-accounts`, persistent cookie
 * objects are folded into the module cookies text (the §5.3 jar).
 */

/** FMD2 module-id shape (the §5 32-hex join key). */
const MODULE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

/** Import format failure — the CLI reports it and exits nonzero. */
export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/** The `Account` object of a modules.json entry (still-encrypted values). */
export interface Fmd2AccountEntry {
  readonly enabled: boolean;
  /** FMD2 EncryptString ciphertext ('' = unset). */
  readonly usernameCipher: string;
  readonly passwordCipher: string;
  readonly cookiesCipher: string;
  /** TAccountStatus ordinal (0 asUnknown … 3 asInvalid). */
  readonly status: number;
}

/** One parsed modules.json entry (runtime-relevant projection). */
export interface Fmd2ModuleEntry {
  readonly id: ModuleId;
  readonly enabled: boolean;
  /** `Settings.HTTP.Cookies` (';'-joined FMD2 settings-cookie text). */
  readonly cookies: string;
  /** `Settings.HTTP.UserAgent`. */
  readonly userAgent: string;
  /** Option values keyed by name (combobox = integer index). */
  readonly options: Readonly<Record<string, boolean | string | number>>;
  readonly account?: Fmd2AccountEntry;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: JsonValue | undefined): boolean {
  return value === true;
}

function asOptionValue(value: JsonValue | undefined): boolean | string | number | undefined {
  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return undefined;
}

/** Parse (validate + project) a modules.json payload. Duplicate ids and
 * non-32-hex ids are format errors (clean import failure). */
export function parseFmd2ModulesJson(text: string): Fmd2ModuleEntry[] {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (err: unknown) {
    throw new ImportFormatError(`modules.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ImportFormatError('modules.json must be a JSON array of module objects');
  }
  const seen = new Set<string>();
  const entries: Fmd2ModuleEntry[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const raw = parsed[index];
    if (!isRecord(raw)) {
      throw new ImportFormatError(`modules.json [${String(index)}] is not an object`);
    }
    const idRaw = asString(raw['ID']);
    if (!MODULE_ID_PATTERN.test(idRaw)) {
      throw new ImportFormatError(`modules.json [${String(index)}]: ID must be 32-hex (got ${JSON.stringify(idRaw.slice(0, 40))})`);
    }
    const id = idRaw.toLowerCase() as ModuleId;
    if (seen.has(id)) {
      throw new ImportFormatError(`modules.json [${String(index)}]: duplicate module ID ${id}`);
    }
    seen.add(id);

    const settings = isRecord(raw['Settings']) ? raw['Settings'] : undefined;
    const http = isRecord(settings?.['HTTP']) ? settings?.['HTTP'] : undefined;
    const rawOptions = isRecord(raw['Options']) ? raw['Options'] : undefined;
    const options: Record<string, boolean | string | number> = {};
    if (rawOptions !== undefined) {
      for (const [name, value] of Object.entries(rawOptions)) {
        const projected = asOptionValue(value);
        if (projected !== undefined) {
          options[name] = projected;
        }
      }
    }

    const rawAccount = isRecord(raw['Account']) ? raw['Account'] : undefined;
    const account: Fmd2AccountEntry | undefined = rawAccount === undefined
      ? undefined
      : {
          enabled: asBool(rawAccount['Enabled']),
          usernameCipher: asString(rawAccount['Username']),
          passwordCipher: asString(rawAccount['Password']),
          cookiesCipher: asString(rawAccount['Cookies']),
          status: typeof rawAccount['Status'] === 'number' ? Math.trunc(rawAccount['Status']) : 0,
        };

    entries.push({
      id,
      enabled: settings === undefined ? true : asBool(settings['Enabled']),
      // The FMD2 file carries TWO cookie stores: Settings.HTTP.Cookies
      // (manual settings cookies) and the CookieManager persistent list
      // (SaveToFile's "Cookies" array). Both fold into the ONE §9
      // module_state cookies column (the §5.3 jar form, ';'-joined).
      cookies: foldCookieObjects(
        asString(http?.['Cookies']),
        Array.isArray(raw['Cookies']) ? (raw['Cookies'] as JsonValue[]) : [],
      ),
      userAgent: asString(http?.['UserAgent']),
      options,
      ...(account !== undefined ? { account } : {}),
    });
  }
  return entries;
}

/** Fold a modules.json persistent-cookie list into the ';'-joined settings
 * cookie text (the §5.3 jar form) — `name=value` pairs appended in order. */
export function foldCookieObjects(
  cookiesText: string,
  cookieObjects: readonly JsonValue[],
): string {
  const pairs: string[] = [];
  if (cookiesText.trim() !== '') {
    pairs.push(cookiesText.trim());
  }
  for (const cookie of cookieObjects) {
    if (!isRecord(cookie)) {
      continue;
    }
    const name = asString(cookie['Name']);
    if (name === '') {
      continue;
    }
    pairs.push(`${name}=${asString(cookie['Value'])}`);
  }
  return pairs.join(';');
}

export interface ImportModulesSummary {
  /** Entries in the source file. */
  readonly total: number;
  /** module_state rows written (upserts; re-runs stay at `total`). */
  readonly imported: number;
}

/**
 * Import parsed entries into a {@link ModuleStatePersistence} target.
 * FMD2 is the source of truth for the migrated columns (enabled/options/
 * cookies/ua): they REPLACE the target row's values; anything the target
 * keeps outside `PersistedModuleState` (registry columns, storage) is
 * untouched. Idempotent: a re-run produces the same rows (upsert, no
 * duplicates).
 */
export async function importFmd2Modules(
  entries: readonly Fmd2ModuleEntry[],
  target: ModuleStatePersistence,
): Promise<ImportModulesSummary> {
  const existing = await target.loadAll();
  let imported = 0;
  for (const entry of entries) {
    const current = existing[entry.id];
    await target.save(entry.id, {
      cookies: entry.cookies,
      ua: entry.userAgent,
      enabled: entry.enabled,
      options: { ...entry.options },
      storage: { ...(current?.storage ?? {}) },
    });
    imported += 1;
  }
  return { total: entries.length, imported };
}
