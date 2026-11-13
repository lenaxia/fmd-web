import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Root vitest config — runs every workspace's tests from the repo root.
 * All tests are OFFLINE (DESIGN.md §13): pure units, recorded fixtures,
 * local spawn-based tool checks. Loopback sockets are allowed (they never
 * leave the machine); live external network access is forbidden.
 */
export default defineConfig({
  esbuild: { target: 'es2022' },
  resolve: {
    alias: {
      // Workspace-source alias so tests never require a prior build:
      // '@fmd/contract' resolves to its TypeScript source in vitest,
      // while tsc -b resolves it through the workspace package exports.
      '@fmd/contract': fileURLToPath(
        new URL('./contract/types.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'contract/test/**/*.test.ts',
      'server/test/**/*.test.ts',
      'corpus/test/**/*.test.ts',
      'web/test/**/*.test.ts',
    ],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: [
        'contract/tools/**/*.ts',
        'server/src/**/*.ts',
        'corpus/runner/**/*.ts',
        'web/src/**/*.ts',
      ],
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        // Enforcement fixtures are never executed by tests by design —
        // they are compiled/linted by the toolchain-enforcement tests.
        'contract/tools/fixture-tests/**',
      ],
      thresholds: {
        lines: 75,
        statements: 75,
        branches: 65,
        functions: 80,
      },
    },
  },
});
