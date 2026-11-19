// @vitest-environment node
/**
 * Outbound webhook delivery tests (webhook story, D1 §3 pipeline —
 * "at most one webhook, zero channel adapters"): the wire shape and
 * the delivery contract of {@link WebhookNotifier}, pinned against a
 * counting fake transport (no sockets):
 *
 * - HMAC-SHA256 signature: with a secret, every attempt carries
 *   X-FMD-Signature: sha256=<hex> whose MAC recomputes EXACTLY over
 *   the body string the fake received (byte-level coupling pinned);
 * - no secret → unsigned (no header);
 * - 2-retries-then-drop: an always-failing transport sees exactly 3
 *   attempts, the drop lands in the log sink, emit() never throws;
 * - success on a later attempt stops the budget;
 * - per-event-class toggles gate delivery; url '' is the OFF state;
 * - test-send (sendNow) returns the honest awaited report.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WebhookEventClass } from '@fmd/contract';
import { WEBHOOK_SIGNATURE_HEADER } from '@fmd/contract';
import { WebhookNotifier, WEBHOOK_RETRY_BUDGET, type WebhookPostFn } from '../../src/webhook/delivery.js';
import type { WebhookSettingsT } from '../../src/api/schemas.js';

interface RecordedAttempt {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Counting/failing fake transport — every attempt is recorded. */
function makePost(opts: { failFirst?: number; status?: number } = {}):
  { post: WebhookPostFn; attempts: RecordedAttempt[] } {
  const attempts: RecordedAttempt[] = [];
  const post: WebhookPostFn = async (url, body, headers): Promise<{ status: number }> => {
    const record = { url, body, headers };
    attempts.push(record);
    if (opts.failFirst !== undefined && attempts.length <= opts.failFirst) {
      throw new Error(`planted transport failure #${String(attempts.length)}`);
    }
    return { status: opts.status ?? 204 };
  };
  return { post, attempts };
}

function settings(overrides: Partial<WebhookSettingsT> = {}): WebhookSettingsT {
  return {
    url: 'http://receiver.example/hook',
    secret: '',
    events: { chapterDownloaded: true, favoritesDigest: true, failureDigest: true },
    ...overrides,
  };
}

/** Resolve the floating fire-and-forget delivery (zero-timer backoff). */
async function settle(): Promise<void> {
  // setTimeout (NOT setImmediate): the backoff sleeps are clamped
  // setTimeout(0)≈1ms timers — setImmediate turns complete in
  // microseconds and would never let them fire.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve): void => {
      setTimeout(resolve, 0);
    });
  }
}

interface DropLine {
  readonly event: WebhookEventClass;
  readonly attempts: number;
  readonly error: string;
}

function notifier(overrides: {
  settings: WebhookSettingsT;
  post: WebhookPostFn;
  onDrop?: (line: DropLine) => void;
}): WebhookNotifier {
  return new WebhookNotifier({
    settings: (): WebhookSettingsT => overrides.settings,
    post: overrides.post,
    backoffMs: (): number => 0,
    ...(overrides.onDrop !== undefined ? { onDrop: overrides.onDrop } : {}),
  });
}

const SAMPLE = { moduleId: 'm'.repeat(32), mangaTitle: 'Series', chapterLink: 'https://site.example/c1' };

describe('WebhookNotifier delivery contract', (): void => {
  it('POSTs the JSON envelope with content-type and a body that parses', async (): Promise<void> => {
    const fake = makePost();
    const n = notifier({ settings: settings(), post: fake.post });
    n.emit('chapter.downloaded', SAMPLE);
    await settle();
    expect(fake.attempts.length).toBe(1);
    const attempt = fake.attempts[0]!;
    expect(attempt.url).toBe('http://receiver.example/hook');
    expect(attempt.headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(attempt.body) as {
      event: string;
      sentAt: string;
      data: typeof SAMPLE;
    };
    expect(parsed.event).toBe('chapter.downloaded');
    expect(typeof parsed.sentAt).toBe('string');
    expect(parsed.data.chapterLink).toBe(SAMPLE.chapterLink);
  });

  it('signs with HMAC-SHA256 over the EXACT received body when a secret is set', async (): Promise<void> => {
    const fake = makePost();
    const n = notifier({
      settings: settings({ secret: 'topsecret' }),
      post: fake.post,
    });
    n.emit('chapter.downloaded', SAMPLE);
    await settle();
    const attempt = fake.attempts[0]!;
    const header = attempt.headers[WEBHOOK_SIGNATURE_HEADER];
    expect(header).toBeDefined();
    // The receiver-side verification, done exactly as a consumer would:
    // recompute the MAC over the raw bytes that arrived.
    const expected = `sha256=${createHmac('sha256', 'topsecret').update(attempt.body, 'utf8').digest('hex')}`;
    expect(header).toBe(expected);
  });

  it('omits the signature header entirely when no secret is configured', async (): Promise<void> => {
    const fake = makePost();
    const n = notifier({ settings: settings({ secret: '' }), post: fake.post });
    n.emit('favorites.digest', { favoritesChecked: 1 });
    await settle();
    expect(fake.attempts[0]!.headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
  });

  it(`drops after exactly ${String(1 + WEBHOOK_RETRY_BUDGET)} failed attempts, logged, without throwing`, async (): Promise<void> => {
    const fake = makePost({ failFirst: 99 });
    const drops: { event: WebhookEventClass; attempts: number; error: string }[] = [];
    const n = notifier({
      settings: settings(),
      post: fake.post,
      onDrop: (line): void => {
        drops.push(line);
      },
    });
    expect((): void => {
      n.emit('failure.digest', { moduleId: 'm'.repeat(32), failureCount: 1 });
    }).not.toThrow();
    await settle();
    expect(fake.attempts.length).toBe(1 + WEBHOOK_RETRY_BUDGET);
    expect(drops.length).toBe(1);
    expect(drops[0]!.event).toBe('failure.digest');
    expect(drops[0]!.attempts).toBe(1 + WEBHOOK_RETRY_BUDGET);
    expect(drops[0]!.error).toContain('planted transport failure');
  });

  it('treats a non-2xx response as a failed attempt (retry then deliver on 2xx)', async (): Promise<void> => {
    // Always-500: budget exhausts, drop logged with the HTTP status.
    const fiveHundred = makePost({ status: 500 });
    const drops: { event: WebhookEventClass; attempts: number; error: string }[] = [];
    const a = notifier({
      settings: settings(),
      post: fiveHundred.post,
      onDrop: (line): void => {
        drops.push(line);
      },
    });
    a.emit('chapter.downloaded', SAMPLE);
    await settle();
    expect(fiveHundred.attempts.length).toBe(3);
    expect(drops[0]!.error).toBe('HTTP 500');
  });

  it('delivers on a later attempt within the budget and stops retrying', async (): Promise<void> => {
    const fake = makePost({ failFirst: 2 });
    const n = notifier({ settings: settings(), post: fake.post });
    n.emit('chapter.downloaded', SAMPLE);
    await settle();
    expect(fake.attempts.length).toBe(3);
    const bodies = fake.attempts.map((a): string => a.body);
    expect(new Set(bodies).size).toBe(1); // the SAME envelope each retry
  });

  it('url empty string is the OFF state — nothing is POSTed', async (): Promise<void> => {
    const fake = makePost();
    const n = notifier({ settings: settings({ url: '' }), post: fake.post });
    n.emit('chapter.downloaded', SAMPLE);
    await settle();
    expect(fake.attempts.length).toBe(0);
  });

  it('per-event-class toggles gate delivery (muted class = no POST)', async (): Promise<void> => {
    const fake = makePost();
    const n = notifier({
      settings: settings({ events: { chapterDownloaded: false, favoritesDigest: true, failureDigest: false } }),
      post: fake.post,
    });
    n.emit('chapter.downloaded', SAMPLE);
    n.emit('failure.digest', { moduleId: 'm'.repeat(32), failureCount: 1 });
    await settle();
    expect(fake.attempts.length).toBe(0);
    n.emit('favorites.digest', { favoritesChecked: 2 });
    await settle();
    expect(fake.attempts.length).toBe(1);
    expect((JSON.parse(fake.attempts[0]!.body) as { event: string }).event).toBe('favorites.digest');
  });

  it('sendNow (the test-send action) returns the awaited honest report', async (): Promise<void> => {
    const ok = makePost();
    const a = notifier({ settings: settings(), post: ok.post });
    const report = await a.sendNow('webhook.test', { note: 'sample' });
    expect(report).toMatchObject({ delivered: true, attempts: 1, status: 204 });
    const failing = makePost({ failFirst: 99 });
    const b = notifier({ settings: settings(), post: failing.post });
    const dropped = await b.sendNow('webhook.test', { note: 'sample' });
    expect(dropped.delivered).toBe(false);
    expect(dropped.attempts).toBe(3);
    expect(dropped.error).toContain('planted transport failure');
    // No url configured → the honest no-op report (the route 409s first).
    const c = notifier({ settings: settings({ url: '' }), post: ok.post });
    const none = await c.sendNow('webhook.test', { note: 'sample' });
    expect(none).toMatchObject({ delivered: false, attempts: 0 });
  });

  it('a non-http(s) url is refused at the hop (never a generic fetcher)', async (): Promise<void> => {
    const fake = makePost();
    const drops: { event: WebhookEventClass; attempts: number; error: string }[] = [];
    const n = notifier({
      settings: settings({ url: 'file:///etc/passwd' }),
      post: fake.post,
      onDrop: (line): void => {
        drops.push(line);
      },
    });
    n.emit('chapter.downloaded', SAMPLE);
    await settle();
    expect(fake.attempts.length).toBe(0);
    expect(drops[0]!.error).toContain('not http(s)');
  });
});
