import type { SyncPin } from '../pin.js';
import { codeloadZipballUrl } from './config.js';

/**
 * Zipball fetch port (DESIGN.md §6/§8.5): download the pinned commit's
 * zipball from a codeload-shaped base URL. The port exists so tests can
 * serve fixtures over loopback (or inject bytes directly) while production
 * uses plain HTTPS codeload. Integrity is verified downstream by the
 * zipball root-directory SHA check — never trust the transport alone.
 */

export interface ZipballFetcher {
  fetchZipball(pin: SyncPin, codeloadBaseUrl: string): Promise<Uint8Array>;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  /** Refuse archives larger than this (a zipball is ~tens of MiB). */
  readonly maxBytes?: number;
}

export const DEFAULT_ZIPBALL_TIMEOUT_MS = 60_000;
export const DEFAULT_ZIPBALL_MAX_BYTES = 200 * 1024 * 1024;

export class CodeloadZipballFetcher implements ZipballFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: FetchOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ZIPBALL_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_ZIPBALL_MAX_BYTES;
  }

  async fetchZipball(pin: SyncPin, codeloadBaseUrl: string): Promise<Uint8Array> {
    const url = codeloadZipballUrl(pin.repo, pin.sha, codeloadBaseUrl);
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new Error(`zipball fetch failed (${url}): ${errorMessage(error)}`);
    }
    if (response.status !== 200) {
      response.body?.cancel();
      throw new Error(`zipball fetch failed (${url}): HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxBytes) {
      throw new Error(
        `zipball fetch failed (${url}): ${buffer.byteLength} bytes exceeds the ${this.maxBytes}-byte cap`,
      );
    }
    return new Uint8Array(buffer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
