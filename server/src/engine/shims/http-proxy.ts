import { Agent as UndiciAgent, ProxyAgent, type Dispatcher } from 'undici';
import type { ClientRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * SetProxy (DESIGN §5.4, httpsendthread.pas:838-874 impl parity): HTTP
 * proxies ride an undici `ProxyAgent`; SOCKS4/SOCKS5 proxies ride a
 * socks-proxy-agent-backed undici dispatcher. Unknown/empty proxy types
 * clear the config — the SetNoProxy path (:843-847, :867-873).
 */

/** Normalized proxy configuration (all-string ports, FMD2 string fields). */
export interface ProxyConfig {
  type: string;
  host: string;
  port: string;
  user: string;
  pass: string;
}

/** socks-proxy-agent connection options (test-visible selection result). */
export interface SocksOptions {
  host: string;
  port: number;
  type: 4 | 5;
  userId: string;
  password: string;
}

/**
 * Proxy config normalization (httpsendthread.pas:838-874): uppercase the
 * type; `HTTP` → proxy fields; `SOCKS4`/`SOCKS5` → socks fields
 * (SocksType 4/5); anything else clears everything (default socks port
 * '1080', :844).
 */
export function normalizeProxyConfig(
  proxyType: string,
  host: string,
  port: string,
  user: string,
  pass: string,
): ProxyConfig {
  const pt = proxyType.toUpperCase();
  if (pt === 'HTTP') {
    return { type: 'HTTP', host, port, user, pass };
  }
  if (pt === 'SOCKS4' || pt === 'SOCKS5') {
    return { type: pt, host, port, user, pass };
  }
  return { type: '', host: '', port: '', user: '', pass: '' };
}

/** `GetProxy` (httpsendthread.pas:876-902): the active config, five strings. */
export function getProxy(config: ProxyConfig): [string, string, string, string, string] {
  if (config.type === '') {
    return ['', '', '', '', ''];
  }
  return [config.type, config.host, config.port, config.user, config.pass];
}

/** Proxy URL for undici's ProxyAgent (userinfo only when credentials exist). */
export function proxyUrlFromConfig(config: ProxyConfig): string {
  const port = config.port !== '' ? `:${config.port}` : '';
  const userinfo =
    config.user !== '' || config.pass !== ''
      ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.pass)}@`
      : '';
  return `http://${userinfo}${config.host}${port}`;
}

/** socks-proxy-agent URL form (socks4/socks5 scheme + auth). */
export function socksUrlFromConfig(config: ProxyConfig): string {
  const scheme = config.type === 'SOCKS4' ? 'socks4' : 'socks5';
  const port = config.port !== '' ? `:${config.port}` : ':1080';
  const userinfo =
    config.user !== '' ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.pass)}@` : '';
  return `${scheme}://${userinfo}${config.host}${port}`;
}

/** Parse the string port with the Pascal '1080' default (:844). */
function socksPort(config: ProxyConfig): number {
  const n = Number(config.port);
  return Number.isFinite(n) && config.port !== '' ? Math.trunc(n) : 1080;
}

/** socks-proxy-agent connect options for a SOCKS4/5 config (type 4 or 5). */
export function socksOptionsFromConfig(config: ProxyConfig): SocksOptions {
  return {
    host: config.host,
    port: socksPort(config),
    type: config.type === 'SOCKS4' ? 4 : 5,
    userId: config.user,
    password: config.pass,
  };
}

/** Agent-selection descriptor: which dispatcher a config produces. */
export interface ProxySelection {
  readonly kind: 'none' | 'http' | 'socks4' | 'socks5';
  readonly agent: Dispatcher | undefined;
  readonly socks: SocksOptions | undefined;
}

/** Minimal request-like object socks-proxy-agent's connect() touches. */
function fakeSocksRequest(): ClientRequest {
  const req = new EventEmitter() as unknown as ClientRequest;
  (req as unknown as { destroy(): void }).destroy = () => undefined;
  return req;
}

/**
 * Build an undici dispatcher that tunnels through socks-proxy-agent:
 * the custom connector delegates to `SocksProxyAgent.connect`, which
 * performs the SOCKS handshake and the TLS upgrade for https endpoints.
 */
export function createSocksDispatcher(options: SocksOptions): Dispatcher {
  const scheme = options.type === 4 ? 'socks4' : 'socks5';
  const auth = options.userId !== '' ? `${encodeURIComponent(options.userId)}:${encodeURIComponent(options.password)}@` : '';
  const agent = new SocksProxyAgent(`${scheme}://${auth}${options.host}:${options.port}`);
  return new UndiciAgent({
    connect: (opts, callback) => {
      const req = fakeSocksRequest();
      agent
        .connect(req, {
          host: opts.hostname ?? opts.host ?? '',
          port: typeof opts.port === 'number' ? opts.port : Number(opts.port ?? 0),
          secureEndpoint: opts.protocol === 'https:',
          protocol: opts.protocol,
          servername: opts.servername ?? opts.hostname ?? opts.host,
        })
        .then((socket: Duplex) => {
          callback(null, socket as TLSSocket);
        })
        .catch((err: Error) => {
          callback(err, null);
        });
    },
  });
}

/**
 * Agent selection for a normalized config: HTTP → undici ProxyAgent;
 * SOCKS4/5 → socks dispatcher; empty → default dispatcher (none).
 */
export function describeProxySelection(config: ProxyConfig): ProxySelection {
  if (config.type === 'HTTP') {
    return {
      kind: 'http',
      agent: new ProxyAgent(proxyUrlFromConfig(config)),
      socks: undefined,
    };
  }
  if (config.type === 'SOCKS4' || config.type === 'SOCKS5') {
    const socks = socksOptionsFromConfig(config);
    return {
      kind: config.type === 'SOCKS4' ? 'socks4' : 'socks5',
      agent: createSocksDispatcher(socks),
      socks,
    };
  }
  return { kind: 'none', agent: undefined, socks: undefined };
}
