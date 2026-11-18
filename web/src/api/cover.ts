/**
 * coverSrc (covers live-defect): the ONE shared seam every cover
 * render site routes through. Module GetInfo returns ABSOLUTE CDN
 * cover urls (`http://fmcdn.mfcdn.net/…cover.jpg?token=…&ttl=…`) that
 * a browser behind `img-src 'self' data: blob:` (plus mixed content
 * on the http:// forms) can NEVER load — so a cover url is rewritten
 * to the same-origin proxy `GET /api/cover` (server-side module-bound
 * validation, Referer hotlink posture, token-free disk cache; see
 * server/src/api/cover-proxy.ts). CSP stays exactly
 * `img-src 'self' data: blob:` — the proxy is the point, never a
 * loosened policy.
 *
 * data:/blob: urls pass through unchanged (CSP-allowed by design);
 * protocol-relative urls (`//zjcdn…/cover.jpg`, FanFox's shape)
 * normalize to https before proxying. An absent moduleId or empty url
 * yields undefined — callers keep their No-cover fallback.
 */
export function coverSrc(moduleId: string | undefined, url: string | undefined): string | undefined {
  if (moduleId === undefined || moduleId === '' || url === undefined || url === '') {
    return undefined;
  }
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  return `/api/cover?moduleId=${encodeURIComponent(moduleId)}&url=${encodeURIComponent(absolute)}`;
}
