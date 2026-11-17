import { join, resolve } from 'node:path';
import { FMD2_REPO, isValidSha } from '../pin.js';

/**
 * Module sync configuration (DESIGN.md §6, §8.5, D9): production syncs run
 * against a PINNED commit only — the pin lives in configuration, and a bump
 * is a deployment act (PR + module-diff report), never an automatic one.
 * `autoBump` therefore defaults to false and any attempt to enable it is a
 * loud config error. `FMD_LUA_DIR` overrides the whole pipeline for local
 * development: the local tree is staged/validated/installed exactly like a
 * fetched one, skipping the network.
 */

export const DEFAULT_FMD2_REPO: string = FMD2_REPO;

/**
 * The FMD2 commit this deployment is validated against (the checkout the
 * corpus + Init-pass goldens were captured from). Overridable via
 * `FMD2_LUA_SHA` — changing it is a deployment act (D9).
 */
export const DEFAULT_FMD2_PIN_SHA: string = '97c903b340d2b0fd82871dba1b0aa5f04a1790e8';

/** Codeload base for zipball downloads; configurable so forks can sync. */
export const DEFAULT_CODELOAD_BASE_URL: string = 'https://codeload.githubusercontent.com';

/**
 * api.github.com base for the tarball fallback endpoint (launch defect
 * (d): codeload zipball 5xx/unreachable → `<base>/repos/<repo>/tarball/
 * <sha>` serves the same pinned commit).
 */
export const DEFAULT_TARBALL_API_BASE_URL: string = 'https://api.github.com';

export interface ModuleSyncConfig {
  /** `owner/name` of the upstream repo. */
  readonly repo: string;
  /** Full 40/64-hex commit SHA the sync may install — nothing else. */
  readonly sha: string;
  /** Zipball base URL (codeload shape: `<base>/<repo>/zip/<ref>`). */
  readonly codeloadBaseUrl: string;
  /** Tarball fallback API base (`<base>/repos/<repo>/tarball/<ref>`). */
  readonly tarballApiBaseUrl: string;
  /** App data dir — the sync installs to `<dataDir>/lua`. */
  readonly dataDir: string;
  /**
   * Local-dir override (`FMD_LUA_DIR`, development only): stage+validate+
   * install this tree, skipping the fetch entirely.
   */
  readonly luaDirOverride: string | undefined;
  /** D9: auto-bump is disabled by default; enabling it is a config error. */
  readonly autoBump: boolean;
}

export class ModuleSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleSyncConfigError';
  }
}

/** codeload zipball URL for a pinned commit. */
export function codeloadZipballUrl(repo: string, sha: string, codeloadBaseUrl: string): string {
  return `${codeloadBaseUrl.replace(/\/+$/, '')}/${repo}/zip/${sha}`;
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

export function loadModuleSyncConfig(
  env: Record<string, string | undefined> = process.env,
): ModuleSyncConfig {
  const autoBumpRaw = envValue(env, 'FMD_SYNC_AUTO_BUMP');
  if (autoBumpRaw !== undefined && ['1', 'true', 'yes', 'on'].includes(autoBumpRaw.toLowerCase())) {
    throw new ModuleSyncConfigError(
      'FMD_SYNC_AUTO_BUMP is refused (D9): upstream pin bumps are deployment acts — ' +
        'bump the pin via configuration/PR with a module-diff report; auto-bump stays disabled.',
    );
  }
  // The only representable value: disabled. Enabling attempts were refused
  // above — keeping the field explicit documents the D9 posture.
  const autoBump = false;

  const repo = envValue(env, 'FMD2_REPO') ?? DEFAULT_FMD2_REPO;
  const sha = envValue(env, 'FMD2_LUA_SHA') ?? DEFAULT_FMD2_PIN_SHA;
  if (!isValidSha(sha)) {
    throw new ModuleSyncConfigError(`FMD2_LUA_SHA must be a full 40/64-hex commit SHA, got: ${sha}`);
  }
  const codeloadBaseUrl = envValue(env, 'FMD2_CODELOAD_URL') ?? DEFAULT_CODELOAD_BASE_URL;
  const tarballApiBaseUrl = envValue(env, 'FMD2_TARBALL_API_BASE') ?? DEFAULT_TARBALL_API_BASE_URL;
  const dataDir = resolve(envValue(env, 'FMD_DATA_DIR') ?? join(process.cwd(), 'data'));
  const luaDirOverride = envValue(env, 'FMD_LUA_DIR');

  return { repo, sha, codeloadBaseUrl, tarballApiBaseUrl, dataDir, luaDirOverride, autoBump };
}
