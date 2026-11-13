import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ContractDocument } from '@fmd/contract';

/**
 * The §5.2 rows as data — proves the dispatcher consumes contract.json
 * (not a hand-coded table). Loaded via the package export so the test
 * mirrors the runtime source exactly.
 */

const require = createRequire(import.meta.url);
const document = JSON.parse(
  readFileSync(require.resolve('@fmd/contract/contract.json'), 'utf8'),
) as ContractDocument;

export const CONTRACT_BINDING_ROWS = document.events;
