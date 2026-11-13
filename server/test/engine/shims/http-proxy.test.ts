import { describe, expect, it } from 'vitest';
import { ProxyAgent } from 'undici';
import {
  type ProxyConfig,
  describeProxySelection,
  getProxy,
  normalizeProxyConfig,
  proxyUrlFromConfig,
} from '../../../src/engine/shims/http-proxy.js';

/**
 * SetProxy unit tests (DESIGN §5.4, httpsendthread.pas:838-874 impl
 * parity). Contract → test matrix:
 * | Row     | Contract                                              | Source      | Test                                  |
 * |---------|--------------------------------------------------------|-------------|---------------------------------------|
 * | R-PRX1  | 'HTTP' → http proxy fields (host/port/user/pass)       | :848-853    | HTTP selects the HTTP proxy agent     |
 * | R-PRX2  | 'SOCKS4'/'SOCKS5' → socks fields, SocksType 4/5        | :854-866    | SOCKS4/5 select the socks dispatcher  |
 * | R-PRX3  | type matching is case-insensitive (AnsiUpperCase)      | :841        | lowercase/mixed-case types normalize  |
 * | R-PRX4  | unknown/empty type clears everything (SetNoProxy)      | :843-847,867| unknown type clears the config        |
 * | R-PRX5  | GetProxy round-trips the active config                 | :876-902    | getProxy round-trip                   |
 * | R-PRX6  | agent selection: HTTP → undici ProxyAgent; SOCKS4/5 →  | DESIGN §5.4 | proxyUrl + selection descriptor       |
 * |         | socks-proxy-agent-backed dispatcher                    |             |                                       |
 */

const CLEAR: ProxyConfig = {
  type: '',
  host: '',
  port: '',
  user: '',
  pass: '',
};

describe('http-proxy: normalizeProxyConfig (:838-874)', () => {
  it('HTTP type stores host/port/user/pass (R-PRX1)', () => {
    expect(normalizeProxyConfig('HTTP', 'p.example.com', '8080', 'u', 'pw')).toEqual({
      type: 'HTTP',
      host: 'p.example.com',
      port: '8080',
      user: 'u',
      pass: 'pw',
    });
  });

  it('SOCKS4/SOCKS5 store socks fields with the socks type (R-PRX2)', () => {
    expect(normalizeProxyConfig('SOCKS4', 's.example.com', '1080', 'u', 'pw')).toEqual({
      type: 'SOCKS4',
      host: 's.example.com',
      port: '1080',
      user: 'u',
      pass: 'pw',
    });
    expect(normalizeProxyConfig('SOCKS5', 's.example.com', '1080', 'u', 'pw')?.type).toBe(
      'SOCKS5',
    );
  });

  it('type matching is case-insensitive (AnsiUpperCase, R-PRX3)', () => {
    expect(normalizeProxyConfig('http', 'h', '1', '', '')?.type).toBe('HTTP');
    expect(normalizeProxyConfig('Socks5', 'h', '1', '', '')?.type).toBe('SOCKS5');
    expect(normalizeProxyConfig('sOcKs4', 'h', '1', '', '')?.type).toBe('SOCKS4');
  });

  it('unknown or empty type clears everything (R-PRX4)', () => {
    expect(normalizeProxyConfig('FTP', 'h', '1', 'u', 'p')).toEqual(CLEAR);
    expect(normalizeProxyConfig('', 'h', '1', 'u', 'p')).toEqual(CLEAR);
  });

  it('the cleared config equals the constructor default (no proxy)', () => {
    expect(normalizeProxyConfig('', '', '', '', '')).toEqual({
      type: '',
      host: '',
      port: '',
      user: '',
      pass: '',
    });
  });
});

describe('http-proxy: agent selection (R-PRX6)', () => {
  it('HTTP config selects an undici ProxyAgent over the proxy URL', () => {
    const config = normalizeProxyConfig('HTTP', 'p.example.com', '8080', 'u', 'pw');
    const selection = describeProxySelection(config);
    expect(selection.kind).toBe('http');
    expect(selection.agent).toBeInstanceOf(ProxyAgent);
    expect(proxyUrlFromConfig(config)).toBe('http://u:pw@p.example.com:8080');
  });

  it('HTTP config without credentials has no userinfo in the URL', () => {
    const config = normalizeProxyConfig('HTTP', 'p.example.com', '8080', '', '');
    expect(proxyUrlFromConfig(config)).toBe('http://p.example.com:8080');
  });

  it('SOCKS4 config selects a socks4 dispatcher with socks4a host config', () => {
    const config = normalizeProxyConfig('SOCKS4', 's.example.com', '1080', 'u', 'pw');
    const selection = describeProxySelection(config);
    expect(selection.kind).toBe('socks4');
    expect(selection.socks).toEqual({
      host: 's.example.com',
      port: 1080,
      type: 4,
      userId: 'u',
      password: 'pw',
    });
    expect(selection.agent).toBeDefined();
  });

  it('SOCKS5 config selects a socks5 dispatcher (default socks port 1080, :844)', () => {
    const config = normalizeProxyConfig('SOCKS5', 's.example.com', '', '', '');
    const selection = describeProxySelection(config);
    expect(selection.kind).toBe('socks5');
    expect(selection.socks).toEqual({
      host: 's.example.com',
      port: 1080,
      type: 5,
      userId: '',
      password: '',
    });
    expect(selection.agent).toBeDefined();
  });

  it('empty config selects the default dispatcher (no agent)', () => {
    const selection = describeProxySelection(CLEAR);
    expect(selection.kind).toBe('none');
    expect(selection.agent).toBeUndefined();
    expect(selection.socks).toBeUndefined();
  });
});

describe('http-proxy: GetProxy round-trip (:876-902, R-PRX5)', () => {
  it('round-trips an HTTP proxy', () => {
    const config = normalizeProxyConfig('HTTP', 'p.example.com', '8080', 'u', 'pw');
    expect(getProxy(config)).toEqual(['HTTP', 'p.example.com', '8080', 'u', 'pw']);
  });

  it('round-trips a SOCKS5 proxy', () => {
    const config = normalizeProxyConfig('SOCKS5', 's.example.com', '1081', 'u', 'pw');
    expect(getProxy(config)).toEqual(['SOCKS5', 's.example.com', '1081', 'u', 'pw']);
  });

  it('round-trips the no-proxy state', () => {
    expect(getProxy(CLEAR)).toEqual(['', '', '', '', '']);
  });
});
