import type { RequireShimRegistryEntry } from '@fmd/contract';

/**
 * The shim loader registry (§5.7, `LuaPackage.pas` / `AddLib` parity) —
 * the SINGLE SOURCE OF TRUTH for `requireShims[].status` in
 * contract.json. `installRequireShim` (lua-require.ts) iterates THIS
 * table to register the host libs, so the loader cannot drift from the
 * registry by construction; the CI drift check
 * (contract/tools/drift-check.ts) fails the gate on any divergence
 * between this table and contract.json, making the contract statuses
 * derived rather than hand-edited. Runtime agreement is proven by
 * server/test/engine/shims/require-registry.test.ts: every non-planned
 * entry resolves through a real wasmoon `require`, every planned entry
 * fails.
 *
 * Update discipline: any loader-side change (new lib, gap closed, stub
 * added) lands together with its row here AND the contract.json row
 * status — the gate fails otherwise.
 */

export const REQUIRE_SHIM_REGISTRY: readonly RequireShimRegistryEntry[] = [
  {
    require: 'fmd.env',
    loaderKey: 'fmd.env',
    servedBy: 'host-lib',
    status: 'implemented',
  },
  {
    require: 'fmd.crypto',
    loaderKey: 'fmd.crypto',
    servedBy: 'package-preload',
    status: 'implemented',
  },
  {
    require: 'fmd.duktape',
    loaderKey: 'fmd.duktape',
    servedBy: 'host-lib',
    status: 'implemented',
  },
  {
    require: 'fmd.gzip',
    loaderKey: 'fmd.gzip',
    servedBy: 'package-preload',
    status: 'implemented',
  },
  {
    require: 'fmd.fileutil',
    loaderKey: 'fmd.fileutil',
    servedBy: 'host-lib',
    status: 'partial',
    gap: 'SerializeAndMaintainNames (LuaFileUtil.pas third helper)',
  },
  {
    require: 'fmd.imagepuzzle',
    loaderKey: 'fmd.imagepuzzle',
    servedBy: 'package-preload',
    status: 'implemented',
  },
  {
    require: 'fmd.logger',
    loaderKey: 'fmd.logger',
    servedBy: 'host-lib',
    status: 'implemented',
  },
  {
    require: 'fmd.mangafoxwatermark',
    loaderKey: 'fmd.mangafoxwatermark',
    servedBy: 'host-lib',
    status: 'implemented',
  },
  {
    require: 'fmd.pcre2',
    loaderKey: 'fmd.pcre2',
    servedBy: 'host-lib',
    status: 'implemented',
  },
  {
    require: 'fmd.strings',
    loaderKey: null,
    servedBy: 'none',
    status: 'planned',
  },
  {
    require: 'pb',
    loaderKey: 'pb',
    servedBy: 'package-preload',
    status: 'implemented',
  },
  {
    require: 'subprocess',
    loaderKey: 'fmd.subprocess',
    servedBy: 'host-lib',
    status: 'stub',
  },
  {
    require: 'utils.* / templates.*',
    loaderKey: null,
    servedBy: 'file-chunk',
    status: 'implemented',
  },
];
