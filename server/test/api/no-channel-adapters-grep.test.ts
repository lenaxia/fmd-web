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
 * Pattern shape — case-insensitive SUBSTRINGS, deliberately UNANCHORED:
 * a `\b` whole-word form was shipped first and the review bounce
 * (merry-woodland-refrains) proved it green under this codebase's own
 * naming idiom — `telegramAdapter`, `sendDiscordMessage`, `ntfyClient`,
 * `slackWebhookUrl` all evaded word boundaries. Substring matching
 * catches every casing/compound shape; the mutation proof lives in
 * scripts/no-channel-adapters-mutate.sh (the engine-boundary-mutate
 * discipline: adapter-shaped fixtures planted in BOTH roots must make
 * this gate FAIL).
 *
 * Scope notes (the auth-removal-gate discipline):
 *   - docs/ are DELIBERATELY outside the scan: design records may NAME
 *     the services when ruling them out (this repo's north star does).
 *   - .json IS scanned — the committed OpenAPI snapshot under
 *     server/src/api is inside the tree it pins, so route descriptions
 *     stay brand-free by construction ("chat/push services", never
 *     brand names).
 *   - engine/sidecar/bypass-adapter.ts's timing constant is named
 *     `timingMargin` precisely because a brand-shaped substring (any
 *     casing) would trip this gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../../../../web/src', import.meta.url));

/**
 * Per-channel adapter vocabulary that must never appear in source —
 * case-insensitive SUBSTRINGS (see the header: word anchors let
 * camelCase identifiers through; the mutation script pins this).
 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /telegram/i, what: 'Telegram adapter code' },
  { pattern: /discord/i, what: 'Discord adapter code' },
  { pattern: /ntfy/i, what: 'ntfy adapter code' },
  { pattern: /slack/i, what: 'Slack adapter code' },
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
