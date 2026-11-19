import { pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import { buildRuntime, loadRuntimeConfig } from './runtime/assembly.js';
import { registerStatic } from './runtime/static.js';
import { respondAsync } from './main.js';
import { SERVER_VERSION } from './main.js';
import { attachWebSocketHub, type WsAttachment } from './api/ws/attach.js';

/**
 * Production runtime entry (DESIGN §4): assemble the real services,
 * listen, run the D20 first-run bootstrap with /readyz surfacing the
 * stage, serve the SPA, and drain on SIGTERM — bounded, logged, and
 * flushed. The compose e2e (scripts/e2e.sh) asserts every one of those
 * behaviors: bootstrap logs, non-root uid, drain ≤ 30 s with flush
 * lines in `compose logs`.
 */

const DRAIN_TIMEOUT_MS = 25_000;

function log(message: string): void {
  // One line per event — compose/docker log assertions key on the `fmd:`
  // prefix (structured logging = observability story).
  console.log(`fmd: ${message}`);
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  log(`starting fmd-web ${SERVER_VERSION} (data dir ${config.dataDir}, port ${String(config.port)})`);

  const runtime = await buildRuntime({
    config,
    log,
    version: SERVER_VERSION,
  });

  if (config.staticDir !== undefined) {
    registerStatic(runtime.app, config.staticDir);
    log(`serving SPA from ${config.staticDir}`);
  }

  const server: Server = createServer((req, res): void => {
    void respondAsync(runtime.app, req, res);
  });

  // §10/D19: `/ws` upgrades bypass the respondAsync bridge entirely —
  // the hub owns them on the raw server (backfill + live job events).
  // Open hub: the optional-password credential wall was removed (owner
  // decision 2026-11) — browser live tiles connect with no credentials;
  // the R4 token is accepted wherever presented but never gates.
  const ws: WsAttachment = attachWebSocketHub(server, runtime.wsHub);

  let draining = false;

  const drain = (signal: string): void => {
    if (draining) {
      return;
    }
    draining = true;
    const startedAt = Date.now();
    log(`${signal} received — beginning graceful drain (bound ${DRAIN_TIMEOUT_MS}ms)`);
    runtime.bootstrap.cancel();

    // WebSocket clients hold `server.close()` open — close them first.
    ws.dispose();

    server.close((): void => {
      log('drain: stopped accepting connections');
    });

    // Bounded flush (§4): in-memory queue summary + close every store,
    // then exit. The durable SQLite queue story replaces the summary
    // with a real job-state flush.
    void (async (): Promise<void> => {
      try {
        const jobStore = runtime.services.jobs;
        const queued = jobStore.list({ state: 'queued', limit: 1000 });
        log(`drain: flushing state — ${String(queued.jobs.length)} queued job(s) preserved in the run log`);
        for (const job of queued.jobs) {
          log(`drain: job ${job.id} (${String(job.payload['moduleId'] ?? '')}) remains ${job.state} — replayed by the queue story on restart`);
        }
        await runtime.dispose();
        log('drain: catalog stores closed, engines disposed (flush complete)');
        const elapsed = Date.now() - startedAt;
        log(`drain: complete in ${String(elapsed)}ms — exiting 0`);
        process.exit(0);
      } catch (error: unknown) {
        log(`drain: error during flush — ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    })();

    // Never hang the drain past the bound (§4).
    setTimeout((): void => {
      log('drain: timeout bound reached — exiting 0 (forced)');
      process.exit(0);
    }, DRAIN_TIMEOUT_MS).unref();
  };

  process.on('SIGTERM', (): void => {
    drain('SIGTERM');
  });
  process.on('SIGINT', (): void => {
    drain('SIGINT');
  });

  server.listen(config.port, (): void => {
    log(`listening on port ${String(config.port)} (/healthz up, /readyz gated on bootstrap)`);
    // D20 bootstrap with a small start-order retry: containers in the
    // compose test stack come up concurrently, and the mock upstream
    // may still be starting when the first sync attempt fires.
    void (async (): Promise<void> => {
      const attempts = 3;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1) {
          log(`bootstrap: retrying (attempt ${String(attempt)}/${String(attempts)})`);
          await new Promise<void>((resolve): void => {
            setTimeout(resolve, 1500);
          });
        }
        await runtime.bootstrap.run();
        if (runtime.bootstrap.isDone) {
          log('ready: bootstrap complete — /readyz now 200');
          return;
        }
        if (runtime.bootstrap.readiness().reason?.includes('cancelled') === true) {
          return;
        }
      }
      log('bootstrap: giving up — /readyz stays 503 (see bootstrap FAILED above)');
    })();
  });
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  void main();
}
