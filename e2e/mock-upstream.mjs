#!/usr/bin/env node
/**
 * e2e mock upstream (node:http fixture container, zero dependencies).
 *
 * Stands in for EVERY upstream the Phase-2 pipeline talks to, offline:
 *
 *   GET /codeload/<repo>/zip/<sha>        → prebuilt fixture zipball
 *                                           (codeload shape; strict:
 *                                           only the prepared sha)
 *   GET /api-github/repos/<owner>/<name>/commits?…
 *                                         → commits.json fixture
 *                                           (ETag; conditional 304)
 *   GET <any other path>                  → static file under the
 *                                           upstream root (catalog
 *                                           .7z blobs, site HTML)
 *   GET /_requests                        → JSON request log (evidence)
 *   GET /healthz                          → mock liveness
 *
 * Usage: node mock-upstream.mjs --root <upstream-dir> --port <n|0>
 *        [--requests-log <file>] [--commits-etag "<etag>"]
 * Logs `mock listening on <port>` on stdout (port discovery for tests).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

function parseArgs(argv) {
  const args = { root: null, port: 0, requestsLog: null, commitsEtag: '"e2e-commits-1"' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'root') args.root = value;
    else if (key === 'port') args.port = Number.parseInt(value, 10);
    else if (key === 'requests-log') args.requestsLog = value;
    else if (key === 'commits-etag') args.commitsEtag = value;
  }
  if (args.root === null) {
    console.error('usage: mock-upstream.mjs --root <dir> [--port n] [--requests-log f] [--commits-etag etag]');
    process.exit(2);
  }
  return args;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain; charset=utf-8',
  '.db': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/** Failure-injection state (§7.1 e2e): prefix-matched rules with a
 * bounded hit count — the e2e arms them via POST /_control/* through
 * the host port mapping and asserts the outcomes through /_stats. */
const injection = {
  fail500: [], // {path, remaining}
  slow: [], // {path, ms, remaining}
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function pathStats() {
  const counts = {};
  for (const record of requests) {
    const key = record.path.split('?')[0];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function handleControl(req, res, url) {
  if (url.pathname === '/_control' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(injection));
    return true;
  }
  if (url.pathname === '/_stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: requests.length, paths: pathStats() }));
    return true;
  }
  if (url.pathname === '/_control/fail500' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    injection.fail500.push({ path: String(body.path ?? ''), remaining: Number(body.count ?? 0) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, injection }));
    return true;
  }
  if (url.pathname === '/_control/slow' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    injection.slow.push({ path: String(body.path ?? ''), ms: Number(body.ms ?? 0), remaining: Number(body.count ?? 0) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, injection }));
    return true;
  }
  if (url.pathname === '/_control/reset' && req.method === 'POST') {
    injection.fail500 = [];
    injection.slow = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, injection }));
    return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv);
const root = path.resolve(args.root);
const requests = [];

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(new URL(urlPath, 'http://x').pathname);
  const target = path.resolve(root, decoded.replace(/^\/+/, ''));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function sendFile(res, file, extraHeaders = {}) {
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('fixture not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    ...extraHeaders,
  };
  res.writeHead(200, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'mock'}`);
  const record = { method: req.method, path: url.pathname + url.search, at: new Date().toISOString() };
  requests.push(record);
  if (args.requestsLog !== null) {
    fs.appendFileSync(args.requestsLog, `${JSON.stringify(record)}\n`, 'utf8');
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requests: requests.length }));
    return;
  }
  if (url.pathname === '/_requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ requests }));
    return;
  }
  if ((await handleControl(req, res, url)) === true) {
    return;
  }

  // Failure injection (§7.1 e2e): 500s and slow-image delivery, prefix
  // matched, hit-count bounded — armed by the e2e via /_control/*.
  const failRule = injection.fail500.find((rule) => rule.remaining > 0 && url.pathname.startsWith(rule.path));
  const slowRule = injection.slow.find((rule) => rule.remaining > 0 && url.pathname.startsWith(rule.path));
  if (slowRule !== undefined) {
    slowRule.remaining -= 1;
    await delay(slowRule.ms);
  }
  if (failRule !== undefined) {
    failRule.remaining -= 1;
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('injected failure (fail500)');
    return;
  }

  // codeload zipball — strict: the prepared sha file must exist (a sync
  // asking for any other ref gets a 404 and MUST refuse it).
  const zipball = /^\/codeload\/([^/]+\/[^/]+)\/zip\/([0-9a-f]+)$/.exec(url.pathname);
  if (zipball !== null) {
    const file = path.join(root, 'codeload', zipball[1], 'zip', zipball[2]);
    if (fs.existsSync(file)) {
      sendFile(res, file);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`no zipball for ${zipball[1]}@${zipball[2]}`);
    }
    return;
  }

  // commits API (If-None-Match → 304, the §6.1 conditional check).
  if (/^\/api-github\/repos\/[^/]+\/[^/]+\/commits$/.test(url.pathname)) {
    const file = path.join(root, 'api-github', 'commits.json');
    const inm = req.headers['if-none-match'];
    if (inm !== undefined && inm === args.commitsEtag) {
      res.writeHead(304, { ETag: args.commitsEtag });
      res.end();
      return;
    }
    sendFile(res, file, { ETag: args.commitsEtag });
    return;
  }

  // Everything else: static fixtures (catalog .7z blobs, site pages,
  // chapter images). Extensionless site paths (/manga/alpha-quest and
  // .../ch/1) resolve to the recorded page at <root>/site<path>.html;
  // everything else resolves EXACTLY under <root>/site<path> first (the
  // recorded pages/images tree), then under <root><path> (blobs).
  const siteExact = safeResolve(`/site${url.pathname}`);
  if (siteExact !== null && fs.existsSync(siteExact) && fs.statSync(siteExact).isFile()) {
    sendFile(res, siteExact);
    return;
  }
  const target = safeResolve(req.url ?? '/');
  if (target !== null && fs.existsSync(target) && fs.statSync(target).isFile()) {
    sendFile(res, target);
    return;
  }
  const sitePage = safeResolve(`/site${url.pathname}.html`);
  if (sitePage !== null && fs.existsSync(sitePage) && fs.statSync(sitePage).isFile()) {
    sendFile(res, sitePage);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('fixture not found');
});

server.listen(args.port, '0.0.0.0', () => {
  const { port } = server.address();
  console.log(`mock listening on ${String(port)} (root ${root})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
