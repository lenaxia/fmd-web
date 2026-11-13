/**
 * @fmd/web public surface (package manifest types entry): the mount id
 * and the route inventory as data. The SPA itself mounts via main.tsx;
 * nothing else in the monorepo imports this package yet.
 */

export const APP_MOUNT_ID: string = 'root';

export const ROUTES: readonly { path: string; title: string }[] = [
  { path: '/browse', title: 'Browse (catalog latest/title/search, cursor pagination)' },
  { path: '/manga', title: 'Manga detail (info + chapters + enqueue dry-run)' },
  { path: '/downloads', title: 'Downloads (jobs + WS progress, D19 reconnect/backfill)' },
  { path: '/settings', title: 'Settings (modules, capability badges, options, cookies, sync)' },
];

export function webRoutes(): readonly string[] {
  return ROUTES.map((route): string => route.path);
}
