import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomic tree install (DESIGN.md §6): the validated staging dir is renamed
 * onto `data/lua/` — same-filesystem renames are atomic, so consumers never
 * observe a partially-written tree. The previous tree (if any) is moved
 * aside first and only deleted after the new tree is in place; any rename
 * failure rolls the previous tree back. Staging therefore happens on the
 * same volume as the data dir.
 */

export interface SwapResult {
  readonly targetDir: string;
  readonly previousExisted: boolean;
}

export function installStagedTree(stagedDir: string, targetDir: string): SwapResult {
  const parent = dirname(targetDir);
  mkdirSync(parent, { recursive: true });
  const previousExisted = existsSync(targetDir);

  if (!previousExisted) {
    renameSync(stagedDir, targetDir);
    return { targetDir, previousExisted };
  }

  const backup = join(parent, `.${basename(targetDir)}.previous-${randomBytes(6).toString('hex')}`);
  renameSync(targetDir, backup);
  try {
    renameSync(stagedDir, targetDir);
  } catch (error) {
    // roll the previous tree back — the swap must never leave a gap
    renameSync(backup, targetDir);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
  return { targetDir, previousExisted };
}
