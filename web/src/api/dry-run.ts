/**
 * Enqueue dry-run (Manga detail): build the EXACT §10
 * `POST /api/jobs/download` request body client-side — without POSTing
 * — so the UI can preview what an enqueue would send. The request type
 * is the GENERATED operation body, never re-declared.
 */
import type { operations } from './openapi';

/** Generated request-body shape of `POST /api/jobs/download`. */
export type DownloadJobBody = operations['createDownloadJob']['requestBody']['content']['application/json'];

export interface DryRunInput {
  readonly moduleId: string;
  readonly mangaUrl: string;
  readonly mangaTitle?: string;
  readonly chapterLink: string;
  readonly chapterName?: string;
  /** cbAddAsStopped parity: queued but held until resumed. */
  readonly paused?: boolean;
  /** edSaveTo parity: custom finalize directory. */
  readonly saveTo?: string;
}

/** FNV-1a 32-bit over a `|`-joined key, hex — stable across reloads. */
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministic idempotency key (§10: identical-key replays return the
 * ORIGINAL job instead of duplicating it). Stable per
 * (module, manga, chapter) so a retry/re-render never double-enqueues.
 */
export function idempotencyKeyFor(input: DryRunInput): string {
  const key = `dl-${fnv1a32Hex(`${input.moduleId}|${input.mangaUrl}|${input.chapterLink}`)}`;
  return key.length <= 200 ? key : key.slice(0, 200);
}

/** Build the exact enqueue body for one chapter (no request is sent). */
export function buildDownloadJobBody(input: DryRunInput): DownloadJobBody {
  const idempotencyKey = idempotencyKeyFor(input);
  return {
    moduleId: input.moduleId,
    mangaUrl: input.mangaUrl,
    chapterLink: input.chapterLink,
    ...(input.mangaTitle !== undefined ? { mangaTitle: input.mangaTitle } : {}),
    ...(input.chapterName !== undefined ? { chapterName: input.chapterName } : {}),
    ...(input.paused !== undefined ? { paused: input.paused } : {}),
    ...(input.saveTo !== undefined && input.saveTo !== '' ? { saveTo: input.saveTo } : {}),
    idempotencyKey,
  };
}

/** Stable-order JSON rendering of a dry-run body (preview box). */
export function dryRunJson(input: DryRunInput): string {
  const body = buildDownloadJobBody(input);
  const ordered: Record<string, unknown> = {
    moduleId: body.moduleId,
    mangaUrl: body.mangaUrl,
    ...(body.mangaTitle !== undefined ? { mangaTitle: body.mangaTitle } : {}),
    chapterLink: body.chapterLink,
    ...(body.chapterName !== undefined ? { chapterName: body.chapterName } : {}),
    ...(body.paused !== undefined ? { paused: body.paused } : {}),
    ...(body.saveTo !== undefined ? { saveTo: body.saveTo } : {}),
    idempotencyKey: body.idempotencyKey,
  };
  return JSON.stringify(ordered, null, 2);
}
