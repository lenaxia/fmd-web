/**
 * SPA placeholder (DESIGN.md §11 web/). React + Vite wiring lands in
 * Phase 2 (Browse · Manga · Favorites · Downloads · Settings; module
 * options, cookies, broken flags in Settings).
 */

export const SPA_MOUNT_ID: string = 'root';

export interface WebAppInfo {
  readonly name: 'fmd-web-spa';
  readonly status: 'placeholder';
  readonly views: readonly string[];
}

export const PLANNED_VIEWS: readonly string[] = [
  'Browse',
  'Manga',
  'Favorites',
  'Downloads',
  'Settings',
];

export function webAppInfo(): WebAppInfo {
  return {
    name: 'fmd-web-spa',
    status: 'placeholder',
    views: PLANNED_VIEWS,
  };
}
