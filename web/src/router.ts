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
