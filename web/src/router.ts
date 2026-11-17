/**
 * Minimal hash router (§11 SPA): `#/browse?…`, `#/manga?…`,
 * `#/downloads`, `#/favorites`, `#/settings`. No router dependency — the
 * pages and their query params are the entire surface; `navigate()` and
 * the `useRoute()` hook keep the URL shareable.
 */

export type RouteName = 'browse' | 'manga' | 'downloads' | 'favorites' | 'library' | 'settings';

export const ROUTE_NAMES: readonly RouteName[] = ['browse', 'manga', 'downloads', 'favorites', 'library', 'settings'];

export interface Route {
  readonly name: RouteName;
  readonly query: Record<string, string>;
}

const DEFAULT_ROUTE: RouteName = 'browse';

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
