import { describe, expect, it } from 'vitest';
import {
  codeloadZipballUrl,
  DEFAULT_CODELOAD_BASE_URL,
  DEFAULT_FMD2_PIN_SHA,
  DEFAULT_FMD2_REPO,
  loadModuleSyncConfig,
  ModuleSyncConfigError,
  expectedZipballRoot,
  createModuleSyncService,
  type ModuleSyncConfig,
} from '../../../src/index.js';

/**
 * Config defaults + the D9 posture: auto-bump is DISABLED by default and
 * attempts to enable it are loud config errors — a pin bump is a
 * deployment act, never something the sync service does on its own.
 */

function baseConfig(overrides: Partial<ModuleSyncConfig> = {}): ModuleSyncConfig {
  return {
    repo: DEFAULT_FMD2_REPO,
    sha: DEFAULT_FMD2_PIN_SHA,
    codeloadBaseUrl: DEFAULT_CODELOAD_BASE_URL,
    dataDir: '/tmp/unused',
    luaDirOverride: undefined,
    autoBump: false,
    ...overrides,
  };
}

describe('module sync config (D9 upstream trust)', (): void => {
  it('defaults: pinned FMD2 repo/SHA, codeload base, auto-bump disabled, no local override', (): void => {
    const config = loadModuleSyncConfig({});
    expect(config.repo).toBe('dazedcat19/FMD2');
    expect(config.sha).toBe(DEFAULT_FMD2_PIN_SHA);
    expect(config.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(config.codeloadBaseUrl).toBe('https://codeload.githubusercontent.com');
    expect(config.autoBump).toBe(false);
    expect(config.luaDirOverride).toBeUndefined();
  });

  it('refuses to enable auto-bump via env — bumping is a deployment act (D9)', (): void => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(() => loadModuleSyncConfig({ FMD_SYNC_AUTO_BUMP: value })).toThrow(ModuleSyncConfigError);
      expect(() => loadModuleSyncConfig({ FMD_SYNC_AUTO_BUMP: value })).toThrow(/D9/);
    }
    // explicit "disabled" values stay accepted
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(loadModuleSyncConfig({ FMD_SYNC_AUTO_BUMP: value }).autoBump).toBe(false);
    }
  });

  it('refuses a constructed autoBump=true config at service creation', (): void => {
    expect(() => createModuleSyncService(baseConfig({ autoBump: true }))).toThrow(ModuleSyncConfigError);
    expect(() => createModuleSyncService(baseConfig({ autoBump: true }))).toThrow(/auto-bump/);
    expect(() => createModuleSyncService(baseConfig({ autoBump: false }))).not.toThrow();
  });

  it('reads env overrides: repo, pin SHA, codeload base, data dir, FMD_LUA_DIR', (): void => {
    const sha = 'a'.repeat(40);
    const config = loadModuleSyncConfig({
      FMD2_REPO: 'fork-owner/FMD2',
      FMD2_LUA_SHA: sha,
      FMD2_CODELOAD_URL: 'https://codeload.fork.example',
      FMD_DATA_DIR: '/tmp/fmd-data',
      FMD_LUA_DIR: '/home/dev/fmd2/lua',
    });
    expect(config.repo).toBe('fork-owner/FMD2');
    expect(config.sha).toBe(sha);
    expect(config.codeloadBaseUrl).toBe('https://codeload.fork.example');
    expect(config.dataDir).toBe('/tmp/fmd-data');
    expect(config.luaDirOverride).toBe('/home/dev/fmd2/lua');
  });

  it('refuses a pin that is not a full commit SHA', (): void => {
    expect(() => loadModuleSyncConfig({ FMD2_LUA_SHA: '97c903b' })).toThrow(ModuleSyncConfigError);
    expect(() => loadModuleSyncConfig({ FMD2_LUA_SHA: 'nothex'.repeat(8) })).toThrow(ModuleSyncConfigError);
  });

  it('builds codeload zipball URLs for the pinned SHA (fork base configurable)', (): void => {
    expect(codeloadZipballUrl('dazedcat19/FMD2', DEFAULT_FMD2_PIN_SHA, DEFAULT_CODELOAD_BASE_URL)).toBe(
      `https://codeload.githubusercontent.com/dazedcat19/FMD2/zip/${DEFAULT_FMD2_PIN_SHA}`,
    );
    expect(codeloadZipballUrl('fork-owner/FMD2', DEFAULT_FMD2_PIN_SHA, 'https://codeload.fork.example/')).toBe(
      `https://codeload.fork.example/fork-owner/FMD2/zip/${DEFAULT_FMD2_PIN_SHA}`,
    );
    expect(expectedZipballRoot('dazedcat19/FMD2', DEFAULT_FMD2_PIN_SHA)).toBe('FMD2-97c903b340');
  });
});
