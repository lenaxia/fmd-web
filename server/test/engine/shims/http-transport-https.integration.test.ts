import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LoopbackHttpTransport } from '../../../src/engine/shims/http-transport.js';

/**
 * https egress through LoopbackHttpTransport (live module traffic,
 * FMD_HTTP_ALLOW_HOSTS): TLS-verified direct requests, CONNECT-tunneled
 * and SOCKS5-tunneled https, the host gate, the scheme gate, and the
 * wildcard. All hermetic: the TLS origin (self-signed fixture cert,
 * SAN localhost + 127.0.0.1) and both proxy mocks run on a worker
 * thread — the caller thread blocks in Atomics.wait inside send().
 */

const CERT = readFileSync(
  fileURLToPath(new URL('../../fixtures/tls/test-cert.pem', import.meta.url)),
  'utf8',
);
const KEY = readFileSync(
  fileURLToPath(new URL('../../fixtures/tls/test-key.pem', import.meta.url)),
  'utf8',
);

interface TlsHarness {
  originBase: string;
  originPort: number;
  connectProxyPort: number;
  socks5Port: number;
  records(): Promise<{ origin: string[]; originPorts: number[]; connect: string[]; socks5: string[] }>;
  close(): Promise<void>;
}

const HARNESS_SCRIPT = `
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  const https = await import('node:https');
  const net = await import('node:net');
  const origin = [];
  const originPorts = [];
  const connect = [];
  const socks5 = [];

  const tlsServer = https.createServer(
    { key: workerData.key, cert: workerData.cert },
    (req, res) => {
      origin.push(req.method + ' ' + String(req.url));
      originPorts.push(req.socket.remotePort);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('tls-body-' + origin.length);
    },
  );

  // minimal HTTP CONNECT forward proxy: 200 + bidirectional splice
  const connectProxy = net.createServer((sock) => {
    sock.once('data', (d) => {
      const line = String(Buffer.from(d).toString('latin1').split('\\r\\n')[0] ?? '');
      if (!line.startsWith('CONNECT ')) { sock.destroy(); return; }
      connect.push(line);
      const target = line.slice('CONNECT '.length).split(' ')[0].split(':');
      const up = net.connect({ host: target[0], port: Number(target[1]) }, () => {
        sock.write('HTTP/1.1 200 Connection established\\r\\n\\r\\n');
        sock.pipe(up); up.pipe(sock);
      });
      up.on('error', () => sock.destroy());
    });
  });

  // minimal SOCKS5 (no-auth, DOMAINNAME + IPv4 CONNECT) splice proxy
  const socks5Proxy = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(Buffer.from([0x05, 0x00]));
      sock.once('data', (req) => {
        const atyp = req[3];
        let host = '127.0.0.1';
        let port = 0;
        if (atyp === 0x01) {
          host = req[4] + '.' + req[5] + '.' + req[6] + '.' + req[7];
          port = (req[8] << 8) | req[9];
        } else if (atyp === 0x03) {
          const l = req[4];
          host = Buffer.from(req).toString('latin1', 5, 5 + l);
          port = (req[5 + l] << 8) | req[6 + l];
        }
        socks5.push(host + ':' + port);
        const up = net.connect({ host, port }, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.pipe(up); up.pipe(sock);
        });
        up.on('error', () => sock.destroy());
      });
    });
  });

  const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
  const [originPort, connectProxyPort, socks5Port] = await Promise.all([
    listen(tlsServer), listen(connectProxy), listen(socks5Proxy),
  ]);

  parentPort.on('message', (m) => {
    if (m === 'records') {
      parentPort.postMessage({ origin, originPorts, connect, socks5 });
    } else if (m === 'close') {
      tlsServer.close(); connectProxy.close(); socks5Proxy.close();
      setTimeout(() => parentPort.postMessage('closed'), 50);
    }
  });
  parentPort.postMessage({ originPort, connectProxyPort, socks5Port });
})();
`;

async function startHarness(): Promise<TlsHarness> {
  const worker = new Worker(HARNESS_SCRIPT, {
    eval: true,
    workerData: { key: KEY, cert: CERT },
  });
  const ports = await new Promise<{ originPort: number; connectProxyPort: number; socks5Port: number }>(
    (resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    },
  );
  return {
    originBase: `https://127.0.0.1:${ports.originPort}`,
    originPort: ports.originPort,
    connectProxyPort: ports.connectProxyPort,
    socks5Port: ports.socks5Port,
    records(): Promise<{ origin: string[]; originPorts: number[]; connect: string[]; socks5: string[] }> {
      return new Promise((resolve) => {
        worker.once('message', (m) => resolve(m));
        worker.postMessage('records');
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        worker.once('message', () => {
          void worker.terminate();
          resolve();
        });
        worker.postMessage('close');
      });
    },
  };
}

const GET = (url: string, timeoutMs = 10000) => ({
  method: 'GET',
  url,
  headers: { 'User-Agent': 'fmd-web-test' },
  body: '',
  timeoutMs,
});

let harness: TlsHarness;
afterAll(async () => {
  if (harness !== undefined) await harness.close();
});

describe('LoopbackHttpTransport https egress', () => {
  it('direct https round-trips against a TLS origin trusted via ca', async () => {
    harness = harness ?? (await startHarness());
    const t = new LoopbackHttpTransport({ ca: [CERT] });
    try {
      const r = t.send(GET(`${harness.originBase}/direct`));
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      expect(Buffer.from(r.body).toString('utf8')).toBe('tls-body-1');
      const rec = await harness.records();
      expect(rec.origin[0]).toBe('GET /direct');
    } finally {
      t.dispose();
    }
  });

  it('TLS verification is ON by default: untrusted origin fails typed', async () => {
    harness = harness ?? (await startHarness());
    const t = new LoopbackHttpTransport();
    try {
      const r = t.send(GET(`${harness.originBase}/untrusted`));
      expect(r.ok).toBe(false);
      expect(r.status).toBe(0);
      expect(r.error).toMatch(/certificate|self.?signed|unable.?to.?verify/i);
    } finally {
      t.dispose();
    }
  });

  it('tlsVerify=false skips verification (hermetic self-signed servers)', async () => {
    harness = harness ?? (await startHarness());
    const t = new LoopbackHttpTransport({ tlsVerify: false });
    try {
      const r = t.send(GET(`${harness.originBase}/insecure`));
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
    } finally {
      t.dispose();
    }
  });

  it('non-http(s) schemes are refused with a typed error', () => {
    const t = new LoopbackHttpTransport();
    try {
      const r = t.send(GET('ftp://127.0.0.1/pub'));
      expect(r.ok).toBe(false);
      expect(r.error).toContain('supports http/https only');
    } finally {
      t.dispose();
    }
  });

  it('host gate: external https host refused without an allow-list entry', () => {
    const t = new LoopbackHttpTransport();
    try {
      const r = t.send(GET('https://fanfox.net/manga/x/'));
      expect(r.ok).toBe(false);
      expect(r.error).toContain('refuses non-loopback host');
    } finally {
      t.dispose();
    }
  });

  it('wildcard allow-list ("*") admits external hosts past the gate', () => {
    const t = new LoopbackHttpTransport({ allowedHosts: ['*'] });
    try {
      // TEST-NET-1 + discard port: never routed — the failure must be a
      // wire-level timeout, NOT the gate refusal (which would prove the
      // wildcard did not open egress).
      const r = t.send(GET('https://192.0.2.1:9/wildcard', 1500));
      expect(r.ok).toBe(false);
      expect(r.error).not.toContain('refuses non-loopback host');
    } finally {
      t.dispose();
    }
  }, 20000);

  it('fresh connection per request (synapse parity): no keep-alive socket reuse', async () => {
    harness = harness ?? (await startHarness());
    const t = new LoopbackHttpTransport({ ca: [CERT] });
    try {
      const r1 = t.send(GET(`${harness.originBase}/ka-1`));
      const r2 = t.send(GET(`${harness.originBase}/ka-2`));
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      const rec = await harness.records();
      // every observed request rode its own TCP connection (the harness
      // accumulates across the file — assert global uniqueness)
      expect(new Set(rec.originPorts).size).toBe(rec.originPorts.length);
      expect(rec.originPorts.length).toBeGreaterThanOrEqual(2);
    } finally {
      t.dispose();
    }
  });

  it('https through an HTTP forward proxy rides a CONNECT tunnel', async () => {
    harness = harness ?? (await startHarness());
    const t = new LoopbackHttpTransport({ ca: [CERT] });
    try {
      const r = t.send({
        ...GET(`${harness.originBase}/via-connect`),
        proxy: { type: 'HTTP', host: '127.0.0.1', port: String(harness.connectProxyPort), user: '', pass: '' },
      });
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      expect(Buffer.from(r.body).toString('utf8')).toContain('tls-body-');
      const rec = await harness.records();
      expect(rec.connect[0]).toBe(`CONNECT 127.0.0.1:${harness.originPort} HTTP/1.1`);
      expect(rec.origin.some((o) => o === 'GET /via-connect')).toBe(true);
    } finally {
      t.dispose();
    }
  });

  it('https through a SOCKS5 proxy tunnels TLS over the CONNECT tunnel', async () => {
    harness = harness ?? (await startHarness());
    const t = new LoopbackHttpTransport({ ca: [CERT] });
    try {
      const r = t.send({
        ...GET(`${harness.originBase}/via-socks5`),
        proxy: { type: 'SOCKS5', host: '127.0.0.1', port: String(harness.socks5Port), user: '', pass: '' },
      });
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      const rec = await harness.records();
      expect(rec.socks5[0]).toBe(`127.0.0.1:${harness.originPort}`);
      expect(rec.origin.some((o) => o === 'GET /via-socks5')).toBe(true);
    } finally {
      t.dispose();
    }
  });
});
