import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 'W'/'D' marker persistence (DESIGN §7.1 "persisted, resumable across
 * restarts"): the ChapterPipeline PageLinks state survives the process
 * in the chapter work dir as an atomic JSON write — the resume
 * contract: after a cancelled job, `readMarkers` re-seeds 'D' slots so
 * only the remaining images are fetched.
 */

export const MARKERS_FILE = 'markers.json';

/** Atomic write: tmp + rename inside the work dir. */
export function writeMarkers(workDir: string, pageLinks: readonly string[]): void {
  // The work dir may not exist yet (no image saved — e.g. a retry
  // scenario where every fetch failed); markers are the resume
  // contract, so the write must not depend on saveImage having run.
  mkdirSync(workDir, { recursive: true });
  const target = path.join(workDir, MARKERS_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify([...pageLinks]), 'utf8');
  renameSync(tmp, target);
}

/**
 * The persisted marker list, or undefined when absent/corrupt (a fresh
 * chapter, or a damaged file — resume then falls back to the
 * file-on-disk reconciliation, CheckForExists).
 */
export function readMarkers(workDir: string): string[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(workDir, MARKERS_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.map((v) => (typeof v === 'string' ? v : ''));
  } catch {
    return undefined;
  }
}
