/**
 * Minimal hash router (§11 SPA): `#/inbox?…` (the Home feed),
 * `#/browse?…`, `#/manga?…`, `#/attention`, `#/downloads`,
 * `#/favorites`, `#/settings`. No router dependency — the pages and
 * their query params are the entire surface; `navigate()` and the
 * `useRoute()` hook keep the URL shareable.
 */

export type RouteName =
  | 'inbox'
  | 'browse'
  | 'manga'
  | 'attention'
  | 'downloads'
  | 'favorites'
  | 'library'
  | 'settings';

export const ROUTE_NAMES: readonly RouteName[] = [
  'inbox',
  'browse',
  'manga',
  'attention',
  'downloads',
  'favorites',
  'library',
  'settings',
];

export interface Route {
  readonly name: RouteName;
  readonly query: Record<string, string>;
}

/**
 * Home IS the inbox (D1 §2 INBOX — the pipe-with-an-inbox identity:
 * arrival is a feed you clear, and the home surface answers "what
 * arrived since I last looked"). The old search-home default lives on
 * at `#/browse` (deep links unchanged); unknown hashes land on the
 * feed.
 */
const DEFAULT_ROUTE: RouteName = 'inbox';

function isRouteName(value: string): value is RouteName {
  return (ROUTE_NAMES as readonly string[]).includes(value);
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [path = '', search = ''] = raw.split('?');
  const name = isRouteName(path) ? path : DEFAULT_ROUTE;
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search).entries()) {
    query[k] = v;
  }
  return { name, query };
}

export function routeToHash(name: RouteName, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `#/${name}${search === '' ? '' : `?${search}`}`;
}

export function navigate(name: RouteName, query: Record<string, string> = {}): void {
  globalThis.location.hash = routeToHash(name, query);
}

/**
 * Back-context (UX audit M-1): every entry row that opens the manga
 * detail page navigates through this helper so the detail page's Back
 * can restore the ORIGINATING list with its full URL state (site
 * filters, facets, scroll-era query). The origin rides as the `from`
 * query param carrying the complete current hash — shareable URLs keep
 * working (from survives reload, where session history does not).
 *
 * Chained manga→manga navigation (palette from the detail page)
 * preserves the ORIGINAL origin instead of pointing back at the
 * previous detail page: Back always returns to a LIST, never to
 * another detail view. Opening a detail page from a deep link (no
 * prior in-app hash) simply omits `from` — Back then falls back to
 * history.back()/browse home.
 */
export function navigateToManga(query: Record<string, string>): void {
  const current = parseHash(globalThis.location.hash);
  let origin: string | undefined;
  if (current.name === 'manga') {
    const chained: string | undefined = current.query.from;
    origin = chained !== undefined && chained !== '' ? chained : undefined;
  } else {
    origin = globalThis.location.hash;
  }
  const next: Record<string, string> = { ...query };
  if (origin !== undefined && origin !== '') {
    next['from'] = origin;
  }
  navigate('manga', next);
}

/**
 * True once ANY hashchange fired in this document — i.e. the user
 * navigated within the SPA at least once, so `history.back()` from a
 * detail page is guaranteed to land on an in-app view rather than
 * leaving the app (the deep-link-in-fresh-tab case reports false).
 * Module state resets on reload BY DESIGN: after a reload the only
 * durable origin record is the `from` param.
 */
let inAppHashObserved = false;
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener(
    'hashchange',
    (): void => {
      inAppHashObserved = true;
    },
    { passive: true },
  );
}
export function hasInAppHistory(): boolean {
  return inAppHashObserved;
}

/**
 * Replace the current history entry (no back-button footprint) and
 * notify the app shell — the URL-sync channel for high-frequency state
 * (as-you-type search text): the URL stays shareable/current while
 * typing never pushes a history entry per keystroke. Discrete filter
 * applications keep using {@link navigate} (push → back restores).
 */
export function replaceRoute(name: RouteName, query: Record<string, string> = {}): void {
  const next: string = routeToHash(name, query);
  if (globalThis.location.hash === next) {
    return;
  }
  globalThis.history.replaceState(null, '', next);
  // Notify on a microtask: firing the synthetic hashchange synchronously
  // inside a React event handler leaves the listeners' state updates
  // unflushed under test runners; a microtask keeps the same-tick
  // ordering with a clean update boundary (browsers included).
  queueMicrotask((): void => {
    globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/**
 * Route-from-hash subscription hook. The app shell owns routing; pages
 * that sync state into the URL (Browse's filter state) subscribe so
 * they re-render on EVERY hash mutation — including replaceState-based
 * ones and back/forward navigation. `initial` seeds state before the
 * first effect run.
 */
export { useRoute } from './state/use-route';
