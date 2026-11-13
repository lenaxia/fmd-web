import { describe, expect, it } from 'vitest';
import {
  detectCapabilities,
  KNOWN_BROKEN_FLAG_IDS,
  scanRequires,
  type CapabilityDetectOptions,
} from '../../../src/engine/registry/capabilities.js';
import { FMD2_LUA_ROOT } from '../../../src/engine/shims/install.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** §5.10 capability detection: static require-graph analysis, D3 flags. */

const realOptions: CapabilityDetectOptions = { luaRoot: FMD2_LUA_ROOT };

function detectFromFile(file: string) {
  const source = readFileSync(join(FMD2_LUA_ROOT, 'modules', file), 'utf8');
  return detectCapabilities({ eventHandlers: {} }, source, realOptions);
}

describe('scanRequires', () => {
  it('covers the Lua require forms the tree uses', () => {
    expect(
      scanRequires(`
local a = require 'utils.json'
local b = require("fmd.subprocess")
local c = require ('templates.Madara').new()
local d = require 'fmd.env'.Revision
local no_capture = require  x
`),
    ).toEqual(['utils.json', 'fmd.subprocess', 'templates.Madara', 'fmd.env']);
  });

  it('deduplicates repeated requires', () => {
    expect(scanRequires("require 'utils.json' require 'utils.json'")).toEqual(['utils.json']);
  });
});

describe('utils/* closure → requires_subprocess (§5.10 fmd.subprocess consumers)', () => {
  it('flags the three named fmd.subprocess consumers via utils.nodejs', () => {
    for (const file of ['TheBlank.lua', 'RaijinScans.lua', 'Comix.lua']) {
      const detection = detectFromFile(file);
      expect(detection.capabilities.requires_subprocess, file).toBe(true);
      expect(detection.capabilities.requires_browser, file).toBe(false);
      expect(detection.capabilities.known_broken_flags, file).toContain('fmd.subprocess');
    }
  });

  it('walks nested utils/* requires; templates edges never leak the subprocess flag (Round-4 attribution)', () => {
    // chunk map instead of the real tree
    const chunks: Record<string, string> = {
      'templates/Tmpl.lua': "require 'utils.helper'",       // template that never calls run_html_load
      'templates/TmplBrowser.lua': "local x = run_html_load", // template using the no-JS fallback
      'utils/helper.lua': "require 'utils.nodejs'",
      'utils/nodejs.lua': 'defines run_html_load + fmd.subprocess',
    };
    const options: CapabilityDetectOptions = { luaRoot: FMD2_LUA_ROOT, loadChunk: (p) => chunks[p] };

    // direct utils.* edge, nested two levels deep → subprocess
    const direct = detectCapabilities({ eventHandlers: {} }, "require 'utils.helper'", options);
    expect(direct.capabilities.requires_subprocess).toBe(true);
    // templates.* edge whose own utils.nodejs use stays OFF the dependent:
    // the module gets neither flag (the template owns its subprocess use)
    const viaTemplate = detectCapabilities({ eventHandlers: {} }, "require 'templates.Tmpl'", options);
    expect(viaTemplate.capabilities.requires_browser).toBe(false);
    expect(viaTemplate.capabilities.requires_subprocess).toBe(false);
    expect(viaTemplate.capabilities.known_broken_flags).toEqual([]);
    // template that itself calls run_html_load → browser flag only
    const viaBrowserTemplate = detectCapabilities({ eventHandlers: {} }, "require 'templates.TmplBrowser'", options);
    expect(viaBrowserTemplate.capabilities.requires_browser).toBe(true);
    expect(viaBrowserTemplate.capabilities.requires_subprocess).toBe(false);
    expect(viaBrowserTemplate.capabilities.known_broken_flags).toEqual(['madara.run_html_load']);
  });

  it('is cycle-safe', () => {
    const chunks: Record<string, string> = {
      'utils/a.lua': "require 'utils.b'",
      'utils/b.lua': "require 'utils.a'",
    };
    const options: CapabilityDetectOptions = { luaRoot: FMD2_LUA_ROOT, loadChunk: (p) => chunks[p] };
    expect(detectCapabilities({ eventHandlers: {} }, "require 'utils.a'", options).capabilities.requires_subprocess).toBe(false);
  });
});

describe('templates/* closure → requires_browser (madara.run_html_load)', () => {
  it('flags a real Madara-family module without the subprocess flag', () => {
    const source = readFileSync(join(FMD2_LUA_ROOT, 'modules', '3asq.lua'), 'utf8');
    const detection = detectCapabilities({ eventHandlers: {} }, source, realOptions);
    expect(source).toContain('templates.Madara');
    expect(detection.capabilities.requires_browser).toBe(true);
    expect(detection.capabilities.requires_subprocess).toBe(false);
    expect(detection.capabilities.known_broken_flags).toEqual(['madara.run_html_load']);
  });

  it('does not flag modules whose templates never call run_html_load', () => {
    const detection = detectFromFile('AsuraScans.lua');
    expect(detection.capabilities.requires_browser).toBe(false);
    expect(detection.capabilities.requires_subprocess).toBe(false);
    expect(detection.capabilities.known_broken_flags).toEqual([]);
  });
});

describe('bypass_python_gated (webdriver.bypass)', () => {
  it('flags the modules that declare reliance on the cloudflare workaround', () => {
    for (const file of ['HDoujin.lua', 'SchaleNetwork.lua', 'OniSaga.lua', 'MangaDotNet.lua']) {
      const detection = detectFromFile(file);
      expect(detection.capabilities.bypass_python_gated, file).toBe(true);
      expect(detection.capabilities.known_broken_flags, file).toContain('webdriver.bypass');
    }
  });

  it('does not flag ordinary modules', () => {
    expect(detectFromFile('AsuraScans.lua').capabilities.bypass_python_gated).toBe(false);
  });
});

describe('flag vocabulary', () => {
  it('matches the contract.json capability ids (the D3 published set)', () => {
    expect(KNOWN_BROKEN_FLAG_IDS).toEqual(['fmd.subprocess', 'madara.run_html_load', 'webdriver.bypass']);
  });
});
