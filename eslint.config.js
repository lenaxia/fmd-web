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
      '**/coverage/**',
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
    // Offline maintenance scripts run under plain node — node globals apply.
    files: ['corpus/scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
