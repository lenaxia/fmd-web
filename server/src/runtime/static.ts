import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * SPA static serving (§10/§11): the runtime mounts the built web/
 * dist tree at `/` (hash routing → only `/` and hashed assets are
 * ever requested). Deliberately dependency-free — the raw-http bridge
 * forwards Fastify replies byte-exact (rawPayload), so this is the
 * SAME code path the loopback tests exercise. Unknown paths fall back
 * to index.html so deep links and asset-less reloads render the SPA;
 * `/api/*` and the health probes never reach this handler (registered
 * after the API routes).
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function registerStatic(app: FastifyInstance, distDir: string): void {
  const indexFile = path.join(distDir, 'index.html');

  const sendFile = (reply: FastifyReply, file: string): void => {
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    void reply
      .code(200)
      .header('Content-Type', type)
      .header('Cache-Control', file === indexFile ? 'no-cache' : 'public, max-age=31536000, immutable')
      .send(fs.readFileSync(file));
  };

  const resolveWithin = (urlPath: string): string | undefined => {
    const relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
    const target = path.resolve(distDir, relative);
    if (!target.startsWith(path.resolve(distDir) + path.sep) && target !== path.resolve(distDir)) {
      return undefined;
    }
    return target;
  };

  app.get('/', (_req, reply): void => {
    sendFile(reply, indexFile);
  });

  app.get('/*', (req, reply): void => {
    const raw = (req.params as Record<string, unknown>)['*'];
    const urlPath = typeof raw === 'string' ? `/${raw}` : '/';
    // API + health probes keep their own semantics (404 envelope / probe
    // handlers registered earlier) — never the SPA fallback.
    if (urlPath.startsWith('/api/') || urlPath === '/healthz' || urlPath === '/readyz') {
      void reply.callNotFound();
      return;
    }
    const target = resolveWithin(urlPath);
    if (target === undefined) {
      sendFile(reply, indexFile);
      return;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(target);
    } catch {
      stat = undefined;
    }
    if (stat === undefined || !stat.isFile()) {
      sendFile(reply, indexFile);
      return;
    }
    sendFile(reply, target);
  });
}
