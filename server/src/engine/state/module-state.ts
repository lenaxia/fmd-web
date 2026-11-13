import type { ModuleId } from '@fmd/contract';

/**
 * Per-module shared state service placeholder (DESIGN.md §5.3).
 * One host-side instance per module, independent of the worker pool:
 * cookie jar (RW lock), Storage KV (per-key mutex), Account (mutex),
 * options (copy-on-read), bypass state, per-host connection limiter.
 */

export interface ModuleStateSnapshot {
  readonly moduleId: ModuleId;
  readonly cookieCount: number;
  readonly storageKeys: readonly string[];
  readonly accountStatus: 'asUnknown' | 'asChecking' | 'asValid' | 'asInvalid';
}

export function emptySnapshot(moduleId: ModuleId): ModuleStateSnapshot {
  return {
    moduleId,
    cookieCount: 0,
    storageKeys: [],
    accountStatus: 'asUnknown',
  };
}
