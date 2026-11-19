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
 * naming idiom — `telegramAdapter`, `sendDiscordMessage`,
 * `ntfyClient`-style camelCase evaded word boundaries. The second bounce
 * (sober-melon-weeds) then caught the worse, older hole underneath:
 * WEB_ROOT was spelled one level too high (`../../../../web/src`
 * resolved OUTSIDE the repo to /workspace/web/src), the walk()'s
 * silent catch swallowed the dead path, and the web tree contributed
 * ZERO files to every scan — adapter code in web/src entered green
 * while the gate read clean. Both are structural now:
 *
 *   - LOUD roots: each scan root must EXIST and yield a non-empty
 *     file set — a scan that can quietly shrink to zero files is
 *     exactly how this shipped green, so absence/warp is a hard
 *     failure, never a silent pass;
 *   - the mutation proof (scripts/no-channel-adapters-mutate.sh,
 *     wired into ci.sh) plants adapter-shaped fixtures in BOTH roots
 *     and requires this gate to FAIL — M3 is the web-root leg that
 *     pins the anchoring.
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
const WEB_ROOT = fileURLToPath(new URL('../../../web/src', import.meta.url));

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

/**
 * LOUD walk: a missing/unreadable root THROWS instead of silently
 * contributing nothing (the failure mode that shipped the web tree
 * unscanned). Callers additionally assert a non-empty yield.
 */
function* walk(root: string): Generator<string> {
  const entries = fs.readdirSync(root, { withFileTypes: true });
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
  it('both scan roots are live and non-empty (the anchoring is loud, never silent)', (): void => {
    for (const root of [SERVER_ROOT, WEB_ROOT]) {
      expect(fs.existsSync(root), `scan root missing: ${root}`).toBe(true);
      const files = [...walk(root)];
      expect(
        files.length,
        `scan root walked zero files: ${root} (a silently-empty scan is how adapter code once entered green)`,
      ).toBeGreaterThan(0);
    }
  });

  it('no per-channel notification adapter vocabulary exists in server or web source', (): void => {
    const offenders: string[] = [];
    for (const file of [...walk(SERVER_ROOT), ...walk(WEB_ROOT)]) {
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
