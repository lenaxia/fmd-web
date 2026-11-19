/**
 * Typed job payloads (DESIGN.md §4/§9) — a discriminated union, never a
 * stringly-typed bag. The `type` discriminant is the SQLite `job.type`
 * column; the full payload travels as canonical JSON in `job.payload`
 * and is re-validated with zod on every read (a corrupted or foreign
 * row throws at parse time instead of leaking `any` into the engine).
 *
 * §10 idempotency: a job's fingerprint is the canonical JSON of its
 * payload (sorted keys, recursive) — identical-key replay with an equal
 * fingerprint returns the ORIGINAL job; a differing fingerprint is a
 * conflict (semantics shared with the §10 API store).
 */
import { z } from 'zod';
import type { LaneId } from '@fmd/contract';

/** Download one chapter into the pipeline (§7.1: fetch → postproc → pack). */
export const DownloadChapterJobSchema = z.object({
  type: z.literal('download'),
  moduleId: z.string().min(1),
  mangaUrl: z.string().min(1),
  mangaTitle: z.string().min(1).optional(),
  chapterLink: z.string().min(1),
  chapterName: z.string().min(1).optional(),
  /**
   * The chapter's 1-based ordinal position in the site's chapter list
   * (D1 §7 — the `<numbering>` source). Assigned at ENQUEUE time from
   * the same live chapter list the link-keyed diff / batch resolve
   * uses (FMD2 parity: uSilentThread.pas:338 assigns
   * `Format('%.4d', [i + 1])` while building the task from
   * MangaInfo). NEVER derived by parsing the chapter title; absent =
   * position unknown (the filename template degrades to the chapter
   * name alone).
   */
  chapterPosition: z.number().int().min(1).optional(),
  /** §7.2 favorites provenance: the per-chapter completion dual-writes
   * the favorite-side ledger when this key is present. */
  mangaKey: z.string().min(1).optional(),
  /**
   * FMD2 edSaveTo parity (frmMain.pas:5613): the directory the
   * finalized artifact lands in — REPLACES `library/<manga>`.
   * Relative paths resolve against the library root. (The add-as-stopped
   * `paused` hold is queue-level — a column, not payload.)
   */
  saveTo: z.string().min(1).max(1024).optional(),
});
export type DownloadChapterJob = z.infer<typeof DownloadChapterJobSchema>;

/** Live module info scrape (§10 POST /api/info), §5.8-normalized. */
export const InfoJobSchema = z.object({
  type: z.literal('info'),
  moduleId: z.string().min(1),
  url: z.string().min(1),
  /** §10 info cache TTL override (ms); absent = server default. */
  cacheTtlMs: z.number().int().positive().optional(),
});
export type InfoJob = z.infer<typeof InfoJobSchema>;

/** Favorites refresh sweep (§7.2 `uFavoritesManager` parity) — all
 * favorites, or one module/url slice when `moduleId` is present. */
export const UpdateFavoriteJobSchema = z.object({
  type: z.literal('update'),
  moduleId: z.string().min(1).optional(),
  mangaUrls: z.array(z.string().min(1)).optional(),
});
export type UpdateFavoriteJob = z.infer<typeof UpdateFavoriteJobSchema>;

/** Sync pipeline job (§6): lua modules, one catalog, or all catalogs. */
export const SyncJobSchema = z.object({
  type: z.literal('sync'),
  target: z.enum(['modules', 'catalog', 'catalog-all']),
  /** Required for `target: 'catalog'`. */
  catalogId: z.string().min(1).optional(),
});
export type SyncJob = z.infer<typeof SyncJobSchema>;

/** The typed job payload union — every queue job is exactly one of these. */
export const JobPayloadSchema = z.discriminatedUnion('type', [
  DownloadChapterJobSchema,
  InfoJobSchema,
  UpdateFavoriteJobSchema,
  SyncJobSchema,
]);
export type JobPayload = z.infer<typeof JobPayloadSchema>;

/** Payload discriminants ≡ lane ids (§4: one lane per job family). */
export const JOB_TYPES: readonly JobPayload['type'][] = ['info', 'download', 'update', 'sync'];

/**
 * Lane routing (§4): the payload discriminant selects the lane, so
 * `claim('download')` can never surface an info/update/sync job.
 */
export function laneForPayload(payload: JobPayload): LaneId {
  return payload.type;
}

/** Thrown when a persisted `job.payload` fails schema validation. */
export class InvalidJobPayloadError extends Error {
  public readonly cause_: unknown;

  public constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'InvalidJobPayloadError';
    this.cause_ = cause;
  }
}

/** Parse + validate a payload from its persisted JSON form (never `any`). */
export function parseJobPayload(json: string): JobPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (cause: unknown) {
    throw new InvalidJobPayloadError(`job payload is not valid JSON: ${json.slice(0, 120)}`, cause);
  }
  const parsed = JobPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      `job payload failed schema validation: ${parsed.error.message.slice(0, 200)}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * Canonical JSON (sorted keys, recursive; `undefined` fields dropped) —
 * the §10 idempotency fingerprint input. Semantically identical to the
 * API store's canonicalizer so a payload enqueued through either path
 * fingerprints the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item): string => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]): number => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]): string => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** §10 fingerprint of a job payload (canonical JSON of the typed value). */
export function payloadFingerprint(payload: JobPayload): string {
  return canonicalJson(payload);
}
