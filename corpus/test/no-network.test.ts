import * as http from 'node:http';
import * as https from 'node:https';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  getNetAttempts,
  installNetGuard,
  isLoopbackHost,
} from './setup/no-network.js';

/**
 * Zero-network enforcement (§13): vitest runs are fully offline. The
 * global setup file (corpus/test/setup/no-network.ts) patches the node
 * net stack for EVERY test file in the run; this file asserts the guard
 * holds and that attempts would fail.
 */
describe('zero-network enforcement (DESIGN.md §13)', (): void => {
  it('guard is installed globally', (): void => {
    expect(
      (globalThis as Record<string, unknown>)['__FMD_NET_GUARD__'],
    ).toBe(true);
    // Re-install must be a no-op (idempotent).
    expect(() => installNetGuard()).not.toThrow();
  });

  it('fails the run when net.connect targets a remote host', (): void => {
    expect(() =>
      net.createConnection({ host: 'fmd2.example.invalid', port: 80 }),
    ).toThrow(/NETWORK ACCESS FORBIDDEN/);
    expect(() =>
      net.connect({ host: 'fmd2.example.invalid', port: 443 }),
    ).toThrow(/NETWORK ACCESS FORBIDDEN/);
  });

  it('blocks http/https.request to remote hosts before DNS resolution', (): void => {
    expect(() => http.request('http://fmd2.example.invalid/x')).toThrow(
      /NETWORK ACCESS FORBIDDEN/,
    );
    expect(() =>
      http.request({ host: 'fmd2.example.invalid', port: 80, method: 'GET' }),
    ).toThrow(/NETWORK ACCESS FORBIDDEN/);
    expect(() => https.request('https://fmd2.example.invalid/x')).toThrow(
      /NETWORK ACCESS FORBIDDEN/,
    );
  });

  it('classifies loopback destinations as allowed', (): void => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('test.localhost')).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost('fmd2.example.invalid')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });

  it('every remote attempt this worker saw was blocked by the guard', (): void => {
    // The guard records only attempts it also throws on, so any entry
    // here must originate from an intercepted (blocked) call — e.g. the
    // guard tests above, or (regression case) a real leak, which fails
    // here because an unblocked attempt cannot carry blocked=true.
    const unblocked = getNetAttempts().filter((a) => !a.blocked);
    expect(unblocked).toEqual([]);
  });
});
