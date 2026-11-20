/**
 * Site availability store + service (dead-site discovery,
 * tsk-amber-pivot-refrains): ONE persisted record per module —
 * `status` reachable|unreachable (absent row = unknown, seeded for
 * every never-touched site), `checked_at`, and a short `reason`.
 *
 * Owner-scoped minimalism (deliberate): NO staleness timers, NO
 * background re-probes, NO auto-removal or gating. A later success
 * flips `unreachable` back to `reachable` by construction — every
 * write path goes through {@link SqliteSiteAvailabilityService.record}
 * with the conservative verdict from
 * `engine/services/availability.ts` (transport/5xx → unreachable+reason,
 * 2xx/3xx → reachable, 4xx → no write at all).
 *
 * §9 table `site_availability(module_id PK, status, reason,
 * checked_at)` in app.db — same better-sqlite3 sync discipline as the
 * library/favorites stores (writes are single-statement, safe to call
 * fire-and-forget from traffic-path sinks).
 */
import type Database from 'better-sqlite3';
import { classifyHttpOutcome, type SiteAvailabilityOutcome } from '../engine/facade.js';

/** The wire/record status; `unknown` exists only as the absent-row view. */
export type SiteAvailabilityStatus = 'reachable' | 'unreachable' | 'unknown';

/** The per-module availability record as the API serves it. */
export interface SiteAvailabilityRecord {
  readonly status: SiteAvailabilityStatus;
  /** ISO timestamp of the last confident write (null = never checked). */
  readonly checkedAt: string | null;
  /** Short reason carried by the last `unreachable` write. */
  readonly reason: string | null;
}

/** The record + the module it belongs to (the list join shape). */
export interface SiteAvailabilityEntry extends SiteAvailabilityRecord {
  readonly moduleId: string;
}

export const UNKNOWN_AVAILABILITY: SiteAvailabilityRecord = {
  status: 'unknown',
  checkedAt: null,
  reason: null,
};

/**
 * The manual Check probe result: what the probe concluded
 * (`none` = ambiguous 4xx/no verdict — record intentionally
 * unchanged) plus a human classification note for the UI.
 */
export interface SiteCheckResult {
  readonly moduleId: string;
  readonly verdict: 'reachable' | 'unreachable' | 'none';
  readonly detail: string;
  readonly availability: SiteAvailabilityRecord;
}

/** The app-level seam the API layer consumes (tests inject fakes). */
export interface SiteAvailabilityService {
  record(moduleId: string, outcome: SiteAvailabilityOutcome): void;
  get(moduleId: string): SiteAvailabilityRecord;
  list(): ReadonlyMap<string, SiteAvailabilityRecord>;
  /**
   * Manual per-row Check (Settings registry): ONE probe of the
   * module RootURL through the module's own engine HTTP path
   * (worker-isolated), then the same record + classification as the
   * opportunistic paths. NEVER batched, never scheduled.
   */
  check(moduleId: string): Promise<SiteCheckResult>;
}

export function ensureSiteAvailabilitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_availability (
      module_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('reachable', 'unreachable')),
      reason TEXT,
      checked_at INTEGER NOT NULL
    )
  `);
}

interface RowShape {
  readonly module_id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly checked_at: number;
}

function toRecord(row: RowShape | undefined): SiteAvailabilityRecord {
  if (row === undefined) {
    return UNKNOWN_AVAILABILITY;
  }
  return {
    status: row.status === 'unreachable' ? 'unreachable' : 'reachable',
    checkedAt: new Date(row.checked_at).toISOString(),
    reason: row.reason ?? null,
  };
}

export class SqliteSiteAvailabilityStore {
  private readonly upsertRow: Database.Statement;
  private readonly getRow: Database.Statement;
  private readonly listRows: Database.Statement;

  public constructor(db: Database.Database) {
    ensureSiteAvailabilitySchema(db);
    this.upsertRow = db.prepare(
      `INSERT INTO site_availability (module_id, status, reason, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module_id) DO UPDATE SET
         status = excluded.status,
         reason = excluded.reason,
         checked_at = excluded.checked_at`,
    );
    this.getRow = db.prepare('SELECT module_id, status, reason, checked_at FROM site_availability WHERE module_id = ?');
    this.listRows = db.prepare('SELECT module_id, status, reason, checked_at FROM site_availability ORDER BY module_id');
  }

  write(moduleId: string, status: 'reachable' | 'unreachable', reason: string | null, checkedAt: number): void {
    this.upsertRow.run(moduleId, status, reason, checkedAt);
  }

  read(moduleId: string): SiteAvailabilityRecord {
    return toRecord(this.getRow.get(moduleId) as RowShape | undefined);
  }

  readAll(): ReadonlyMap<string, SiteAvailabilityRecord> {
    const out = new Map<string, SiteAvailabilityRecord>();
    for (const row of this.listRows.all() as RowShape[]) {
      out.set(row.module_id, toRecord(row));
    }
    return out;
  }
}

/**
 * The production service: the SQLite record + the worker-isolated
 * probe port. The probe is injected (the engine thread's
 * `availability.check` op in production; a loopback stand-in or a
 * scripted fake in tests) and returns the RAW pipeline outcome — the
 * classification happens HERE through the one shared classifier so
 * the manual path and the opportunistic paths can never disagree.
 */
export class SqliteSiteAvailabilityService implements SiteAvailabilityService {
  public constructor(
    private readonly store: SqliteSiteAvailabilityStore,
    private readonly probe: (moduleId: string) => Promise<{ readonly resultCode: number; readonly resultString: string }>,
    private readonly now: () => number = (): number => Date.now(),
  ) {}

  record(moduleId: string, outcome: SiteAvailabilityOutcome): void {
    this.store.write(
      moduleId,
      outcome.verdict,
      outcome.reason ?? null,
      this.now(),
    );
  }

  get(moduleId: string): SiteAvailabilityRecord {
    return this.store.read(moduleId);
  }

  list(): ReadonlyMap<string, SiteAvailabilityRecord> {
    return this.store.readAll();
  }

  async check(moduleId: string): Promise<SiteCheckResult> {
    const raw = await this.probe(moduleId);
    const outcome = classifyHttpOutcome(raw.resultCode, raw.resultString);
    if (outcome === undefined) {
      return {
        moduleId,
        verdict: 'none',
        detail: probeNoVerdictDetail(raw.resultCode, raw.resultString),
        availability: this.store.read(moduleId),
      };
    }
    this.record(moduleId, outcome);
    return {
      moduleId,
      verdict: outcome.verdict,
      detail:
        outcome.verdict === 'reachable'
          ? `Reachable (HTTP ${String(raw.resultCode)})`
          : `Unreachable — ${outcome.reason ?? 'no reason'}`,
      availability: this.store.read(moduleId),
    };
  }
}

function probeNoVerdictDetail(resultCode: number, resultString: string): string {
  const code = Math.trunc(resultCode);
  if (code >= 400 && code < 500) {
    return `No verdict — origin answered HTTP ${String(code)} (alive but possibly blocking); record unchanged`;
  }
  const text = resultString.trim();
  if (text !== '') {
    return `No verdict — ${text.slice(0, 160)}; record unchanged`;
  }
  return 'No verdict — the probe produced no readable HTTP outcome; record unchanged';
}
