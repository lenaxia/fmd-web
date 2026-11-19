// @vitest-environment node
/**
 * Webhook settings API tests (webhook story): the ONE webhook's config
 * surface — PUT /api/settings/webhook (full-group replacement + url
 * validation), the `webhook` group riding GET /api/settings, and the
 * POST /api/settings/webhook/test action (409 unconfigured; honest
 * report through the injected notifier seam). Rides the shared
 * §10 offline harness (fastify.inject only).
 */
import { describe, expect, it } from 'vitest';
import { buildHarness } from './helpers.js';

const WEBHOOK_URL = 'http://receiver.example/hook';

function makeWebhookTestSend(
  report: { delivered: boolean; attempts: number; status?: number; error?: string },
): { sendTestEvent(): Promise<typeof report> } {
  return {
    sendTestEvent: (): Promise<typeof report> => Promise.resolve({ ...report }),
  };
}

describe('webhook settings API', (): void => {
  it('GET /api/settings carries the webhook group, off by default', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { webhook: { url: string; secret: string; events: Record<string, boolean> } };
    expect(body.webhook).toEqual({
      url: '',
      secret: '',
      events: { chapterDownloaded: true, favoritesDigest: true, failureDigest: true },
    });
  });

  it('PUT replaces url + secret + toggles and round-trips through GET', async (): Promise<void> => {
    const h = buildHarness();
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/webhook',
      payload: { url: WEBHOOK_URL, secret: 'signing-secret', events: { failureDigest: false } },
    });
    expect(put.statusCode).toBe(200);
    const after = (put.json() as { webhook: { url: string; secret: string; events: Record<string, boolean> } }).webhook;
    expect(after.url).toBe(WEBHOOK_URL);
    expect(after.secret).toBe('signing-secret');
    expect(after.events).toEqual({ chapterDownloaded: true, favoritesDigest: true, failureDigest: false });
    const get = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(((get.json() as { webhook: { url: string } }).webhook).url).toBe(WEBHOOK_URL);
  });

  it('a non-http(s) or unparseable url is a typed 400', async (): Promise<void> => {
    const h = buildHarness();
    for (const url of ['ftp://receiver.example/hook', 'not a url at all']) {
      const res = await h.app.inject({ method: 'PUT', url: '/api/settings/webhook', payload: { url } });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('validation_error');
    }
    // The empty string stays legal (the OFF state).
    const off = await h.app.inject({ method: 'PUT', url: '/api/settings/webhook', payload: { url: '' } });
    expect(off.statusCode).toBe(200);
  });

  it('the empty body still parses (all-defaults: off + all toggles on)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'PUT', url: '/api/settings/webhook', payload: {} });
    expect(res.statusCode).toBe(200);
    const webhook = (res.json() as { webhook: { url: string; secret: string; events: Record<string, boolean> } }).webhook;
    expect(webhook.url).toBe('');
    expect(webhook.events.chapterDownloaded).toBe(true);
  });

  it('test-send: 409 when no url is configured, honest report when wired', async (): Promise<void> => {
    // The 409 needs the ROUTE mounted (seam wired) with the webhook off.
    const unconfigured = buildHarness({
      webhookTestSend: makeWebhookTestSend({ delivered: true, attempts: 1, status: 204 }),
    });
    const refused = await unconfigured.app.inject({ method: 'POST', url: '/api/settings/webhook/test' });
    expect(refused.statusCode).toBe(409);

    const h2 = buildHarness({
      webhookTestSend: makeWebhookTestSend({ delivered: false, attempts: 3, error: 'HTTP 500' }),
    });
    await h2.app.inject({ method: 'PUT', url: '/api/settings/webhook', payload: { url: WEBHOOK_URL } });
    const res = await h2.app.inject({ method: 'POST', url: '/api/settings/webhook/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: false, attempts: 3, error: 'HTTP 500' });

    const ok = buildHarness({
      webhookTestSend: makeWebhookTestSend({ delivered: true, attempts: 1, status: 204 }),
    });
    await ok.app.inject({ method: 'PUT', url: '/api/settings/webhook', payload: { url: WEBHOOK_URL } });
    const okRes = await ok.app.inject({ method: 'POST', url: '/api/settings/webhook/test' });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toEqual({ delivered: true, attempts: 1, status: 204 });
  });

  it('the test route is not mounted when the notifier seam is absent (covers posture)', async (): Promise<void> => {
    const h = buildHarness(); // no webhookTestSend
    await h.app.inject({ method: 'PUT', url: '/api/settings/webhook', payload: { url: WEBHOOK_URL } });
    const res = await h.app.inject({ method: 'POST', url: '/api/settings/webhook/test' });
    expect(res.statusCode).toBe(404);
  });
});
