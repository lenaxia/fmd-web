// Mirror of the ROOT eslint rules (imported — no drift), without the
// global ignores, so the fixture files are actually linted.
import tseslint from 'typescript-eslint';
import { boundaryRules } from '../../../eslint.config.js';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: { ...boundaryRules },
  },
);
