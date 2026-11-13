import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContractDocument } from '@fmd/contract';
import {
  GENERATED_BINDINGS_REL_PATH,
  assertEventRowsSanity,
  renderBindingsModule,
  toSanityRow,
} from './render-bindings.js';

/**
 * CLI: regenerate `src/engine/events/bindings.generated.ts` from
 * `contract/contract.json` (run via `npm run gen:bindings -w @fmd/server`).
 *
 * Build-time sanity gate: the §5.2 invariants are asserted on the contract
 * rows BEFORE anything is written, so a corrupt contract document fails
 * the generation step loud instead of landing a broken table on disk.
 */
function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverRoot = resolve(here, '..', '..');
  const contractPath = resolve(serverRoot, '..', 'contract', 'contract.json');
  const document = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractDocument;
  const sanityRows = document.events.map(toSanityRow);
  assertEventRowsSanity(sanityRows);

  const rendered = renderBindingsModule(document.events);
  const outPath = join(serverRoot, GENERATED_BINDINGS_REL_PATH);
  writeFileSync(outPath, rendered);
  console.log(
    `generated ${GENERATED_BINDINGS_REL_PATH} (${String(document.events.length)} rows) <- ${contractPath}`,
  );
}

main();
