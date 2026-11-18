/**
 * Preview-tunnel manifest token (covers live-defect sibling): the
 * safespaces preview proxy authenticates requests by a `?t=v1…` query
 * token carried on the page URL — but the browser's manifest fetch
 * for `<link rel="manifest">` sends ONLY the link href (no token), so
 * `/manifest.webmanifest` 401s through the preview URL (the app
 * server itself can never 401 a GET — the *arr gate ordering; the 401
 * is the tunnel's session layer). At bootstrap, when location.search
 * carries a `t` param, the manifest link href gets it appended so the
 * fetch rides the same credential. Production deployments have no `t`
 * param — pure no-op there.
 */

/**
 * Append the preview tunnel's `t` query param to the document's
 * manifest link. Returns true when the href was rewritten; false when
 * `search` carries no `t`, the param is empty, or no
 * `link[rel="manifest"]` exists (all legitimate no-ops).
 */
export function applyPreviewManifestToken(doc: Document, search: string): boolean {
  const token = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('t');
  if (token === null || token === '') {
    return false;
  }
  const link = doc.querySelector('link[rel="manifest"]');
  if (link === null) {
    return false;
  }
  const href = link.getAttribute('href');
  if (href === null || href === '') {
    return false;
  }
  const rewritten = new URL(href, doc.baseURI);
  rewritten.searchParams.set('t', token);
  // Keep the ORIGINAL href spelling (absolute or root-relative) — only
  // the query changes, so production-shaped hrefs stay recognizable.
  const query = rewritten.search.startsWith('?') ? rewritten.search : `?${rewritten.search}`;
  const base = href.includes('?') ? href.slice(0, href.indexOf('?')) : href;
  link.setAttribute('href', `${base}${query}`);
  return true;
}
