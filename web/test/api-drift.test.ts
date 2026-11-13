/**
 * API drift test — the generated client build BREAKS when the
 * committed OpenAPI snapshot changes without regenerating
 * (acceptance: "a route-change snapshot drift breaks the client
 * build"). Regenerates openapi-typescript output from the COMMITTED
 * snapshot in-memory and byte-compares against the committed
 * `web/src/api/openapi.d.ts`; a negative control proves the harness
 * reacts to route additions.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';
import type { OpenAPI3 } from 'openapi-typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(HERE, '../../server/src/api/openapi.snapshot.json');
const GENERATED_PATH = resolve(HERE, '../src/api/openapi.d.ts');

async function regenerate(spec: OpenAPI3): Promise<string> {
  const ast = await openapiTS(spec);
  return COMMENT_HEADER + astToString(ast);
}

function committedGenerated(): string {
  return readFileSync(GENERATED_PATH, 'utf8');
}

function readSnapshot(): OpenAPI3 {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as OpenAPI3;
}

describe('generated API client vs committed OpenAPI snapshot', (): void => {
  it('is byte-identical to a fresh openapi-typescript run (no drift)', async (): Promise<void> => {
    const fresh = await regenerate(readSnapshot());
    const committed = committedGenerated();
    expect(fresh).toBe(committed);
  });

  it('references the snapshot routes via the generated paths type', async (): Promise<void> => {
    // Client call sites are keyed by path literals from the GENERATED
    // `paths` interface — enforced at typecheck (client.ts + hooks.ts
    // import type { paths } and never declare route strings elsewhere).
    const committed = committedGenerated();
    for (const route of [
      '"/api/modules"',
      '"/api/modules/{id}"',
      '"/api/sync/modules"',
      '"/api/sync/catalog/{id}"',
      '"/api/sync/catalog/all"',
      '"/api/catalog/{id}/latest"',
      '"/api/catalog/{id}/title"',
      '"/api/catalog/{id}/search"',
      '"/api/info"',
      '"/api/jobs/download"',
      '"/api/jobs"',
      '"/api/auth/login"',
      '"/healthz"',
      '"/readyz"',
    ]) {
      expect(committed).toContain(route);
    }
  });

  it('negative control: adding a route to the snapshot produces different output', async (): Promise<void> => {
    const spec = readSnapshot();
    const mutated: OpenAPI3 = {
      ...spec,
      paths: {
        ...spec.paths,
        '/api/catalogs': {
          get: {
            operationId: 'listCatalogs',
            responses: {
              200: {
                description: 'catalog list',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const fresh = await regenerate(mutated);
    expect(fresh).not.toBe(committedGenerated());
    expect(fresh).toContain('"/api/catalogs"');
    expect(committedGenerated()).not.toContain('"/api/catalogs"');
  });
});
