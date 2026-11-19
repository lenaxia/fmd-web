/**
 * Outbound webhook delivery (DESIGN-NORTHSTAR §3 Pipeline: "at most one
 * webhook, zero channel adapters") — the ONE generic JSON POST this app
 * will ever make for notifications. Bridging to any chat/push service is
 * the operator's business (their own receiver); no per-channel adapter
 * code exists in this tree and the no-channel-adapters grep gate keeps
 * it that way.
 *
 * Posture (charter-pinned): fire-and-forget and ADVISORY — the inbox
 * remains the source of truth, so delivery is lossy-tolerated:
 *
 * - `emit()` NEVER throws and never blocks the caller: it builds the
 *   envelope synchronously, then delivers on a floating promise.
 * - Each delivery gets the FULL retry budget (initial attempt + 2
 *   retries = 3 attempts max); after that the event is DROPPED with a
 *   structured log line. There is no queue, no persistence, no
 *   redelivery machinery — a dropped webhook is a dropped log line.
 * - With a secret configured, every attempt carries
 *   {@link WEBHOOK_SIGNATURE_HEADER}: `sha256=<hex>` — the HMAC-SHA256
 *   of the EXACT serialized body string under the secret, so a receiver
 *   recomputes the MAC over the raw bytes it received. No secret → the
 *   header is omitted (unsigned deliveries).
 *
 * The HTTP hop is a transport seam (`WebhookPostFn`) so tests pin the
 * wire shape (body, headers, signature, retry count, drop logging)
 * without sockets; the production implementation is global fetch. The
 * destination is OPERATOR-configured (PUT /api/settings/webhook) and
 * validated http(s) at the settings layer — this module re-checks the
 * scheme before every hop and drops anything else.
 */

import { createHmac } from 'node:crypto';
import type { WebhookEnvelope, WebhookEventClass } from '@fmd/contract';
import { WEBHOOK_SIGNATURE_HEADER } from '@fmd/contract';
import type { WebhookSettingsT } from '../api/schemas.js';

/**
 * One POST attempt. Resolves with the HTTP status on any response and
 * rejects on transport failure/timeout — both count as failed attempts
 * for the retry budget.
 */
export type WebhookPostFn = (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<{ status: number }>;

/** Production transport: global fetch with a hard per-attempt timeout. */
export const fetchWebhookPost: WebhookPostFn = async (url, body, headers, timeoutMs) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // The body is never consumed by us — drain it so the socket frees.
  await response.arrayBuffer().catch((): void => undefined);
  return { status: response.status };
};

/** What happened to one delivered (or dropped) event. */
export interface WebhookDeliveryReport {
  /** True iff some attempt returned a 2xx status. */
  readonly delivered: boolean;
  /** POST attempts actually made (0..3). */
  readonly attempts: number;
  /** Last HTTP status seen (absent when every attempt failed pre-response). */
  readonly status?: number;
  /** Last failure message (absent when delivered). */
  readonly error?: string;
}

export interface WebhookNotifierDeps {
  /** Live settings read (the in-memory settings service — cheap). */
  readonly settings: () => WebhookSettingsT;
  /** Transport seam (tests inject a fake; production uses fetch). */
  readonly post?: WebhookPostFn;
  /** Per-attempt timeout (default 10 s). */
  readonly timeoutMs?: number;
  /** Delay between retries (default 500 ms then 1000 ms; injectable for tests). */
  readonly backoffMs?: (attempt: number) => number;
  /** Wall clock (default Date.now). */
  readonly now?: () => number;
  /** Drop/failure log line sink (the structured logger, event-scoped). */
  readonly onDrop?: (line: { event: WebhookEventClass; attempts: number; error: string }) => void;
}

/** Total attempts per event: the initial POST + 2 retries (charter). */
export const WEBHOOK_RETRY_BUDGET = 2;

function defaultBackoff(attempt: number): number {
  return attempt <= 1 ? 500 : 1_000;
}

/**
 * Serializes + signs one envelope. The signature MACs the EXACT string
 * that goes on the wire (body and header derive from the same bytes).
 */
export function serializeEnvelope(
  secret: string,
  envelope: WebhookEnvelope<unknown>,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'fmd-web-webhook',
  };
  if (secret !== '') {
    headers[WEBHOOK_SIGNATURE_HEADER] = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  }
  return { body, headers };
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether the toggle for one event class admits deliveries. */
export function eventEnabled(settings: WebhookSettingsT, event: WebhookEventClass): boolean {
  switch (event) {
    case 'chapter.downloaded':
      return settings.events.chapterDownloaded;
    case 'favorites.digest':
      return settings.events.favoritesDigest;
    case 'failure.digest':
      return settings.events.failureDigest;
    case 'webhook.test':
      // Explicit user action — never toggle-gated (and never emitted
      // by the runtime either; only the test-send route reaches it).
      return true;
  }
}

export class WebhookNotifier {
  private readonly post: WebhookPostFn;
  private readonly timeoutMs: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly now: () => number;

  public constructor(private readonly deps: WebhookNotifierDeps) {
    this.post = deps.post ?? fetchWebhookPost;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.backoffMs = deps.backoffMs ?? defaultBackoff;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Fire-and-forget emit: consults the url + the event toggle, then
   * delivers on a floating promise with the full retry budget. NEVER
   * throws — a disabled or dropped webhook is never the caller's
   * problem (the pipe never blocks on notifications, D1 §3).
   */
  public emit(event: WebhookEventClass, data: unknown): void {
    const settings = this.deps.settings();
    if (settings.url === '' || !eventEnabled(settings, event)) {
      return;
    }
    void this.deliver(event, data, settings).catch((): void => {
      // deliver() already swallows everything; this belt-and-braces
      // clause keeps emit's never-throws contract total.
    });
  }

  /**
   * The test-send action's awaited path: ONE full delivery cycle (up
   * to 3 attempts) and the honest report back to the operator. This is
   * the ONLY place delivery is awaited — real events stay
   * fire-and-forget.
   */
  public async sendNow(event: WebhookEventClass, data: unknown): Promise<WebhookDeliveryReport> {
    const settings = this.deps.settings();
    if (settings.url === '') {
      return { delivered: false, attempts: 0, error: 'no webhook url configured' };
    }
    // webhook.test bypasses toggles by construction (eventEnabled);
    // other classes honor them even on the awaited path.
    if (!eventEnabled(settings, event)) {
      return { delivered: false, attempts: 0, error: `event class ${event} is disabled` };
    }
    return this.deliver(event, data, settings);
  }

  private async deliver(
    event: WebhookEventClass,
    data: unknown,
    settings: WebhookSettingsT,
  ): Promise<WebhookDeliveryReport> {
    const { body, headers } = serializeEnvelope(settings.secret, {
      event,
      sentAt: new Date(this.now()).toISOString(),
      data,
    });
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    const maxAttempts = 1 + WEBHOOK_RETRY_BUDGET;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!isHttpUrl(settings.url)) {
        // Belt-and-braces: the settings layer validated this, but the
        // outbound hop re-checks (never an accidental generic fetcher).
        const error = `webhook url is not http(s): ${settings.url}`;
        this.deps.onDrop?.({ event, attempts: attempt - 1, error });
        return { delivered: false, attempts: attempt - 1, error };
      }
      try {
        const result = await this.post(settings.url, body, headers, this.timeoutMs);
        lastStatus = result.status;
        if (result.status >= 200 && result.status < 300) {
          return { delivered: true, attempts: attempt, status: result.status };
        }
        lastError = `HTTP ${String(result.status)}`;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve): void => {
          setTimeout(resolve, this.backoffMs(attempt));
        });
      }
    }
    // Budget exhausted: DROP with a log line — lossy-tolerated by
    // contract; the inbox (and TRIAGE) remain the source of truth.
    this.deps.onDrop?.({ event, attempts: maxAttempts, error: lastError ?? 'unknown' });
    return {
      delivered: false,
      attempts: maxAttempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      error: lastError ?? 'unknown',
    };
  }
}
