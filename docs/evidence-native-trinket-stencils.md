# Evidence — tsk-native-trinket-stencils (HTTP shim: full §5.4 surface + mock-server parity)

## Delivered

`server/src/engine/shims/http-shim.ts` + the §5.4 module set
(`http-headers`, `http-url`, `http-cookies`, `http-egress`,
`http-hostgate`, `http-proxy`, `http-transport`, `http-pipeline`) — the
full `LuaHTTPSend.pas:91-198` facade over a one-hop synchronous
transport port, with `httpsendthread.pas` behavioral parity:

- **Properties**: Timeout, ResultCode, ResultString, LastURL, Headers +
  Cookies (case-insensitive `Values` get/set, indexed lines), Document
  stream facade (ToString=ReadString, WriteString, jailed
  LoadFromFile/SaveToFile, Clear, writable Size — POST bodies ride in
  it; success ⇔ Size > 0, :717), MimeType, UserAgent, RetryCount
  (default 0), EnabledCookies, FollowRedirection, MaxRedirect (5),
  AllowServerErrorResponse, Compress, Terminated (abort handle +
  module-side latch).
- **Methods**: Request/GET/POST/HEAD, XHR = GET + X-Requested-With
  (:749-755), Reset/ResetBasic, the cookie method set
  (Clear/ClearCookiesStorage/GetCookies/ParseServerCookies/
  AddServerCookies/MergeCookies/RemoveCookie), SetProxy with
  HTTP|SOCKS4|SOCKS5 (undici ProxyAgent; socks-proxy-agent-backed
  dispatcher; :838-874 normalization incl. the '1080' socks default and
  the clear-on-unknown SetNoProxy path).
- **Behavioral parity**: redirects 301/302/303/307 followed AS GET (max
  5 default, Referer = pre-redirect URL); retry >500, no delay, bounded
  by RetryCount (fresh budget per redirect hop); POST moves
  Content-Type Headers→MimeType and rewrites exact `text/html` →
  `application/x-www-form-urlencoded; charset=UTF-8`; URL massaging
  (strip leading ':/', prepend scheme, MaybeEncodeURL, synacode
  EncodeURL parity); Accept-Encoding per Compress with D13 zstd
  omission; Reset/ResetBasic/AcceptImage default header sets
  (:919-954); per-host connection limits + start-interval delays
  (SyncHostGate, host-level); egress policy hook (RFC1918/link-local
  denied by default, allow-list override, checked before every hop incl.
  redirect targets); queued-but-unstarted requests fail fast on abort;
  gzip/deflate/brotli decompression in place (zstd per D13).
- **Transport**: `LoopbackHttpTransport` (loopback-only, worker-thread
  pump, Atomics wait) for the LOCAL mock-server integration tests;
  `RecordedHttpTransport` remains the offline fixture path (e2e golden
  harness untouched).

## Tests (TDD per behavior; contract→test matrices in every test file)

- `http-mock-server.integration.test.ts` — 17 tests over a LOCAL
  node:http mock server on its own worker thread (loopback only, §13
  clean). Captured-request assertions: method rewrite per 30x code,
  Referer header, redirect cap (6 hops), retry hit-counts + wall-clock
  no-delay bound, POST body + rewritten Content-Type on the wire,
  cookie persistence across two request-scoped objects via
  `SharedCookieJar` (+ ClearCookiesStorage clearing the shared store),
  Accept-Encoding captured with the zstd-free D13 value, gzip decode,
  Compress=false sends nothing, success ⇔ Size > 0 (HEAD + empty 200),
  MaybeEncodeURL on the live path, host-gate delay wiring, default
  header set + UA on the wire.
- `http-facade.test.ts` — 23 tests: the full property/method matrix
  (incl. jail round-trip + escape refusals, Size writable
  truncate/zero-fill, XHR persist quirk, cookie methods, SetProxy
  selection).
- `http-pipeline.test.ts` — 38 tests: redirect/retry/success matrix,
  fresh retry budget per hop, 4xx never retried, exact-500 not retried,
  ASER passthrough, mid-run abort between hops, queued-abort fail fast
  (<50 ms, nothing sent), egress deny pre-send + denied redirect
  targets, response-state per hop, gzip AND brotli decode, host-gate
  spacing.
- `http-proxy.test.ts` — 13: normalization matrix (:838-874), agent
  selection per kind (ProxyAgent instance; socks4/5 options type 4/5,
  :1080 default), GetProxy round-trip.
- `http-egress.test.ts` — 25 checks: RFC1918 + link-local (v4+v6) deny
  by default with reasons, public pass-through, allow-list
  exact/wildcard/CIDR overrides.
- `http-headers.test.ts` — 13: exact Reset/ResetBasic/AcceptImage sets,
  D13 zstd omission, case-insensitive Values, POST move + exact-rewrite.
- `http-url.test.ts` — 22: synacode encode/decode parity,
  MaybeEncodeURL, massageUrl, splitURL quirks, redirect Location merge.
- `http-lua.test.ts` — 3: real wasmoon round-trips (headers on the wire,
  POST rewrite, XHR, cookies) through the FacadeBridge.

## Verification

- `npx vitest run` — **671/671 green** (53 files; no-network guard
  active; the mock-server suite is loopback-only).
- `npm run typecheck` — clean; zero `any` across the shim sources and
  tests (verified by scan as well).
- `npm run lint` — clean.
- Interfaces exported: `CookieJar`/`CookieStore`/`HttpDocument` +
  `CookieJarPort`/`EgressPolicy`/`HostGatePort`/`HttpTransportPort`/
  `ProxyConfig`/`ProxySelection`/`RecordedResponse` types.
- Reviewer addition: brotli decompression test (implemented at
  `http-pipeline.ts:411` but previously untested) — parity gap closed
  during the review sweep.
