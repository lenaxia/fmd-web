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
    alias: [
      // Design system: the web workspace's `@/` alias (vendored shadcn
      // components) — mirrors web/vite.config.ts + web/tsconfig.json.
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./web/src/', import.meta.url)),
      },
      // Workspace-source aliases so tests never require a prior build:
      // '@fmd/contract' resolves to its TypeScript source in vitest,
      // while tsc -b resolves it through the workspace package exports.
      {
        find: /^@fmd\/contract$/,
        replacement: fileURLToPath(new URL('./contract/types.ts', import.meta.url)),
      },
      // The drift-check tool (requireShims status cross-check tests cross
      // the server ↔ contract boundary in vitest, like the corpus replay).
      {
        find: /^@fmd\/contract\/tools\/drift-check$/,
        replacement: fileURLToPath(new URL('./contract/tools/drift-check.ts', import.meta.url)),
      },
      // '@fmd/corpus' subpaths resolve to runner source (the live-engine
      // replay test crosses the server ↔ corpus package boundary).
      {
        find: /^@fmd\/corpus$/,
        replacement: fileURLToPath(new URL('./corpus/runner/replay.ts', import.meta.url)),
      },
      {
        find: /^@fmd\/corpus\/corpus-loader$/,
        replacement: fileURLToPath(new URL('./corpus/runner/corpus-loader.ts', import.meta.url)),
      },
      {
        find: /^@fmd\/corpus\/fixture-loader$/,
        replacement: fileURLToPath(new URL('./corpus/runner/fixture-loader.ts', import.meta.url)),
      },
      {
        find: /^@fmd\/corpus\/mock-engine$/,
        replacement: fileURLToPath(new URL('./corpus/runner/mock-engine.ts', import.meta.url)),
      },
      {
        find: /^@fmd\/corpus\/harvester$/,
        replacement: fileURLToPath(new URL('./corpus/harvester/harvest.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    // Zero-network guard (DESIGN.md §13): every test file in every
    // workspace runs with the node net stack patched — any outbound
    // (non-loopback) socket attempt throws and is recorded.
    setupFiles: ['corpus/test/setup/no-network.ts'],
    include: [
      'contract/test/**/*.test.ts',
      'server/test/**/*.test.ts',
      'corpus/test/**/*.test.ts',
      'web/test/**/*.test.ts',
      'web/test/**/*.test.tsx',
    ],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: [
        'contract/tools/**/*.ts',
        'server/src/**/*.ts',
        'corpus/harvester/**/*.ts',
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
