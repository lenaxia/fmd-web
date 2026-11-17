import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LuaModuleDescriptor, ModuleOptionDescriptor } from '../contract.js';

/**
 * Per-module capability detection (DESIGN.md §5.7/§5.10, D3 — published via
 * /api/modules as known-broken flags). Detection is a STATIC require-graph
 * analysis over the synced lua/ tree — offline, deterministic, and derived
 * from the same sources the Init pass compiles:
 *
 * - `requires_subprocess` (contract flag `fmd.subprocess`): the module's own
 *   source or its `utils/*` require closure pulls `fmd.subprocess` /
 *   `utils.nodejs` (`utils/nodejs.lua:41` `RunCommandHide`). The v1
 *   consumers are exactly TheBlank, RaijinScans, Comix. Deliberately NOT
 *   propagated through `templates/*` — §5.10 Round-4 note: the Madara
 *   family must carry ONLY its `run_html_load` flag (its Duktape
 *   image-decryption path is default-flow), so a template's own
 *   `utils.nodejs` usage never becomes `fmd.subprocess` on its dependents.
 * - `requires_browser` (contract flag `madara.run_html_load`): the module's
 *   `templates/*` require closure reaches a template chunk that calls
 *   `run_html_load` (`templates/Madara.lua:169`, the no-JS fallback) —
 *   ≤76 Madara-family sites, needs the §5.11 browser sidecar profile.
 * - `bypass_python_gated` (contract flag `webdriver.bypass`): the module
 *   declares reliance on the cloudflare workaround in its own source — the
 *   `Cloudflare workaround is required` sentinel or a manual
 *   clearance-cookie option — sites whose only v1 path is the
 *   WebsiteBypass python/webdriver executor
 *   (`websitebypass/cloudflare.lua:166-206`).
 *
 * `events` is the §5.2 event coverage the Init pass declared (`On*` props →
 * `descriptor.eventHandlers`).
 */

/** §5.10 capability flags as published by contract.json (the D3 set). */
export const KNOWN_BROKEN_FLAG_IDS = ['fmd.subprocess', 'madara.run_html_load', 'webdriver.bypass'] as const;
export type KnownBrokenFlagId = (typeof KNOWN_BROKEN_FLAG_IDS)[number];

export interface ModuleCapabilities {
  readonly requires_subprocess: boolean;
  readonly requires_browser: boolean;
  readonly bypass_python_gated: boolean;
  /**
   * The module's own source pulls `fmd.imagepuzzle` (the descramble
   * pipeline: MangaGo, 18Comic, TonarinoYoungJump family, WolfManga,
   * NexusScanlation, Comix, PhiliaScans). Implemented shim ⇒ supported
   * (audit bucket B): the flag is informational — these sites carry NO
   * known-broken flag since fmd.imagepuzzle landed.
   */
  readonly requires_imagepuzzle: boolean;
  /** Own source pulls `fmd.mangafoxwatermark` (FanFox/MangaHere watermark removal). */
  readonly requires_mangafoxwatermark: boolean;
  /** §5.2 events the module declared via Init `On*` props, sorted. */
  readonly events: readonly string[];
  /** Contract CapabilityFlag ids this module carries (the D3 published set). */
  readonly known_broken_flags: readonly KnownBrokenFlagId[];
  /**
   * §6.8: the module can serve the live-scrape browse fallback — it
   * declares BOTH directory events (OnGetDirectoryPageNumber +
   * OnGetNameAndLink), so a site without an FMD2-DB catalog is still
   * browsable through its directory walk.
   */
  readonly live_scrape_fallback: boolean;
}

export interface CapabilityDetection {
  readonly capabilities: ModuleCapabilities;
  /** Requires the module declared in its own source (diagnostics). */
  readonly ownRequires: readonly string[];
}

export interface CapabilityDetectOptions {
  /** The synced lua/ tree root (templates/ + utils/ live here). */
  readonly luaRoot: string;
  /** Chunk loader override (tests); default = readFileSync from luaRoot. */
  readonly loadChunk?: (luaPath: string) => string | undefined;
}

const MAX_REQUIRE_DEPTH = 8;

/** Extract `require 'name'` / `require("name")` names from Lua source. */
export function scanRequires(source: string): string[] {
  const names: string[] = [];
  const pattern = /\brequire\s*\(?\s*['"]([A-Za-z0-9_.-]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function loadLuaChunk(luaPath: string, options: CapabilityDetectOptions): string | undefined {
  if (options.loadChunk !== undefined) {
    return options.loadChunk(luaPath);
  }
  const rootAbs = resolve(options.luaRoot);
  const full = resolve(rootAbs, luaPath);
  if (!full.startsWith(rootAbs)) {
    return undefined;
  }
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * utils/* require closure: true when any chunk in it pulls
 * `fmd.subprocess` / `utils.nodejs` (templates are NOT traversed — see the
 * §5.10 Round-4 attribution note above).
 */
function utilsClosurePullsSubprocess(source: string, options: CapabilityDetectOptions): boolean {
  let visited = '';
  const walk = (chunk: string, depth: number): boolean => {
    if (depth > MAX_REQUIRE_DEPTH) {
      return false;
    }
    for (const name of scanRequires(chunk)) {
      if (name === 'fmd.subprocess' || name === 'utils.nodejs') {
        return true;
      }
      if (!name.startsWith('utils.')) {
        continue;
      }
      const luaPath = `${name.replace(/\./g, '/')}.lua`;
      if (visited.includes(`\0${luaPath}\0`)) {
        continue;
      }
      const next = loadLuaChunk(luaPath, options);
      if (next === undefined) {
        continue;
      }
      visited += `\0${luaPath}\0`;
      if (walk(next, depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return walk(source, 0);
}

/**
 * templates/* require closure: true when a template chunk in it calls
 * `run_html_load` (the no-JS browser fallback, `templates/Madara.lua:169`).
 */
function templatesClosureUsesRunHtmlLoad(source: string, options: CapabilityDetectOptions): boolean {
  let visited = '';
  const walk = (chunk: string, depth: number): boolean => {
    if (depth > MAX_REQUIRE_DEPTH) {
      return false;
    }
    for (const name of scanRequires(chunk)) {
      if (!name.startsWith('templates.')) {
        continue;
      }
      const luaPath = `${name.replace(/\./g, '/')}.lua`;
      if (visited.includes(`\0${luaPath}\0`)) {
        continue;
      }
      const next = loadLuaChunk(luaPath, options);
      if (next === undefined) {
        continue;
      }
      visited += `\0${luaPath}\0`;
      if (next.includes('run_html_load') || walk(next, depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return walk(source, 0);
}

/** The `Cloudflare workaround is required` sentinel + manual-clearance option. */
const BYPASS_PYTHON_SIGNALS: readonly RegExp[] = [
  /Cloudflare workaround is required/,
  /AddOptionEdit\s*\(\s*['"]clearance['"]/,
];

export function detectCapabilities(
  descriptor: Pick<LuaModuleDescriptor, 'eventHandlers'>,
  moduleSource: string,
  options: CapabilityDetectOptions,
): CapabilityDetection {
  const ownRequires = scanRequires(moduleSource);
  const pullsSubprocess = utilsClosurePullsSubprocess(moduleSource, options);
  const usesRunHtmlLoad = templatesClosureUsesRunHtmlLoad(moduleSource, options);
  const bypassPythonGated = BYPASS_PYTHON_SIGNALS.some((signal) => signal.test(moduleSource));

  // Audit bucket B: the descramble/watermark consumers are detected
  // statically from their own source (none reach these libs through
  // utils/templates closures — verified over the FMD2 tree).
  const requiresImagepuzzle = ownRequires.includes('fmd.imagepuzzle');
  const requiresMangafoxwatermark = ownRequires.includes('fmd.mangafoxwatermark');

  const flags: KnownBrokenFlagId[] = [];
  if (pullsSubprocess) {
    flags.push('fmd.subprocess');
  }
  if (usesRunHtmlLoad) {
    flags.push('madara.run_html_load');
  }
  if (bypassPythonGated) {
    flags.push('webdriver.bypass');
  }

  // §6.8: the directory-walk pair — eventHandlers keys are the binding
  // table's On-less event names (§5.2 rows).
  const liveScrapeFallback =
    descriptor.eventHandlers['GetDirectoryPageNumber'] !== undefined &&
    descriptor.eventHandlers['GetNameAndLink'] !== undefined;

  return {
    capabilities: {
      requires_subprocess: pullsSubprocess,
      requires_browser: usesRunHtmlLoad,
      bypass_python_gated: bypassPythonGated,
      requires_imagepuzzle: requiresImagepuzzle,
      requires_mangafoxwatermark: requiresMangafoxwatermark,
      // the descriptor's binding table strips the On prefix (§5.2 rows);
      // the Init-DECLARED prop names are On* — restore them
      events: Object.keys(descriptor.eventHandlers).map((k) => `On${k}`).sort(),
      known_broken_flags: flags,
      live_scrape_fallback: liveScrapeFallback,
    },
    ownRequires,
  };
}

/** One persisted registration (the module_state registry columns, §9). */
export interface RegistrationRecord {
  readonly id: string;
  readonly name: string;
  readonly rootURL: string;
  readonly category: string;
  readonly accountSupport: boolean;
  /** Options schema (§5.1 options API; combobox stores the INDEX). */
  readonly options: readonly ModuleOptionDescriptor[];
  readonly capabilities: ModuleCapabilities;
  /** Module file the registration came from (module_state.file). */
  readonly file: string;
}

export function toRegistration(
  descriptor: LuaModuleDescriptor,
  moduleSource: string,
  options: CapabilityDetectOptions,
): RegistrationRecord {
  return {
    id: descriptor.id,
    name: descriptor.name,
    rootURL: descriptor.rootURL,
    category: descriptor.category,
    accountSupport: descriptor.accountSupport,
    options: descriptor.options,
    capabilities: detectCapabilities(descriptor, moduleSource, options).capabilities,
    file: descriptor.sourceFile,
  };
}
