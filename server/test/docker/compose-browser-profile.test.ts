import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Compose `browser` profile config validation (DESIGN.md §5.11, D2;
 * acceptance: "compose profile config validated") — OFFLINE: parses
 * docker/compose.yml directly (no docker daemon required; the REAL
 * compose-implementation render is validated by scripts/compose-check.sh
 * on docker/tooling hosts). Asserts:
 *
 * - the flaresolverr service is gated behind `profiles: ["browser"]`
 *   (WITHOUT the profile no such service exists → the §5.10
 *   known-broken flags stand);
 * - the image is digest-pinned (docs/docker-pinning.md);
 * - a healthcheck probes /health (the adapter's health-gate path);
 * - the app carries the FMD_WEB_BROWSER_SIDECAR_URL pass-through with
 *   an EMPTY default (opt-in via env; flags flip only when set).
 */

interface ComposeService {
  readonly image?: string;
  readonly profiles?: readonly string[];
  readonly healthcheck?: { readonly test?: unknown };
  readonly environment?: Record<string, string> | ReadonlyArray<string>;
}

interface ComposeFile {
  readonly services?: Record<string, ComposeService>;
}

const FLARESOLVERR_PIN =
  'ghcr.io/flaresolverr/flaresolverr:v3.3.21@sha256:f104ee51e5124d83cf3be9b37480649355d223f7d8f9e453d0d5ef06c6e3b31b';

function loadCompose(): ComposeFile {
  const path = fileURLToPath(new URL('../../../docker/compose.yml', import.meta.url));
  return parse(readFileSync(path, 'utf8')) as ComposeFile;
}

function appEnv(service: ComposeService): Record<string, string> {
  const env: unknown = service.environment ?? {};
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map((entry): [string, string] => {
        const [key, value = ''] = entry.split('=', 2);
        return [key, value];
      }),
    );
  }
  return { ...(env as Record<string, string>) };
}

describe('docker/compose.yml — §5.11 browser profile', (): void => {
  const compose = loadCompose();
  const app = compose.services?.['app'];
  const flaresolverr = compose.services?.['flaresolverr'];

  it('the flaresolverr service exists and is gated behind profiles: [browser]', (): void => {
    expect(flaresolverr).toBeDefined();
    expect(flaresolverr?.profiles).toEqual(['browser']);
    // the app service itself stays un-profiled (always up)
    expect(app?.profiles).toBeUndefined();
  });

  it('the flaresolverr image is digest-pinned (docs/docker-pinning.md)', (): void => {
    expect(flaresolverr?.image).toBe(FLARESOLVERR_PIN);
  });

  it('a healthcheck probes /health on 8191 (the adapter health-gate path)', (): void => {
    const test = (flaresolverr?.healthcheck?.test ?? []) as readonly string[];
    const flat = Array.isArray(test) ? test.join(' ') : String(test);
    expect(flat).toContain('8191/health');
  });

  it('the app carries the sidecar URL pass-through with an EMPTY default (flags flip only when set)', (): void => {
    expect(app).toBeDefined();
    const env = appEnv(app as ComposeService);
    // the RAW yaml carries the compose interpolation (empty default);
    // the RENDERED value is asserted empty by scripts/compose-check.sh
    expect(env['FMD_WEB_BROWSER_SIDECAR_URL']).toBe('${FMD_WEB_BROWSER_SIDECAR_URL:-}');
  });
});
