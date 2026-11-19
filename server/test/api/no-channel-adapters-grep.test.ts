/**
 * No-channel-adapters grep gate (webhook story, D1 §3 Pipeline:
 * "at most one webhook, zero channel adapters"): per-channel
 * notification adapter code (chat/push service clients, their APIs,
 * their URLs) must NEVER enter the tree. The ONE generic JSON POST
 * webhook is the whole outbound surface; bridging to any specific
 * service is the receiving operator's business. This test scans the
 * SERVER and WEB source trees for the brand vocabulary of the usual
 * suspects — a hit means an adapter (or adapter-shaped naming) landed
 * and CI fails.
 *
 * Scope notes (the auth-removal-gate discipline):
 *   - docs/ are DELIBERATELY outside the scan: design records may NAME
 *     the services when ruling them out (this repo's north star does).
 *   - The OpenAPI snapshot under server/src/api is INSIDE the scan, so
 *     route descriptions stay brand-free by construction — the ruling
 *     is expressed as "chat/push services", never as brand names.
 *   - `slack` is scanned as a WHOLE WORD: the timing-slack local in
 *     engine/sidecar/bypass-adapter.ts was renamed (timingSlack) when
 *     this gate landed so the word can be banned outright.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../../../../web/src', import.meta.url));

/** Per-channel adapter vocabulary that must never appear in source. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\btelegram\b/i, what: 'Telegram adapter code' },
  { pattern: /\bdiscord\b/i, what: 'Discord adapter code' },
  { pattern: /\bntfy\b/i, what: 'ntfy adapter code' },
  { pattern: /\bslack\b/i, what: 'Slack adapter code' },
];

const ALLOWED_SUFFIXES = new Set(['.ts', '.tsx']);

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

describe('no-channel-adapters grep gate (D1 §3: one webhook, zero adapters)', (): void => {
  it('no per-channel notification adapter vocabulary exists in server or web source', (): void => {
    const offenders: string[] = [];
    for (const file of walk(SERVER_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${file}: ${what}`);
          break;
        }
      }
    }
    for (const file of walk(WEB_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${file}: ${what}`);
          break;
        }
      }
    }
    expect(
      offenders,
      'Per-channel adapter code is FORBIDDEN (D1 §3: at most one webhook, zero channel adapters — ' +
        'the generic JSON POST is the whole outbound surface; bridging to a chat/push service is ' +
        'the receiving operator\'s business). Offenders:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
