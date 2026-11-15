/**
 * D18 detection hook (DESIGN.md D13/D18): the smoke suite's response
 * inspector flags the "undecoded body" signature — a mismatch between
 * the Accept-Encoding we advertised, the Content-Encoding the server
 * answered with, and whether the body actually decodes. Per D13 the
 * §5.4 shim advertises only `gzip, deflate, br` (zstd omitted); per
 * D18, ≥2 affected modules in one week flip the decoder add-on on and
 * add zstd to the advertisement (docs/runbook.md → D18 flip procedure).
 *
 * The detector is PURE over observations (no I/O): the live resolver
 * records one observation per response (headers + first body bytes as
 * they reached the module), the suite runs `detectD18` per observation
 * and folds findings into the report. Unit-tested against crafted
 * observations in server/test/tools/live-suite.test.ts.
 */

/**
 * One response observation as the module saw it. The harness runs curl
 * with `--compressed`, so `bodyLooksText`/`bodyFirstBytesHex` describe
 * the body AFTER curl's own decode pass — a text-looking body under a
 * binary Content-Encoding means the decode already succeeded (curl
 * handled the scheme); a binary-looking body under any claimed encoding
 * means the module received garbage (the D18 failure shape).
 */
export interface D18Observation {
  readonly url: string;
  /** Accept-Encoding as SENT on the request (what we advertised). */
  readonly requestAcceptEncoding: string;
  /** Content-Encoding of the response ('' when absent/identity). */
  readonly responseContentEncoding: string;
  readonly status: number;
  /** First bytes of the body the module received (hex, ≤8 bytes). */
  readonly bodyFirstBytesHex: string;
  /** Heuristic: body is printable text (HTML/JSON-ish) not binary. */
  readonly bodyLooksText: boolean;
  readonly bodyLength: number;
}

/** Structured D18 finding (the report carries these verbatim). */
export interface D18Finding {
  readonly url: string;
  /**
   * `unadvertised-encoding` — server answered with a scheme we did not
   * advertise (D18 probe signal). `undecodable-body` — the module
   * received binary garbage under a claimed encoding (hard D18 hit).
   * `binary-body-without-encoding` — binary body with no encoding
   * claimed (integrity anomaly).
   */
  readonly signature: 'unadvertised-encoding' | 'undecodable-body' | 'binary-body-without-encoding';
  /** `d18-hit` findings count toward the D18 flip threshold. */
  readonly severity: 'info' | 'd18-hit';
  readonly advertised: string;
  readonly contentEncoding: string;
  /** True when the body looks properly decoded (text) to the heuristic. */
  readonly decodable: boolean;
  readonly detail: string;
}

/** Advertised encoding list as a normalized array ('gzip, deflate, br' → ['gzip','deflate','br']). */
export function parseAdvertisedEncodings(acceptEncoding: string): string[] {
  return acceptEncoding
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '' && s !== 'identity');
}

/**
 * Text heuristic on the first body bytes: printable ASCII/UTF-8 lead
 * (HTML tag, JSON brace, whitespace, letter) and no NUL byte anywhere
 * in the inspected window. Binary encodings decoded to garbage almost
 * always lead with non-printable bytes or NULs.
 */
export function bodyLooksLikeText(firstBytes: Buffer): boolean {
  if (firstBytes.length === 0) {
    return false;
  }
  if (firstBytes.includes(0)) {
    return false;
  }
  const window = firstBytes.subarray(0, 64);
  let printable = 0;
  for (const byte of window) {
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
    } else if (byte >= 0x80) {
      printable += 1; // UTF-8 continuation/lead bytes count as text-ish
    }
  }
  return printable / window.length >= 0.9;
}

/** Known magic prefixes: gzip 1f8b, zstd 28 b5 2f fd, zlib-wrapped deflate 78. */
function hasKnownMagic(hex: string): boolean {
  const h = hex.toLowerCase();
  return h.startsWith('1f8b') || h.startsWith('28b52ffd') || h.startsWith('78');
}

/**
 * The D18 detector. Returns a finding only on a mismatch — clean
 * responses (no encoding, advertised encoding, decoded body) produce
 * `undefined`.
 */
export function detectD18(obs: D18Observation): D18Finding | undefined {
  const advertised = parseAdvertisedEncodings(obs.requestAcceptEncoding);
  const claimed = obs.responseContentEncoding.trim().toLowerCase();
  const decodable = obs.bodyLooksText;

  if (claimed === '' || claimed === 'identity') {
    if (!decodable && obs.bodyLength > 0 && !hasKnownMagic(obs.bodyFirstBytesHex)) {
      return {
        url: obs.url,
        signature: 'binary-body-without-encoding',
        severity: 'info',
        advertised: obs.requestAcceptEncoding,
        contentEncoding: claimed,
        decodable,
        detail: `binary body (${obs.bodyLength}B, magic ${obs.bodyFirstBytesHex}) with no Content-Encoding claimed`,
      };
    }
    return undefined;
  }

  if (!advertised.includes(claimed)) {
    // Server ignored our Accept-Encoding negotiation (D18 probe signal):
    // a text body means the client decoded it anyway (informational);
    // garbage means the module got the undecoded body (hard hit).
    if (decodable) {
      return {
        url: obs.url,
        signature: 'unadvertised-encoding',
        severity: 'info',
        advertised: obs.requestAcceptEncoding,
        contentEncoding: claimed,
        decodable,
        detail: `server sent Content-Encoding "${claimed}" though we advertised [${advertised.join(', ')}] — body decoded anyway (curl handles it; the app decoder may not)`,
      };
    }
    return {
      url: obs.url,
      signature: 'undecodable-body',
      severity: 'd18-hit',
      advertised: obs.requestAcceptEncoding,
      contentEncoding: claimed,
      decodable,
      detail: `server sent UNADVERTISED Content-Encoding "${claimed}" and the body is undecodable binary (${obs.bodyLength}B, magic ${obs.bodyFirstBytesHex}) — module received garbage`,
    };
  }

  // Claimed encoding WAS advertised but the body is not decoded text.
  // An empty body under a 2xx + claimed encoding is the curl-61 shape
  // (decode pass died mid-transfer) — equally an undecodable-body hit.
  if (!decodable && obs.status >= 200 && obs.status < 300) {
    return {
      url: obs.url,
      signature: 'undecodable-body',
      severity: 'd18-hit',
      advertised: obs.requestAcceptEncoding,
      contentEncoding: claimed,
      decodable,
      detail: `Content-Encoding "${claimed}" was advertised but the body is undecodable (${obs.bodyLength}B, magic ${obs.bodyFirstBytesHex}) — decode pass failed`,
    };
  }
  return undefined;
}
