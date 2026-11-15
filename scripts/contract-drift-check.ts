import { parseArgs, reportDriftCheckResult, runDriftCheck } from '../contract/tools/drift-check.js';
import { REQUIRE_SHIM_REGISTRY } from '../server/src/engine/shims/require-registry.js';

/**
 * Sanctioned CLI entry for the contract drift check (DESIGN.md §5 CI
 * rule; the `contract:check` gate in scripts/ci.sh).
 *
 * This wrapper exists because the shim loader registry — the single
 * source of truth for contract.json's `requireShims[].status` — lives
 * in the server workspace (server/src/engine/shims/require-registry.ts,
 * consumed by the loader itself), and the @fmd/contract package must
 * not depend on @fmd/server (the reference direction is contract ←
 * server). Running under tsx lets one process import both the contract
 * tooling and the loader registry, so there is deliberately NO
 * registry-less CLI path: a requireShims status lie can never slip
 * past this gate.
 */
function main(): void {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(detail);
    process.exitCode = 2;
    return;
  }
  reportDriftCheckResult(
    runDriftCheck({ ...options, requireRegistry: REQUIRE_SHIM_REGISTRY }),
    'events + TXQuery/Storage/ImagePuzzle/Duktape/Crypto facades + requireShims statuses',
  );
}

main();
