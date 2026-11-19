/**
 * Retry backoff for failed downloads (DESIGN-NORTHSTAR §2 TRIAGE:
 * failures retry on a **paced** schedule — never an instant fan-out;
 * §2 PIPE: per-host pacing applies to retries exactly as to fresh
 * work, which the delayed re-claim preserves: an exhausted attempt
 * waits out its backoff BEFORE re-entering the claimable pool).
 *
 * Curve: `min(capMs, baseMs * factor^(attempts - 1))` with multiplicative
 * jitter `* (1 + jitterShare * u)`, `u ∈ [0, 1)`, re-clamped to the cap —
 *
 *   attempt 1 → base                    (5 s default)
 *   attempt 2 → base * 2                (10 s)
 *   attempt 3 → base * 4                (20 s)
 *   …growing geometrically until the 24 h cap
 *
 * `attempts` is the claim-incremented attempt counter AFTER the failed
 * attempt (attempt 1 = the first retry of a job that failed once).
 * Jitter is multiplicative-only (never shrinks the base spacing) so a
 * cohort of failed jobs on one host cannot re-align into a burst —
 * they spread within [delay, delay * (1 + jitterShare)].
 *
 * The 24 h cap is the charter bound: a permanently failing job waits
 * at most a day between its final attempts, and attempt exhaustion
 * lands it in the EXISTING `failed` terminal state (the future triage
 * surface reads the same rows — nothing new is invented here).
 *
 * Deterministic under an injected jitter source; tests pin the curve.
 */

/** First-retry delay (attempt 1). Conservative v1 default, no knobs. */
export const DEFAULT_RETRY_BASE_MS = 5_000;

/** Geometric growth factor (attempt n → base * factor^(n-1)). */
export const DEFAULT_RETRY_FACTOR = 2;

/** Charter cap: a retry never waits longer than 24 h. */
export const DEFAULT_RETRY_CAP_MS = 24 * 60 * 60 * 1_000;

/** Jitter share: the delay grows by up to +50% (never shrinks). */
export const DEFAULT_RETRY_JITTER_SHARE = 0.5;

export interface RetryBackoffPolicy {
  readonly baseMs: number;
  readonly factor: number;
  readonly capMs: number;
  readonly jitterShare: number;
  /** Uniform [0, 1) source — inject a deterministic one in tests. */
  readonly jitter: () => number;
}

/** Conservative production policy (Math.random jitter). */
export const defaultRetryBackoffPolicy: RetryBackoffPolicy = {
  baseMs: DEFAULT_RETRY_BASE_MS,
  factor: DEFAULT_RETRY_FACTOR,
  capMs: DEFAULT_RETRY_CAP_MS,
  jitterShare: DEFAULT_RETRY_JITTER_SHARE,
  jitter: Math.random,
};

/**
 * The backoff delay (ms) after the `attempts`-th failed attempt.
 * Pure: same policy + attempt count ⇒ same delay (jitter injected).
 */
export function retryBackoffMs(
  policy: RetryBackoffPolicy,
  attempts: number,
): number {
  const exponent = Math.max(0, attempts - 1);
  // Guard the geometric term against float overflow past the cap.
  const growth =
    exponent > 64 ? Number.POSITIVE_INFINITY : policy.factor ** exponent;
  const exponential = policy.baseMs * growth;
  const capped = Math.min(policy.capMs, exponential);
  const share = Math.max(0, Math.min(1, policy.jitterShare));
  const u = Math.max(0, Math.min(1, policy.jitter()));
  return Math.min(policy.capMs, Math.round(capped * (1 + share * u)));
}

/** Merge a partial override over the defaults (assembly/test seam). */
export function resolveRetryBackoffPolicy(
  override?: Partial<RetryBackoffPolicy>,
): RetryBackoffPolicy {
  return { ...defaultRetryBackoffPolicy, ...(override ?? {}) };
}
