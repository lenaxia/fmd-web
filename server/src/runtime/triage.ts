/**
 * Triage service (D1 §2 TRIAGE — the one attention surface,
 * tsk-granite-crown-orders): a READ-SIDE aggregation that answers
 * "what needs me" from state that already exists — the §7.1 `failed`
 * job rows (their typed failure kinds + error text) joined with the
 * [site-availability] record. NO new state machine: nothing here
 * writes availability, transitions jobs outside the existing action
 * seams, or schedules anything.
 *
 * Grouping causes (fixed presentation order, all four always present):
 *
 * - `site_dead`    — the module's availability record says
 *   `unreachable`. The record IS the transport-failure accumulator
 *   (written by the ONE shared classifier from download/info traffic
 *   and the manual Check probe), so this group is exactly "the pipe
 *   already observed origin trouble" — the [site-availability] join
 *   the north-star names. A failed row here dims and cross-links to
 *   the registry availability column, but NEVER blocks its retry
 *   (D1 §3: hints dim and explain; an explicit user action always
 *   wins).
 * - `antibot`      — anti-bot / bypass-unavailable vocabulary in the
 *   failure text. HTTP 4xx deliberately writes NO availability
 *   verdict (origin alive but blocking), so text is the only signal
 *   for this class.
 * - `throttled` — HTTP 429 vocabulary in the failure text.
 * - `other`        — everything else (pack/engine faults, worker
 *   stalls, unclassified net failures).
 *
 * Retry-all (`retryGroup`) walks the SAME classification and pushes
 * every row through the SAME per-job retry path the downloads tab
 * uses (`JobService.action(id, 'retry')` — fresh chained attempt,
 * markers resume). Per-host pacing applies to those retries exactly
 * as to fresh work (D1 §2 PIPE) BY CONSTRUCTION: the re-enqueued rows
 * re-enter the download lane, which awaits the shared per-host pacer
 * before a job's first module hop — same-host retries space ≥ the
 * pacing interval apart, never a burst. Availability is not consulted
 * on the retry path at all: a `site_dead` group retries like any
 * other.
 *
 * Superseded failures drop out of the snapshot: a `failed` row whose
 * idempotency-key chain (`<key>#<n>`) has a LIVE successor is back in
 * the pipe and no longer awaits attention (the terminal row lingers
 * until retention pruning — it must not linger in the triage groups).
 */
import { ApiError } from '@fmd/contract';
import type { JobFailureKind } from '@fmd/contract';
import {
  TRIAGE_CAUSES,
  type JobActionTypeT,
  type TriageCauseT,
  type TriageGroupT,
  type TriageJobT,
  type TriageSnapshotResponseT,
  type TriageSiteT,
} from '../api/schemas.js';
import type { JobRecord, JobService } from '../api/services.js';
import type { SiteAvailabilityRecord, SiteAvailabilityService } from './site-availability.js';

/** The availability surfaces the triage join needs (the service shape). */
export type TriageAvailabilitySeam = Pick<SiteAvailabilityService, 'list'>;

/** HTTP 429 family — rate limiting (checked before anti-bot: 429 is 429). */
const RATE_LIMITED_PATTERN = /\b429\b|\btoo many requests\b/i;

/** Anti-bot / bypass-unavailable vocabulary (403 answers, challenges). */
const ANTIBOT_PATTERN = /\b403\b|antibot|anti-bot|bypass|challenge|cloudflare|ddos-guard/i;

/** Failure kinds that are OUR fault, never the origin's — text is noise. */
const NON_SITE_FAILURE_KINDS: readonly JobFailureKind[] = ['pack', 'engine_oom', 'worker_stalled'];

/** What the classifier needs for one failed row. */
export interface TriageClassificationInput {
  /** The typed §4/§7.3 kind recorded on the `→ failed` transition. */
  readonly failureKind: JobFailureKind | undefined;
  /** The row's last failure text (may be absent). */
  readonly error: string | undefined;
  /** The module's LIVE availability record status (unknown when none). */
  readonly availability: 'reachable' | 'unreachable' | 'unknown';
}

/**
 * Group ONE failed job by cause. Pure — the single classification
 * seam shared by the snapshot and retryGroup so a group and its
 * retry-all can never disagree about membership.
 *
 * Order of authority:
 * 1. the availability record (site_dead — the charter's join);
 * 2. the typed failure kind (pack/engine/worker faults are `other`
 *   before any text is read — a zip error mentioning "403" in a file
 *   name must not land in anti-bot);
 * 3. narrow text vocabulary for the two causes availability
 *   deliberately cannot express (4xx writes no verdict).
 */
export function classifyFailedJob(input: TriageClassificationInput): TriageCauseT {
  if (input.availability === 'unreachable') {
    return 'site_dead';
  }
  if (input.failureKind !== undefined && NON_SITE_FAILURE_KINDS.includes(input.failureKind)) {
    return 'other';
  }
  if (RATE_LIMITED_PATTERN.test(input.error ?? '')) {
    return 'throttled';
  }
  if (ANTIBOT_PATTERN.test(input.error ?? '')) {
    return 'antibot';
  }
  return 'other';
}

/** Safe string field read off the opaque job payload record. */
function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The attention-row projection of one failed job row. */
function toTriageJob(job: JobRecord): TriageJobT {
  return {
    id: job.id,
    mangaTitle: payloadString(job.payload, 'mangaTitle'),
    chapterName: payloadString(job.payload, 'chapterName'),
    error: job.error !== undefined && job.error !== '' ? job.error : null,
    failureKind: job.failureKind ?? 'net',
    updatedAt: job.updatedAt,
  };
}

/** `<key>#<n>` chain successors exist LIVE for this failed row's key? */
function hasLiveSuccessor(failed: JobRecord, liveKeys: ReadonlySet<string>): boolean {
  if (failed.idempotencyKey === undefined || failed.idempotencyKey === '') {
    return false; // keyless rows cannot be linked — they stay listed
  }
  for (const key of liveKeys) {
    if (key.startsWith(`${failed.idempotencyKey}#`)) {
      return true;
    }
  }
  return false;
}

/** Newest-first site ordering name first (stable for equal names). */
function bySiteName(a: TriageSiteT, b: TriageSiteT): number {
  const an = a.siteName ?? a.moduleId;
  const bn = b.siteName ?? b.moduleId;
  return an < bn ? -1 : an > bn ? 1 : a.moduleId < b.moduleId ? -1 : 1;
}

export interface TriageDeps {
  /** The job seams the attention surface reads + retries through. */
  readonly jobs: Pick<JobService, 'list' | 'action'>;
  /**
   * The [site-availability] record join. Optional with the
   * /api/modules posture: absent → every module reads `unknown` and
   * the site_dead group stays empty (the runtime assembly always
   * wires the real one).
   */
  readonly availability?: TriageAvailabilitySeam;
  /** Registry name join (absent → siteName renders null). */
  readonly moduleName?: (moduleId: string) => string | undefined;
  /** Clock seam (tests); default wall clock. */
  readonly now?: () => Date;
}

/** One failed row with its computed cause (the internal walk shape). */
interface ClassifiedFailure {
  readonly job: JobRecord;
  readonly cause: TriageCauseT;
}

export class TriageService {
  private readonly jobs: Pick<JobService, 'list' | 'action'>;
  private readonly availability: TriageAvailabilitySeam | undefined;
  private readonly moduleName: ((moduleId: string) => string | undefined) | undefined;
  private readonly now: () => Date;

  public constructor(deps: TriageDeps) {
    this.jobs = deps.jobs;
    this.availability = deps.availability;
    this.moduleName = deps.moduleName;
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** GET /api/triage — all four groups (empty ones included), stable order. */
  public snapshot(): TriageSnapshotResponseT {
    const classified = this.walkFailures();
    const groups: TriageGroupT[] = TRIAGE_CAUSES.map((cause): TriageGroupT => {
      const members = classified.filter((entry): boolean => entry.cause === cause);
      return {
        cause,
        count: members.length,
        sites: this.groupBySite(members).sort(bySiteName),
      };
    });
    return {
      groups,
      failedTotal: classified.length,
      generatedAt: this.now().toISOString(),
    };
  }

  /**
   * POST /api/triage/retry — the paced retry-all for ONE cause group:
   * every member row goes through the SAME per-job retry action the
   * downloads tab uses. Best-effort like bulk-action: a row that raced
   * away (retention prune, concurrent retry) is skipped, not fatal.
   * Availability is NEVER consulted here — no group is refused.
   */
  public retryGroup(cause: TriageCauseT): { cause: TriageCauseT; affected: number; jobs: JobRecord[] } {
    const action: JobActionTypeT = 'retry';
    const touched: JobRecord[] = [];
    for (const { job } of this.walkFailures(cause)) {
      try {
        touched.push(this.jobs.action(job.id, action));
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          continue; // row moved between the walk and the action — skip
        }
        throw error;
      }
    }
    return { cause, affected: touched.length, jobs: touched };
  }

  /**
   * The failed-row walk: cursor-paged `state=failed` reads, minus rows
   * superseded by a LIVE retry-chain successor, each classified once.
   * Optionally narrowed to one cause (the retry-all membership).
   */
  private walkFailures(only?: TriageCauseT): readonly ClassifiedFailure[] {
    const availability = this.availability !== undefined ? this.availability.list() : undefined;
    const liveKeys = this.liveChainKeys();
    const out: ClassifiedFailure[] = [];
    let cursor: string | undefined;
    // Keyset pagination (stable under inserts); retention bounds the
    // terminal set, so the walk is finite by construction.
    for (;;) {
      const page = this.jobs.list({ state: 'failed', limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
      for (const job of page.jobs) {
        if (hasLiveSuccessor(job, liveKeys)) {
          continue;
        }
        const record: SiteAvailabilityRecord | undefined = availability?.get(job.moduleId);
        const cause = classifyFailedJob({
          failureKind: job.failureKind,
          error: job.error,
          availability: record?.status ?? 'unknown',
        });
        if (only === undefined || cause === only) {
          out.push({ job, cause });
        }
      }
      cursor = page.nextCursor;
      if (cursor === undefined) {
        return out;
      }
    }
  }

  /** Live-row idempotency keys (the successor probe for exclusions). */
  private liveChainKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    const states = ['queued', 'running', 'retry'] as const;
    let cursor: string | undefined;
    for (;;) {
      const page = this.jobs.list({ states, limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
      for (const job of page.jobs) {
        if (job.idempotencyKey !== undefined && job.idempotencyKey !== '') {
          keys.add(job.idempotencyKey);
        }
      }
      cursor = page.nextCursor;
      if (cursor === undefined) {
        return keys;
      }
    }
  }

  /** Members → per-site buckets (insertion order = newest-first rows). */
  private groupBySite(members: readonly ClassifiedFailure[]): TriageSiteT[] {
    const availability = this.availability !== undefined ? this.availability.list() : undefined;
    const jobsBySite = new Map<string, TriageJobT[]>();
    const sites: TriageSiteT[] = [];
    for (const { job } of members) {
      let bucket = jobsBySite.get(job.moduleId);
      if (bucket === undefined) {
        bucket = [];
        jobsBySite.set(job.moduleId, bucket);
        sites.push({
          moduleId: job.moduleId,
          siteName: this.moduleName?.(job.moduleId) ?? null,
          availability: availability?.get(job.moduleId) ?? {
            status: 'unknown',
            checkedAt: null,
            reason: null,
          },
          jobs: bucket,
        });
      }
      bucket.push(toTriageJob(job));
    }
    return sites;
  }
}
