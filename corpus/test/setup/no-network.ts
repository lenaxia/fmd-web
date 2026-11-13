import * as http from 'node:http';
import * as https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Zero-network guard (DESIGN.md §13): every vitest run must be fully
 * offline. Any outbound socket attempt to a non-loopback destination
 * throws immediately (fail-loud enforcement) and is recorded in a
 * global registry so corpus/test/no-network.test.ts can double-check
 * the whole run stayed clean. Loopback remains allowed (DESIGN.md:
 * loopback sockets never leave the machine).
 *
 * Chokepoints: `net.connect` / `net.createConnection` /
 * `Socket.prototype.connect` / `tls.connect` cover every client stack
 * (node http/https agents, undici's connector, raw sockets). The
 * http/https Agent `createConnection` prototypes give a synchronous
 * guard for `http.request`. ESM module namespaces themselves are
 * sealed, so patching happens at prototype/function level only.
 */

export interface NetAttempt {
  readonly fn: string;
  readonly host?: string;
  readonly port?: number;
  /** True: the guard threw after recording (always the case). */
  readonly blocked: boolean;
}

const GUARD_FLAG = '__FMD_NET_GUARD__';
const ATTEMPTS_KEY = '__FMD_NET_ATTEMPTS__';

interface GuardGlobal {
  [GUARD_FLAG]?: boolean;
  [ATTEMPTS_KEY]?: NetAttempt[];
}

const g = globalThis as typeof globalThis & GuardGlobal;

export function getNetAttempts(): NetAttempt[] {
  return g[ATTEMPTS_KEY] ?? [];
}

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === '') return true;
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '127.0.0.1' ||
    h.endsWith('.localhost') ||
    h.startsWith('127.')
  );
}

function record(fn: string, host?: string, port?: number): void {
  const attempts = g[ATTEMPTS_KEY] ?? [];
  attempts.push({
    fn,
    blocked: true,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
  });
  g[ATTEMPTS_KEY] = attempts;
}

function forbidden(fn: string, host?: string, port?: number): Error {
  return new Error(
    `NETWORK ACCESS FORBIDDEN (DESIGN.md §13): ${fn} to ` +
      `${host ?? '<unspecified>'}:${port ?? '<unspecified>'} — vitest runs ` +
      `are fully offline; record fixtures into corpus/fixtures instead.`,
  );
}

function isLoopbackOptions(options: unknown): boolean {
  if (typeof options === 'string' || typeof options === 'number') {
    return true; // path (IPC) or port-only — no remote host.
  }
  const o = options as { host?: string; hostname?: string };
  return isLoopbackHost(o?.host) && isLoopbackHost(o?.hostname);
}

function extractHost(options: unknown): string | undefined {
  const o = options as { host?: string; hostname?: string };
  return o?.hostname ?? o?.host;
}

function extractPort(options: unknown): number | undefined {
  const o = options as { port?: number };
  return typeof o?.port === 'number' ? o.port : undefined;
}

function guardSocketFactory(
  label: string,
  real: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  // Regular function (not arrow): prototype callers need `this` forwarded.
  return function (this: unknown, ...args: unknown[]): unknown {
    const first = args[0];
    const optionsLike =
      typeof first === 'object' && first !== null
        ? first
        : args.length >= 2
          ? { port: first, host: args[1] }
          : { port: first };
    if (!isLoopbackOptions(optionsLike)) {
      const host = extractHost(optionsLike);
      const port = extractPort(optionsLike);
      record(label, host, port);
      throw forbidden(label, host, port);
    }
    return real.apply(this, args);
  };
}

export function installNetGuard(): void {
  if (g[GUARD_FLAG] === true) return;
  g[GUARD_FLAG] = true;

  const realConnect = net.connect.bind(net) as (...args: unknown[]) => unknown;
  const realCreateConnection = net.createConnection.bind(
    net,
  ) as (...args: unknown[]) => unknown;
  const realSocketConnect = net.Socket.prototype.connect;
  const realTlsConnect = tls.connect.bind(tls) as (
    ...args: unknown[]
  ) => unknown;
  const realHttpAgentConnect = http.Agent.prototype.createConnection;
  const realHttpsAgentConnect = https.Agent.prototype.createConnection;

  net.connect = guardSocketFactory(
    'net.connect',
    realConnect,
  ) as typeof net.connect;
  net.createConnection = guardSocketFactory(
    'net.createConnection',
    realCreateConnection,
  ) as typeof net.createConnection;
  net.Socket.prototype.connect = guardSocketFactory(
    'Socket.connect',
    realSocketConnect as unknown as (...args: unknown[]) => unknown,
  ) as typeof net.Socket.prototype.connect;
  tls.connect = guardSocketFactory(
    'tls.connect',
    realTlsConnect,
  ) as typeof tls.connect;
  http.Agent.prototype.createConnection = guardSocketFactory(
    'http.Agent.createConnection',
    realHttpAgentConnect as unknown as (...args: unknown[]) => unknown,
  ) as typeof http.Agent.prototype.createConnection;
  https.Agent.prototype.createConnection = guardSocketFactory(
    'https.Agent.createConnection',
    realHttpsAgentConnect as unknown as (...args: unknown[]) => unknown,
  ) as typeof https.Agent.prototype.createConnection;
}

installNetGuard();
