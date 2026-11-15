/**
 * OpenAPI snapshot test (§10 contract-based API): the generated
 * document must match the committed snapshot byte-for-byte — any
 * unintended API drift fails here. Intentional drift is regenerated
 * with `API_OPENAPI_SNAPSHOT=write npm test -- openapi` and the
 * snapshot committed alongside the schema change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '../../src/api/openapi.js';
import { API_ROUTES } from '../../src/api/routes.js';
import { SERVER_VERSION } from '../../src/main.js';

const SNAPSHOT_PATH = fileURLToPath(new URL('../../src/api/openapi.snapshot.json', import.meta.url));
const WRITE_MODE = process.env['API_OPENAPI_SNAPSHOT'] === 'write';

function generated(): ReturnType<typeof generateOpenApiDocument> {
  return generateOpenApiDocument(SERVER_VERSION);
}

/** Inventory paths use `:id`; the OpenAPI doc uses `{id}`. */
function toDocPath(inventoryPath: string): string {
  return inventoryPath.replaceAll(/:([A-Za-z]+)/g, (_m, name: string) => `{${name}}`);
}

describe('OpenAPI snapshot (contract-based API)', (): void => {
  it('the generated document matches the committed snapshot byte-for-byte', (): void => {
    const doc = generated();
    const serialized = `${JSON.stringify(doc, null, 2)}\n`;
    if (WRITE_MODE) {
      writeFileSync(SNAPSHOT_PATH, serialized);
    }
    const committed = readFileSync(SNAPSHOT_PATH, 'utf8');
    // Byte equality proves determinism (key order, formatting) AND drift
    // detection; deep equality would hide formatting churn.
    expect(serialized).toBe(committed);
  });

  it('the document is deterministic across runs', (): void => {
    const a = JSON.stringify(generated());
    const b = JSON.stringify(generated());
    expect(a).toBe(b);
  });

  it('every non-WS §10 route in the inventory is documented, and vice versa', (): void => {
    const doc = generated();
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) =>
        Object.keys(ops as Record<string, unknown>).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    );
    const inventory = new Set(
      API_ROUTES.filter((r) => r.method !== 'WS').map((r) => `${r.method} ${toDocPath(r.path)}`),
    );
    const missingInDoc = [...inventory].filter((r) => !documented.has(r));
    const missingInInventory = [...documented].filter((r) => !inventory.has(r));
    expect(missingInDoc).toEqual([]);
    expect(missingInInventory).toEqual([]);
    expect(documented.size).toBeGreaterThanOrEqual(14);
  });

  it('every $ref resolves into components.schemas (no dangling pointers)', (): void => {
    const doc = generated();
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item);
        }
        return;
      }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') {
            refs.push(value);
          } else {
            walk(value);
          }
        }
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/'), ref).toBe(true);
      const name = ref.slice('#/components/schemas/'.length);
      expect(doc.components.schemas[name], `missing component ${name}`).toBeDefined();
    }
  });

  it('components include the shared boundary models', (): void => {
    const doc = generated();
    for (const name of [
      'ApiErrorEnvelope',
      'ModuleSummary',
      'ModuleOptionDescriptor',
      'ModuleCapabilities',
      'CatalogEntry',
      'InfoResponse',
      'Job',
      'Timestamp',
    ]) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
  });

  it('contract surface: idempotency semantics documented on the download route', (): void => {
    const doc = generated();
    const op = doc.paths['/api/jobs/download'] as {
      post: { responses: Record<string, { description: string }> };
    };
    expect(op.post.responses['200']?.description).toContain('original job');
    expect(op.post.responses['201']).toBeDefined();
    expect(op.post.responses['409']?.description).toContain('different payload');
  });
});
