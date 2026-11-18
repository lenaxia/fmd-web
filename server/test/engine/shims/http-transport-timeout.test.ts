import { afterEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { LoopbackHttpTransport } from '../../../src/engine/shims/http-transport.js';

/**
 * Host-side deadline diagnostics (the MangaPark slow-origin incident):
 * when the worker never answers within the caller's budget (an origin
 * that accepts the connection and stays silent — Cloudflare holding a
 * dying origin for ~20s before its 523 page), the HOST side returns
 * 'timeout' without the worker's writeResult logging ever running for
 * that request. Pre-fix that path was completely silent: the app log
 * carried NOTHING for exactly the failures operators most need to
 * attribute. The timeout must log a '[http-transport]' line, symmetric
 * with the worker's wire-level diagnostics.
 *
 * Hermetic by construction: a loopback listener that accepts and never
 * responds (DESIGN §13 posture — no external network), a transport
 * maxWaitMs BELOW the request timeout so the HOST deadline fires
 * deterministically before the worker's socket-idle timer.
 */
describe('LoopbackHttpTransport host-side timeout diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a [http-transport] line when the host deadline overruns a silent origin', async () => {
    const silent = net.createServer((socket): void => {
      socket.on('data', (): void => undefined); // read and drop: never respond
      socket.on('error', (): void => undefined);
    });
    await new Promise<void>((resolve): void => {
      silent.listen(0, '127.0.0.1', resolve);
    });
    const address = silent.address() as net.AddressInfo;
    const url = `http://127.0.0.1:${String(address.port)}/apo/`;

    const transport = new LoopbackHttpTransport({ allowedHosts: ['*'], maxWaitMs: 1500 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);

    const result = transport.send({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body: '{"query":"{ get_comicNode( id: 77408 ) { data { name } } }"}',
      // request timeout LONGER than the transport's hard wait cap: the
      // host-side deadline (min(12000, 1500) = 1500ms) is the one that
      // fires, not the worker's socket timer
      timeoutMs: 12_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    expect(errorSpy).toHaveBeenCalledWith(
      `[http-transport] timeout after 1500ms: POST ${url}`,
    );

    transport.dispose();
    await new Promise<void>((resolve): void => {
      silent.close((): void => resolve());
    });
  }, 30_000);
});
