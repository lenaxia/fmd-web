import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Toolchain-enforcement proofs (acceptance criteria):
 *  1. the tsconfig flags REJECT violating fixtures (tsc exits non-zero
 *     with the expected error codes) and accept a clean control;
 *  2. eslint flags `any` and missing explicit return types on exports
 *     (via a fixture config mirroring the root boundary rules);
 *  3. the Docker image contract is structurally sound (multi-stage,
 *     non-root USER, healthcheck) and compose.yml parses with the app
 *     service only (browser profile stays a commented placeholder).
 *
 * All checks are offline: they spawn local tsc/eslint or read files.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = path.join(repoRoot, 'contract', 'tools', 'fixture-tests');

function tscJsPath(): string {
  const req = createRequire(import.meta.url);
  const tsMain = req.resolve('typescript');
  return path.join(path.dirname(tsMain), 'tsc.js');
}

interface ProcessResult {
  readonly status: number;
  readonly output: string;
}

function runTsc(projectDir: string): ProcessResult {
  try {
    const stdout: string = execFileSync(
      process.execPath,
      [tscJsPath(), '-p', projectDir],
      { encoding: 'utf8' },
    );
    return { status: 0, output: stdout };
  } catch (err: unknown) {
    const e = err as { status?: number | undefined; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`,
    };
  }
}

async function lintFixture(
  files: readonly string[],
): Promise<{ readonly ruleIds: readonly string[]; readonly errorCount: number }> {
  const linter = new ESLint({
    overrideConfigFile: path.join(fixtureDir, 'eslint.config.fixture.js'),
    cwd: fixtureDir,
  });
  const results = await linter.lintFiles([...files]);
  let errorCount = 0;
  const ruleIds: string[] = [];
  for (const r of results) {
    errorCount += r.errorCount;
    for (const m of r.messages) {
      if (m.ruleId !== null) {
        ruleIds.push(m.ruleId);
      }
    }
  }
  return { ruleIds, errorCount };
}

describe('tsconfig strict flags reject violating fixtures', (): void => {
  const strictDir = path.join(
    fixtureDir, 'tsconfig-strict-fixture',
  );
  const cleanDir = path.join(fixtureDir, 'tsconfig-clean-fixture');

  it('fails the build on the violating fixture', (): void => {
    const result = runTsc(strictDir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('TS1484'); // verbatimModuleSyntax
    expect(result.output).toContain('TS2532'); // noUncheckedIndexedAccess: object possibly undefined
    expect(result.output).toContain('TS7006'); // strict: noImplicitAny
    expect(result.output).toContain('TS4114'); // noImplicitOverride
    expect(result.output).toMatch(/exactOptionalPropertyTypes/);
  }, 90_000);

  it('passes the clean control (flags do not reject valid code)', (): void => {
    const result = runTsc(cleanDir);
    expect(result.status).toBe(0);
    expect(result.output).not.toMatch(/error TS/);
  }, 90_000);
});

describe('eslint boundary rules reject lint fixtures', (): void => {
  it('flags any and missing explicit return types on exports', async (): Promise<void> => {
    const { ruleIds, errorCount } = await lintFixture(['lint-violations.ts']);
    expect(errorCount).toBeGreaterThan(0);
    expect(ruleIds).toContain('@typescript-eslint/no-explicit-any');
    expect(ruleIds).toContain('@typescript-eslint/explicit-module-boundary-types');
  }, 90_000);

  it('accepts the clean control', async (): Promise<void> => {
    const { ruleIds, errorCount } = await lintFixture(['lint-clean.ts']);
    expect(errorCount).toBe(0);
    expect(ruleIds).toEqual([]);
  }, 90_000);
});

describe('docker contract (structural — docker CLI unavailable offline)', (): void => {
  const dockerfile = readFileSync(
    new URL('../../docker/Dockerfile', import.meta.url),
    'utf8',
  );
  const lines = dockerfile.split('\n').map((l): string => l.trim());
  const fromIdx = lines
    .map((l, i): [string, number] => [l, i])
    .filter(([l]): boolean => l.startsWith('FROM '))
    .map(([, i]): number => i);

  it('is multi-stage', (): void => {
    expect(fromIdx.length).toBeGreaterThanOrEqual(2);
  });

  it('drops to a non-root USER in the final stage', (): void => {
    const lastStage = lines.slice(fromIdx[fromIdx.length - 1] ?? 0);
    const userLines = lastStage.filter((l): boolean => l.startsWith('USER '));
    expect(userLines.length).toBeGreaterThan(0);
    const user = (userLines[userLines.length - 1] ?? 'root').split(/\s+/)[1] ?? 'root';
    expect(user).not.toBe('root');
    expect(user.length).toBeGreaterThan(0);
  });

  it('defines a healthcheck', (): void => {
    expect(lines.some((l): boolean => l.startsWith('HEALTHCHECK'))).toBe(true);
  });

  it('pins the base image by exact version/digest (reproducibility, DESIGN §3)', (): void => {
    for (const l of lines.filter((x): boolean => x.startsWith('FROM '))) {
      expect(/@sha256:[0-9a-f]{64}|node:\d+\.\d+\.\d+/.test(l)).toBe(true);
    }
  });
});

describe('compose contract (structural)', (): void => {
  const composePath = new URL('../../docker/compose.yml', import.meta.url);
  const composeText = readFileSync(composePath, 'utf8');

  it('parses as YAML with exactly the app service active (extras are profile-gated)', (): void => {
    const compose = parse(composeText) as {
      services?: Record<string, { profiles?: string[] } | unknown>;
    };
    const services = compose.services ?? {};
    expect(services['app']).toBeDefined();
    // every NON-app service must carry profiles (nothing extra starts by default)
    for (const [name, service] of Object.entries(services)) {
      if (name === 'app') {
        continue;
      }
      const profiles = (service as { profiles?: string[] }).profiles ?? [];
      expect(profiles.length).toBeGreaterThan(0);
    }
  });

  it('carries the §5.11 browser profile as a real digest-pinned flaresolverr service', (): void => {
    expect(composeText).toMatch(/--profile browser/);
    const compose = parse(composeText) as {
      services?: Record<string, { image?: string; profiles?: string[]; healthcheck?: { test?: unknown } }>;
    };
    const flaresolverr = compose.services?.['flaresolverr'];
    expect(flaresolverr).toBeDefined();
    expect(flaresolverr?.profiles).toEqual(['browser']);
    // digest-pinned third-party image (docs/docker-pinning.md)
    expect(flaresolverr?.image).toMatch(/^ghcr\.io\/flaresolverr\/flaresolverr:v3\.3\.21@sha256:[0-9a-f]{64}$/);
    // healthcheck probes the adapter's health-gate path
    const test = flaresolverr?.healthcheck?.test;
    expect(JSON.stringify(test)).toContain('8191/health');
  });

  it('builds from docker/Dockerfile at the repo-root context', (): void => {
    const compose = parse(composeText) as {
      services?: Record<string, { build?: { context?: string; dockerfile?: string } }>;
    };
    const app = compose.services?.['app'];
    expect(app?.build?.context).toBe('..');
    expect(app?.build?.dockerfile).toBe('docker/Dockerfile');
  });
});
