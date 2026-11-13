/**
 * FMD2 lua/ + FMD2-DB sync placeholders (DESIGN.md §2, §6).
 * Pins are content-addressable by commit SHA; update checks use the
 * GitHub commits API (1 call) with conditional GET + rate budget.
 */

export interface SyncPin {
  readonly repo: string;
  readonly sha: string;
}

export const FMD2_REPO: string = 'dazedcat19/FMD2';
export const FMD2_DB_REPO: string = 'dazedcat19/FMD2-DB';

/** Rate budget for blob fetches (§2): 10 req/s, burst 50. */
export const SYNC_RATE_BUDGET = {
  requestsPerSecond: 10,
  burst: 50,
} as const;

export function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha) || /^[0-9a-f]{64}$/.test(sha);
}

export function makePin(repo: string, sha: string): SyncPin {
  if (!isValidSha(sha)) {
    throw new Error(`invalid commit SHA: ${sha}`);
  }
  return { repo, sha };
}
