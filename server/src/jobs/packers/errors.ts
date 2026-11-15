import type { JobFailureKind } from '@fmd/contract';

/**
 * Pack-stage failure taxonomy (DESIGN.md §7.3, D16): every pack failure
 * lands on the job as the `pack` failure kind and is retryable — the
 * download lane may retry the pack, optionally with the per-image
 * JPEG re-encode recovery (budget-exceeded / unsupported-image carry
 * the `re-encode-pages` hint).
 */

/** Why a pack failed (refined below the job-level `pack` kind). */
export type PackFailureKind =
  | 'pack-budget-exceeded'
  | 'pack-watchdog-timeout'
  | 'pack-unsupported-image'
  | 'pack-input-missing'
  | 'pack-io';

/** Recovery hint attached to retryable pack failures. */
export type PackRecoveryHint = 'retry' | 're-encode-pages';

/** The job-level failure kind every pack failure maps to (§4, §7.3). */
export const PACK_JOB_FAILURE_KIND: JobFailureKind = 'pack';

export interface PackErrorOptions {
  readonly recoveryHint?: PackRecoveryHint;
  readonly cause?: unknown;
}

export class PackError extends Error {
  readonly kind: PackFailureKind;
  readonly recoveryHint?: PackRecoveryHint;

  constructor(kind: PackFailureKind, message: string, options?: PackErrorOptions) {
    super(message);
    this.name = 'PackError';
    this.kind = kind;
    if (options?.recoveryHint !== undefined) {
      this.recoveryHint = options.recoveryHint;
    }
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** True when `error` is a typed pack failure. */
export function isPackError(error: unknown): error is PackError {
  return error instanceof PackError;
}

/** The job-failure projection of any pack error (D16: always retryable). */
export interface PackJobFailure {
  readonly state: 'failed';
  readonly kind: JobFailureKind;
  readonly retryable: boolean;
  readonly message: string;
  readonly recoveryHint?: PackRecoveryHint;
}

/**
 * Map any thrown error to the persisted job failure: pack failures keep
 * their refinement + recovery hint; unexpected throws still fail the
 * job as `pack` (retryable) — the pack stage never wedges the lane.
 */
export function packJobFailure(error: unknown): PackJobFailure {
  if (isPackError(error)) {
    return {
      state: 'failed',
      kind: PACK_JOB_FAILURE_KIND,
      retryable: true,
      message: error.message,
      ...(error.recoveryHint !== undefined ? { recoveryHint: error.recoveryHint } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    state: 'failed',
    kind: PACK_JOB_FAILURE_KIND,
    retryable: true,
    message,
  };
}
