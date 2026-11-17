import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModuleSyncService, type SweepResult } from '../../../src/engine/registry/module-sync.js';
import { scanRequires } from '../../../src/engine/registry/capabilities.js';
import { FMD2_LUA_ROOT } from '../../../src/engine/shims/install.js';

/**
 * The D3 full-tree registration sweep (DESIGN.md §12 Phase-2 exit):
 * ALL 417 real module files through the Init pass — offline — with
 * per-file error isolation; ≥95 % must register; the §5.10 known-broken
 * special cases must carry the right capability flags. The committed
 * registration-summary.json artifact is byte-checked against a fresh
 * sweep (regenerate with UPDATE_REGISTRATION_SUMMARY=1).
 */

const ARTIFACT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'registration-summary.json');

interface RegistrationArtifact {
  readonly design: string;
  readonly luaRoot: string;
  readonly treeSha: string;
  readonly counts: {
    readonly totalFiles: number;
    readonly registeredFiles: number;
    readonly failedFiles: number;
    readonly totalModules: number;
    readonly registerRate: string;
  };
  readonly d3KnownBroken: Readonly<Record<string, readonly string[]>>;
  readonly eventCoverage: Readonly<Record<string, number>>;
  readonly failures: readonly { readonly file: string; readonly error: string }[];
  readonly specialCases: {
    readonly subprocessConsumers: readonly string[];
    readonly madaraFamily: readonly string[];
    readonly bypassPythonGated: readonly string[];
    readonly accountModules: readonly string[];
  };
}

const sync = new ModuleSyncService({ luaRoot: FMD2_LUA_ROOT });
let sweep: SweepResult;
let artifact: RegistrationArtifact;

beforeAll(async () => {
  sweep = await sync.sweep();
  const files = sweep.files.filter((f) => f.ok).flatMap((f) => f.registrations);
  const s = sweep.summary;
  artifact = {
    design: 'DESIGN.md §2/§5.1/§5.10 + D3 — full-tree offline Init sweep with per-file error isolation; capability flags from static require-graph analysis; known-broken = the D3 published set',
    luaRoot: FMD2_LUA_ROOT,
    treeSha: s.treeSha,
    counts: {
      totalFiles: s.totalFiles,
      registeredFiles: s.registeredFiles,
      failedFiles: s.failedFiles,
      totalModules: s.totalModules,
      registerRate: `${((s.registeredFiles / s.totalFiles) * 100).toFixed(1)}%`,
    },
    d3KnownBroken: s.knownBroken,
    eventCoverage: s.eventCoverage,
    failures: s.failures,
    specialCases: {
      subprocessConsumers: files.filter((r) => r.capabilities.requires_subprocess).map((r) => r.name),
      madaraFamily: files.filter((r) => r.capabilities.requires_browser).map((r) => r.name),
      bypassPythonGated: files.filter((r) => r.capabilities.bypass_python_gated).map((r) => r.name),
      accountModules: files.filter((r) => r.accountSupport).map((r) => r.name),
    },
  };
}, 120_000);

describe('full-tree sweep (417 files, offline Init pass)', () => {
  it('sweeps exactly the real 417-file tree', () => {
    expect(sweep.summary.totalFiles).toBe(417);
    expect(sweep.files.length).toBe(417);
    expect(sync.discoverFiles().length).toBe(417);
  });

  it('annotates the failure count against the SHARED tolerance policy (sweep + sync, one source)', () => {
    // The real tree: 5 failures of 417 files — inside the tolerance
    // (contract/tolerance.ts, the same constants the staged sync gate
    // consults; the sweep itself never blocks, this is the annotation).
    expect(sweep.summary.failedFiles).toBe(5);
    expect(sweep.summary.withinTolerance).toBe(true);
  });

  it('registers ≥95% of files (D3 target) with a non-empty module_state row each', () => {
    const { registeredFiles, totalFiles } = sweep.summary;
    expect(registeredFiles / totalFiles).toBeGreaterThanOrEqual(0.95);
    for (const file of sweep.files) {
      if (file.ok) {
        expect(file.registrations.length, file.file).toBeGreaterThanOrEqual(1);
        for (const reg of file.registrations) {
          // FMD2 enforces nothing on the ID string (the real tree ships
          // 30/32/33-char, mixed-alphabet ids) — non-empty is the contract
          expect(reg.id.length).toBeGreaterThan(0);
          expect(reg.name).not.toBe('');
          expect(reg.file).toBe(file.file);
        }
      }
    }
  });

  it('isolates per-file errors — every failure captured, none cascades', () => {
    const { failures } = sweep.summary;
    expect(failures.length).toBeGreaterThan(0); // the tree genuinely has broken files
    expect(failures.length).toBe(sweep.summary.failedFiles);
    for (const failure of failures) {
      expect(failure.error, failure.file).toBeTypeOf('string');
      expect(failure.error.length, failure.file).toBeGreaterThan(0);
    }
    // no cascade: files sorting after the FIRST failure still registered
    const firstFailure = failures[0]?.file ?? '';
    expect(firstFailure).not.toBe('');
    const after = sweep.files.filter((f) => f.file > firstFailure);
    expect(after.some((f) => f.ok)).toBe(true);
  });

  it('counts modules, files and per-file results consistently', () => {
    const s = sweep.summary;
    expect(s.registeredFiles + s.failedFiles).toBe(s.totalFiles);
    expect(s.totalModules).toBe(sweep.registrations.length);
    expect(s.failures.map((f) => f.file)).toEqual(sweep.files.filter((f) => !f.ok).map((f) => f.file));
  });
});

describe('§5.10 capability flags — named special cases', () => {
  it('requires_subprocess = exactly TheBlank, RaijinScans, Comix', () => {
    const flagged = sweep.registrations.filter((r) => r.capabilities.requires_subprocess);
    expect(flagged.map((r) => r.file).sort()).toEqual(['Comix.lua', 'RaijinScans.lua', 'TheBlank.lua']);
    for (const reg of flagged) {
      expect(reg.capabilities.known_broken_flags).toContain('fmd.subprocess');
      expect(reg.capabilities.requires_browser).toBe(false);
    }
  });

  it('requires_browser = exactly the Madara family (≤76 sites, templates/Madara run_html_load)', () => {
    const flagged = sweep.registrations.filter((r) => r.capabilities.requires_browser);
    // static cross-check over the real tree: files requiring templates.Madara
    const madaraFiles = sync
      .discoverFiles()
      .filter((f) => scanRequires(sync.readSource(f)).includes('templates.Madara'))
      .sort();
    expect(madaraFiles.length).toBeLessThanOrEqual(76);
    expect(flagged.map((r) => r.file).sort()).toEqual(madaraFiles);
    for (const reg of flagged) {
      expect(reg.capabilities.known_broken_flags).toContain('madara.run_html_load');
      expect(reg.capabilities.requires_subprocess).toBe(false); // Round-4: run_html_load ONLY
    }
  });

  it('bypass_python_gated = the cloudflare-workaround sites', () => {
    const flagged = sweep.registrations.filter((r) => r.capabilities.bypass_python_gated);
    expect(flagged.map((r) => r.file).sort()).toEqual([
      'HDoujin.lua',
      'MangaDotNet.lua',
      'OniSaga.lua',
      'SchaleNetwork.lua',
    ]);
    for (const reg of flagged) {
      expect(reg.capabilities.known_broken_flags).toContain('webdriver.bypass');
    }
  });

  it('EHentai: account special case — ExHentai carries AccountSupport + OnLogin, E-Hentai does not', () => {
    const ehentai = sweep.files.find((f) => f.file === 'EHentai.lua');
    expect(ehentai?.ok).toBe(true);
    expect(ehentai?.registrations.length).toBe(2);
    const eHentai = ehentai?.registrations.find((r) => r.name === 'E-Hentai');
    const exHentai = ehentai?.registrations.find((r) => r.name === 'ExHentai');
    expect(eHentai?.accountSupport).toBe(false);
    expect(eHentai?.rootURL).toBe('https://e-hentai.org');
    expect(exHentai?.accountSupport).toBe(true);
    expect(exHentai?.capabilities.events).toContain('OnLogin');
    // combobox option with INDEX default survives into the options schema
    const combo = exHentai?.options.find((o) => o.name === 'imagesize');
    expect(combo?.kind).toBe('combobox');
    expect(typeof combo?.defaultValue).toBe('number');
  });

  it('event coverage: Init-declared On* props captured per module', () => {
    const coverage = sweep.summary.eventCoverage;
    expect(Object.keys(coverage).every((e) => e.startsWith('On'))).toBe(true);
    expect(Object.keys(coverage)).toContain('OnGetInfo');
    expect(Object.keys(coverage)).toContain('OnLogin');
    // the totals add up to the per-module events
    const total = sweep.registrations.reduce((sum, r) => sum + r.capabilities.events.length, 0);
    expect(Object.values(coverage).reduce((a, b) => a + b, 0)).toBe(total);
    expect(coverage['OnGetInfo']).toBeGreaterThan(300);
  });
});

describe('registration-summary.json artifact', () => {
  it('is committed and byte-matches a fresh sweep (UPDATE_REGISTRATION_SUMMARY=1 regenerates)', () => {
    const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
    if (process.env['UPDATE_REGISTRATION_SUMMARY'] === '1') {
      mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
      writeFileSync(ARTIFACT_PATH, rendered);
    }
    expect(existsSync(ARTIFACT_PATH)).toBe(true);
    expect(readFileSync(ARTIFACT_PATH, 'utf8')).toBe(rendered);
  });

  it('≥95% register rate is recorded in the artifact', () => {
    expect(artifact.counts.registerRate).toMatch(/9\d\.\d%/);
    expect(parseInt(artifact.counts.registerRate, 10)).toBeGreaterThanOrEqual(95);
  });
});
