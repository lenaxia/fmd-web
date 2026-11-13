/**
 * Egress policy hook (DESIGN §5.4): SSRF guard checked before every
 * request hop. Private/link-local targets are DENIED by default; an
 * explicit allow-list (exact hosts, `*.` wildcard suffixes, IPv4/IPv6
 * CIDRs) re-admits them (e.g. the offline integration mock server on
 * loopback). Public hostnames pass unfiltered (no DNS resolution —
 * hostname-literal/IP-literal checking only; documented boundary).
 */

/** One check verdict — denials carry a human-readable reason. */
export interface EgressVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface EgressPolicyOptions {
  /** Allow-list entries: exact host, `*.suffix` wildcard, or CIDR. */
  readonly allow?: readonly string[];
}

interface IPRange {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function parseIPv4(host: string): Uint8Array | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] ?? '';
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const n = Number(part);
    if (n > 255) {
      return undefined;
    }
    bytes[i] = n;
  }
  return bytes;
}

function parseIPv6(host: string): Uint8Array | undefined {
  if (!host.includes(':')) {
    return undefined;
  }
  const head = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!/^[0-9a-fA-F:.]+$/.test(head)) {
    return undefined;
  }
  // Split around '::' (at most one).
  const dbl = head.split('::');
  if (dbl.length > 2) {
    return undefined;
  }
  const groupsOf = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const lead = groupsOf(dbl[0] ?? '');
  const tail = dbl.length === 2 ? groupsOf(dbl[1] ?? '') : [];
  const total = 8;
  if (dbl.length === 1) {
    if (lead.length !== total) {
      return undefined;
    }
  } else if (lead.length + tail.length > total - 1) {
    return undefined;
  }
  const groups: number[] = [];
  const fill = total - lead.length - tail.length;
  for (const g of lead) {
    groups.push(parseIntSafe(g));
  }
  for (let i = 0; i < fill; i++) {
    groups.push(0);
  }
  for (const g of tail) {
    groups.push(parseIntSafe(g));
  }
  if (groups.length !== total || groups.some((g) => Number.isNaN(g))) {
    return undefined;
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < total; i++) {
    const v = groups[i] ?? 0;
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function parseIntSafe(g: string): number {
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
    return Number.NaN;
  }
  return parseInt(g, 16);
}

function parseCIDR(entry: string): IPRange | undefined {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    return undefined;
  }
  const addr = entry.slice(0, slash);
  const prefix = Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0) {
    return undefined;
  }
  const v4 = parseIPv4(addr);
  if (v4 !== undefined) {
    if (prefix > 32) {
      return undefined;
    }
    return { family: 4, bytes: v4, prefix };
  }
  const v6 = parseIPv6(addr);
  if (v6 !== undefined) {
    if (prefix > 128) {
      return undefined;
    }
    return { family: 6, bytes: v6, prefix };
  }
  return undefined;
}

function inRange(bytes: Uint8Array, range: IPRange): boolean {
  if (bytes.length !== range.bytes.length) {
    return false;
  }
  let remaining = range.prefix;
  for (let i = 0; i < bytes.length; i++) {
    const a = bytes[i] ?? 0;
    const b = range.bytes[i] ?? 0;
    if (remaining >= 8) {
      if (a !== b) {
        return false;
      }
      remaining -= 8;
      continue;
    }
    if (remaining === 0) {
      return true;
    }
    const mask = (0xff << (8 - remaining)) & 0xff;
    return (a & mask) === (b & mask);
  }
  return true;
}

/**
 * Private/link-local networks denied by default (RFC1918 + loopback +
 * IPv4 link-local + IPv6 ::1/fe80::/10 + ULA + this-host + unspecified).
 */
function isPrivateV4(b: Uint8Array): boolean {
  const [o1, o2] = [b[0] ?? 0, b[1] ?? 0];
  if (o1 === 10 || o1 === 127 || o1 === 0) {
    return true; // 10/8, 127/8 (loopback), 0/8 (this-host)
  }
  if (o1 === 169 && o2 === 254) {
    return true; // 169.254/16 link-local
  }
  if (o1 === 172 && o2 >= 16 && o2 <= 31) {
    return true; // 172.16/12
  }
  if (o1 === 192 && o2 === 168) {
    return true; // 192.168/16
  }
  return false;
}

function isPrivateV6(b: Uint8Array): boolean {
  let allZero = true;
  for (const byte of b) {
    if (byte !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    return true; // '::' unspecified (covers ::1 check via last byte? no — exact)
  }
  // exact ::1
  let notOne = false;
  for (let i = 0; i < 15; i++) {
    if ((b[i] ?? 0) !== 0) {
      notOne = true;
      break;
    }
  }
  if (!notOne && (b[15] ?? 0) === 1) {
    return true;
  }
  // fe80::/10 link-local and fc00::/7 ULA share the high-bit patterns
  const first = b[0] ?? 0;
  if (first === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) {
    return true;
  }
  if ((first & 0xfe) === 0xfc) {
    return true;
  }
  return false;
}

/** Hostname extraction for policy checks (IP literals stay bracketed for v6). */
export function egressHostOf(url: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  if (m === null) {
    return '';
  }
  const authority = m[1] ?? '';
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const colon = hostPort.indexOf(':', hostPort.startsWith('[') ? hostPort.indexOf(']') : 0);
  return colon === -1 ? hostPort : hostPort.slice(0, colon);
}

export class EgressPolicy {
  private readonly allowHosts = new Set<string>();
  private readonly allowWildcards: string[] = [];
  private readonly allowRanges: IPRange[] = [];

  constructor(options: EgressPolicyOptions = {}) {
    for (const entry of options.allow ?? []) {
      const cidr = parseCIDR(entry);
      if (cidr !== undefined) {
        this.allowRanges.push(cidr);
        continue;
      }
      if (entry.startsWith('*.')) {
        this.allowWildcards.push(entry.slice(1).toLowerCase());
        continue;
      }
      this.allowHosts.add(entry.toLowerCase());
    }
  }

  /** Check one (massaged) request URL against the policy. */
  check(url: string): EgressVerdict {
    const host = egressHostOf(url);
    if (host === '') {
      return { allowed: true, reason: '' };
    }
    const hostLower = host.toLowerCase();
    const ipBytes = parseIPv4(hostLower) ?? parseIPv6(hostLower);
    if (ipBytes !== undefined) {
      const privateHit =
        ipBytes.length === 4 ? isPrivateV4(ipBytes) : isPrivateV6(ipBytes);
      if (!privateHit) {
        return { allowed: true, reason: '' };
      }
      if (this.allowHosts.has(hostLower)) {
        return { allowed: true, reason: '' };
      }
      for (const range of this.allowRanges) {
        if (range.family === (ipBytes.length === 4 ? 4 : 6) && inRange(ipBytes, range)) {
          return { allowed: true, reason: '' };
        }
      }
      return {
        allowed: false,
        reason: `egress denied: private/link-local target ${host} (add it to the egress allow-list to override)`,
      };
    }
    // hostname (non-IP): public by default, allow-list may include it
    for (const w of this.allowWildcards) {
      if (hostLower.endsWith(w)) {
        return { allowed: true, reason: '' };
      }
    }
    if (this.allowHosts.has(hostLower)) {
      return { allowed: true, reason: '' };
    }
    const isLocalish = /\.localhost$/.test(hostLower) || hostLower === 'localhost';
    if (isLocalish) {
      return {
        allowed: false,
        reason: `egress denied: private/link-local target ${host} (add it to the egress allow-list to override)`,
      };
    }
    return { allowed: true, reason: '' };
  }
}
