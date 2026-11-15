/**
 * Live HTTP resolver for the nightly smoke harness: satisfies the §5.4
 * shim's resolver protocol (`resolve()` — the Lua facade is synchronous)
 * over real network using a synchronous `curl` subprocess. This is the
 * ONLY network-enabled resolver in the repo and it is reachable solely
 * from the smoke CLI behind the explicit `--live` flag; the vitest suite
 * forbids external sockets and never imports it at runtime.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Headers } from 'undici';
import {
  RecordedResponseResolver,
  type RecordedRequestRecord,
  type ResolvedRecordedResponse,
} from '../../src/engine/shims/http-shim.js';

/** Live-fetch tuning (conservative skeleton defaults). */
export interface LiveResolverOptions {
  /** Total per-request wall clock in seconds (curl --max-time). */
  readonly maxTimeSeconds: number;
  /** Response body size cap in bytes (curl --max-filesize). */
  readonly maxBytes: number;
  /** TCP connect timeout in seconds (curl --connect-timeout). */
  readonly connectTimeoutSeconds: number;
}

export const DEFAULT_LIVE_OPTIONS: LiveResolverOptions = {
  maxTimeSeconds: 30,
  maxBytes: 8 * 1024 * 1024,
  connectTimeoutSeconds: 10,
};

/** One parsed curl -D header block. */
export interface ParsedHeaderBlock {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
}

/**
 * Build the curl argv for one request (pure — unit-tested). ONE HOP: no
 * `-L` — the landed §5.4 pipeline owns redirect-follow/retry semantics
 * at FMD2 parity (Referer, method rewrite, MaxRedirect) and calls back
 * into this resolver per hop. The body and response headers ride temp
 * files so stdout carries only the status code (spawnSync stdout stays
 * tiny regardless of body size).
 */
export function buildCurlArgs(
  method: string,
  url: string,
  body: string,
  mimeType: string,
  headers: Readonly<Record<string, string>>,
  bodyFile: string,
  headerFile: string,
  options: LiveResolverOptions = DEFAULT_LIVE_OPTIONS,
): string[] {
  const args = [
    '-sS',
    '--max-time',
    String(options.maxTimeSeconds),
    '--connect-timeout',
    String(options.connectTimeoutSeconds),
    // Decompress transparently (FMD2's synapse decompresses when
    // Compress is on; modules need readable HTML to parse).
    '--compressed',
    '--max-filesize',
    String(options.maxBytes),
    '-o',
    bodyFile,
    '-D',
    headerFile,
    '-w',
    '%{http_code}',
  ];
  if (method === 'POST') {
    args.push('-X', 'POST', '--data-binary', body);
    if (mimeType !== '') {
      args.push('-H', `Content-Type: ${mimeType}`);
    }
  } else if (method !== 'GET') {
    args.push('-X', method);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'Content-Type' && method === 'POST' && mimeType !== '') {
      continue; // already pushed from the negotiated MimeType
    }
    args.push('-H', `${name}: ${value}`);
  }
  args.push('--', url);
  return args;
}

/**
 * Parse a curl -D header dump (single hop; multi-block dumps keep the
 * LAST block as the final response — pure, unit-tested).
 */
export function parseHeaderDump(raw: string): ParsedHeaderBlock {
  const blocks = raw.split(/\r?\n\r?\n/u).filter((b) => b.trim() !== '');
  const last = blocks[blocks.length - 1] ?? '';
  const lines = last.split(/\r?\n/u);
  const statusLine = lines.find((l) => l.startsWith('HTTP/')) ?? '';
  const statusMatch = /^HTTP\/[\d.]+ (\d{3})(?: (.*))?$/u.exec(statusLine);
  const headers = new Headers();
  let prevName = '';
  for (const line of lines) {
    if (line.startsWith('HTTP/')) {
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (prevName !== '') {
        headers.append(prevName, line.trim());
      }
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    prevName = name;
    if (name.toLowerCase() === 'set-cookie') {
      headers.append('Set-Cookie', value);
    } else {
      headers.set(name, value);
    }
  }
  return {
    status: statusMatch !== null ? Number(statusMatch[1]) : 0,
    statusText: statusMatch !== null ? (statusMatch[2] ?? '') : '',
    headers,
  };
}

/**
 * The live resolver. Unknown failure modes (DNS, TLS, timeout, size cap)
 * degrade to the Pascal failure shape: status 0, empty body — the shim
 * maps that to ResultCode 0 and the module's own error branch.
 */
export class LiveResponseResolver extends RecordedResponseResolver {
  private readonly workDir = mkdtempSync(join(tmpdir(), 'fmd-smoke-'));
  private seq = 0;

  constructor(private readonly options: LiveResolverOptions = DEFAULT_LIVE_OPTIONS) {
    super([]);
  }

  override resolve(
    method: string,
    url: string,
    body: string,
    mimeType: string,
    headers: Readonly<Record<string, string>>,
  ): ResolvedRecordedResponse {
    const record: RecordedRequestRecord = { method, url, body, mimeType, headers };
    this.requests.push(record);
    const bodyFile = join(this.workDir, `body-${this.seq}`);
    const headerFile = join(this.workDir, `headers-${this.seq}`);
    this.seq += 1;
    const args = buildCurlArgs(
      method,
      url,
      body,
      mimeType,
      headers,
      bodyFile,
      headerFile,
      this.options,
    );
    const result = spawnSync('curl', args, {
      timeout: (this.options.maxTimeSeconds + 10) * 1000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    const statusCode = Number.parseInt(result.stdout.trim(), 10);
    if (result.error !== undefined || !Number.isFinite(statusCode) || statusCode <= 0) {
      return { status: 0, statusText: '', headers: new Headers(), body: '' };
    }
    let headerRaw = '';
    try {
      headerRaw = readFileSync(headerFile, 'utf8');
    } catch {
      return { status: 0, statusText: '', headers: new Headers(), body: '' };
    }
    // Body may be absent when curl died mid-decode (error 61: claimed
    // Content-Encoding it cannot decode — the D18 signature path): the
    // HEADERS still arrived and carry the claimed encoding, so they are
    // salvaged for the D18 inspector instead of discarding the evidence.
    let bodyText = '';
    try {
      bodyText = readFileSync(bodyFile, 'utf8');
    } catch {
      bodyText = '';
    }
    const parsed = parseHeaderDump(headerRaw);
    return {
      status: parsed.status !== 0 ? parsed.status : statusCode,
      statusText: parsed.statusText,
      headers: parsed.headers,
      body: bodyText,
    };
  }

  /** Remove the per-run temp directory (call once after the run). */
  dispose(): void {
    rmSync(this.workDir, { recursive: true, force: true });
  }
}
