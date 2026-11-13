import { describe, expect, it } from 'vitest';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';

/**
 * Egress policy unit tests (DESIGN §5.4 hook). Contract → test matrix:
 * | Row     | Contract                                                | Test                                    |
 * |---------|----------------------------------------------------------|-----------------------------------------|
 * | R-EG1   | RFC1918 denied by default (10/8, 172.16/12, 192.168/16)  | denies RFC1918 literals                 |
 * | R-EG2   | link-local denied by default (127/8, 169.254/16, ::1,    | denies link-local literals              |
 * |         | fe80::/10) + 0.0.0.0 + unspecified                        |                                         |
 * | R-EG3   | public hostnames/IPs allowed by default                  | allows public targets                   |
 * | R-EG4   | allow-list override: exact host, wildcard, CIDR          | allow-list admits private targets       |
 * | R-EG5   | denials carry a reason; hook is checked before any send  | isDenied returns a reason               |
 */

describe('http-egress: default deny (R-EG1/R-EG2)', () => {
  const policy = new EgressPolicy({ allow: [] });

  it.each([
    'http://10.0.0.1/x',
    'http://10.255.255.255/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://192.168.0.0/x',
    'http://127.0.0.1/x',
    'http://127.255.0.1/x',
    'http://169.254.1.1/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://[fc00::1]/x',
    'http://localhost/x',
  ])('denies %s by default', (url) => {
    const verdict = policy.check(url);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('private');
  });

  it.each([
    'https://example.com/x',
    'https://api.localhosts-example.com/x', // contains 'localhost' as substring — public
    'http://8.8.8.8/x',
    'http://172.32.0.1/x', // just outside 172.16/12
    'http://example-mirror.localhost.example.com/x',
  ])('allows public target %s by default', (url) => {
    expect(policy.check(url).allowed).toBe(true);
  });
});

describe('http-egress: allow-list override (R-EG4)', () => {
  it('exact hostname entry admits the private target', () => {
    const policy = new EgressPolicy({ allow: ['127.0.0.1'] });
    expect(policy.check('http://127.0.0.1:8123/x').allowed).toBe(true);
    expect(policy.check('http://192.168.1.1/x').allowed).toBe(false);
  });

  it('case-insensitive host matching', () => {
    const policy = new EgressPolicy({ allow: ['LOCALHOST'] });
    expect(policy.check('http://localhost:9/x').allowed).toBe(true);
    expect(policy.check('http://LocalHost/x').allowed).toBe(true);
  });

  it('wildcard suffix entries admit subdomains (incl. localhost-ish private names)', () => {
    const policy = new EgressPolicy({ allow: ['*.localhost'] });
    expect(policy.check('http://api.localhost/x').allowed).toBe(true);
    expect(policy.check('http://b.c.localhost/x').allowed).toBe(true);
    // the bare name is not covered by the wildcard and stays denied
    expect(policy.check('http://localhost/x').allowed).toBe(false);
  });

  it('CIDR entries admit ranges', () => {
    const policy = new EgressPolicy({ allow: ['192.168.0.0/16'] });
    expect(policy.check('http://192.168.5.5/x').allowed).toBe(true);
    expect(policy.check('http://10.0.0.5/x').allowed).toBe(false);
    const v6 = new EgressPolicy({ allow: ['fe80::/10'] });
    expect(v6.check('http://[fe80::2]/x').allowed).toBe(true);
  });
});

describe('http-egress: hook surface (R-EG5)', () => {
  it('denials carry a reason naming the host', () => {
    const verdict = new EgressPolicy({ allow: [] }).check('http://10.1.2.3/x');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('10.1.2.3');
  });

  it('malformed URLs do not throw and are treated as public-hostname checks', () => {
    const policy = new EgressPolicy({ allow: [] });
    expect(() => policy.check('not a url')).not.toThrow();
    expect(policy.check('not a url').allowed).toBe(true);
  });
});
