/**
 * Grep gate (owner decision 2026-11): the optional-password auth mode
 * is REMOVED and must never return. This test scans the SERVER and WEB
 * source trees (plus the committed OpenAPI snapshot and the generated
 * web bindings) for the password-mode vocabulary — the env var, the
 * login endpoint, the session cookie, the login schemas, the auth-mode
 * literals and the gate plumbing names. Module-ACCOUNT passwords
 * (website credentials in AccountsSection, the accounts API, the FMD2
 * import) are a different concept entirely and use the bare word
 * `password` freely — the patterns here are anchored to the auth-mode
 * vocabulary so those never false-positive.
 *
 * The MIGRATION NOTE (docs/API.md) legitimately mentions
 * FMD_WEB_PASSWORD — docs are deliberately outside the scan scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../../../../web/src', import.meta.url));

/** Password-mode vocabulary that must never reappear in source. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /FMD_WEB_PASSWORD/, what: 'the password env var' },
  { pattern: /\/api\/auth\/login/, what: 'the login endpoint' },
  { pattern: /fmd_session/, what: 'the session cookie' },
  { pattern: /SESSION_COOKIE/, what: 'the session-cookie plumbing' },
  { pattern: /\bLoginRequestSchema\b|\bLoginResponseSchema\b/, what: 'the login schemas (NOT the module-account AccountLogin* family)' },
  { pattern: /ApiTokenModeSchema|\bApiTokenModeT\b|\bAuthMode\b/, what: 'the auth-mode type surface' },
  { pattern: /password\+api-token/, what: 'the password auth-mode literal' },
  {
    pattern: /GATE_EXEMPT|TOKEN_SECRET_ROUTES|registerAuth|checkUpgradeRequest|LoginRateLimit/,
    what: 'the password-gate plumbing',
  },
  { pattern: /'unauthorized'|'rate_limited'|auth="cookie"/, what: 'the removed 401/429/cookie error vocabulary' },
];

const ALLOWED_SUFFIXES = new Set(['.ts', '.tsx', '.json']);

function* walk(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // web/src may be absent in server-only checkouts
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (entry.isFile() && ALLOWED_SUFFIXES.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function violations(): string[] {
  const found: string[] = [];
  for (const file of [...walk(SERVER_ROOT), ...walk(WEB_ROOT)]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(line)) {
          found.push(`${path.relative(path.dirname(SERVER_ROOT), file)}: /${pattern.source}/ (${what}): ${line.trim()}`);
        }
      }
    }
  }
  return found;
}

describe('grep gate: password-mode code must never return', (): void => {
  it('no password strings, modes, endpoints or gate plumbing remain in server or web source', (): void => {
    expect(violations()).toEqual([]);
  });
});
