import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Boundary lint rules (non-negotiable, DESIGN.md Phase-0 toolchain gate).
 * Exported so the enforcement fixtures (contract/tools/fixture-tests)
 * and their tests mirror the root config without drift.
 */
export const boundaryRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/explicit-module-boundary-types': 'error',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Vite bundle output (web/dist-web) — build artifact, never linted.
      '**/dist-web/**',
      '**/coverage/**',
      // Playwright reports/test artifacts.
      '**/test-results/**',
      '**/playwright-report/**',
      // e2e scratch (fixture prep output, logs, artifacts).
      'e2e/.tmp/**',
      // Enforcement fixtures must violate the rules; they are checked by
      // contract/test/toolchain.test.ts, never by the normal lint pass.
      '**/fixture-tests/**',
      // Reference Pascal skeleton, not lintable JS/TS.
      'corpus/harness/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'],
    rules: {
      ...boundaryRules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // GENERATED api client types (openapi-typescript output) — exempt
    // from hand-maintained boundary rules; staleness is guarded by the
    // drift test (web/test/api-drift.test.ts) instead.
    files: ['web/src/api/openapi.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // Offline maintenance scripts + the e2e fixture/mock tooling run
    // under plain node — node globals apply.
    files: ['corpus/scripts/**/*.mjs', 'e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    // FMD2-key isolation boundary (DESIGN.md §8.6 item 6 / D4): the FMD2
    // hardcoded EncryptString key exists ONLY in the migration module
    // (server/src/tools/import/fmd2-crypto.ts). Everything else under
    // server/src is forbidden to import the migration path — native
    // storage (accounts/module_state/downloads) can therefore never reach
    // the key. Whitelisted consumers are excluded from this block below:
    // the import modules themselves and the documented install.ts engine-
    // shim wiring (fmd.crypto Lua surface parity). Tests are outside
    // server/src and covered by the key-isolation test instead.
    files: ['server/src/**/*.ts'],
    ignores: [
      'server/src/tools/import/**',
      'server/src/engine/shims/install.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tools/import', '**/tools/import/**'],
              message:
                'FMD2 migration boundary (D4): the FMD2-key import path is importable only from the import commands, the migration modules themselves, install.ts (engine-shim wiring) and tests.',
            },
          ],
        },
      ],
    },
  },
);
