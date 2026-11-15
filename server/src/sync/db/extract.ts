/**
 * 7z extraction (DESIGN.md §6.3): `7zz x` into a temp dir — the extract
 * target is always fresh, never the live catalogs dir; the caller moves
 * the extracted db into place with an atomic rename.
 *
 * The extractor binary is docker-shipped (Dockerfile installs it next to
 * the runtime tree). Resolution order: explicit path → `FMD_CATALOG_7ZZ`
 * env → `7zz` → `7za` on PATH → the 7zip-bin dev/runtime binary. Tests
 * inject an explicit path (or a fake) so extraction runs offline.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Extractor {
  /** Extract `archivePath` into `destDir` (created, must be empty/fresh). */
  extract(archivePath: string, destDir: string): Promise<void>;
}

/** Locate the docker-shipped 7z binary (7zz preferred, 7za compatible). */
export function resolveSevenZipBinary(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }
  const env: string | undefined = process.env['FMD_CATALOG_7ZZ'];
  if (env !== undefined && env !== '') {
    return env;
  }
  for (const bin of ['7zz', '7za'] as const) {
    const found: string | undefined = which(bin);
    if (found !== undefined) {
      return found;
    }
  }
  // 7zip-bin ships a real 7za per-platform (docker layer via node_modules).
  try {
    const require: NodeRequire = createRequire(import.meta.url);
    const bundled: string = require.resolve('7zip-bin/linux/x64/7za');
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // fall through
  }
  throw new Error('no 7z extractor binary found (FMD_CATALOG_7ZZ, 7zz, 7za, 7zip-bin)');
}

function which(bin: string): string | undefined {
  const dirs: readonly string[] = (process.env['PATH'] ?? '').split(':');
  for (const dir of dirs) {
    if (dir === '') {
      continue;
    }
    const candidate: string = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/** Spawn-based extractor over a real 7z binary (default `7zz`). */
export class SevenZipExtractor implements Extractor {
  constructor(
    private readonly binary: string = resolveSevenZipBinary(),
    private readonly timeoutMs: number = 120_000,
  ) {}

  extract(archivePath: string, destDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.mkdirSync(destDir, { recursive: true });
      // `x` keeps the archive's stored paths; -y overwrite-all; -o dest.
      const child = spawn(this.binary, ['x', '-y', '-aoa', `-o${destDir}`, archivePath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr: string = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const timer: NodeJS.Timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, this.timeoutMs);
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`7z spawn failed (${this.binary}): ${err.message}`));
      });
      child.on('close', (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        if (signal !== null) {
          reject(new Error(`7z killed by ${signal}: ${stderr.slice(-400)}`));
        } else if (code !== 0) {
          reject(new Error(`7z exit ${String(code)}: ${stderr.slice(-400)}`));
        } else {
          resolve();
        }
      });
    });
  }
}

/** Recursively list files under `dir` (relative paths, '/'-normalized). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel: string = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}
