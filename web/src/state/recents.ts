/**
 * Recents plumbing (search-first home + command palette): two shared
 * localStorage-backed stores — recently opened SITES (module ids +
 * names, recorded by the site entries view) and recently opened MANGA
 * (deep-link params, recorded by the manga page). Both are CAPPED
 * (most-recent-first window), DEDUPED (re-opening moves to the front,
 * never duplicates) and CLEARABLE (the home rows own the clear
 * affordance; the palette consumes the same store, so a clear on the
 * home is immediately reflected everywhere).
 *
 * Store pattern: same module-level singletons + useSyncExternalStore
 * as the theme + highlight-new state (no provider — every consumer
 * stays in sync across the tree), localStorage keeps it across
 * sessions (the client-side stand-in for FMD2's settingsfile).
 */
import { useSyncExternalStore } from 'react';

export interface RecentSite {
  readonly id: string;
  readonly name: string;
}

/** The exact deep-link params that re-open the manga (MangaPage route). */
export interface RecentManga {
  readonly moduleId: string;
  readonly url: string;
  readonly title: string;
  readonly catalogId?: string;
}

const SITES_KEY = 'fmd.recent-sites';
const MANGA_KEY = 'fmd.recent-manga';

export const RECENT_SITES_MAX = 8;
export const RECENT_MANGA_MAX = 8;

// ── parsing (corrupt storage never crashes the app) ─────────────────

function readSites(): readonly RecentSite[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(SITES_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentSite =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)['id'] === 'string' &&
        typeof (item as Record<string, unknown>)['name'] === 'string',
    );
  } catch {
    return [];
  }
}

function readManga(): readonly RecentManga[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(MANGA_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentManga => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      const catalog = record['catalogId'];
      return (
        typeof record['moduleId'] === 'string' &&
        typeof record['url'] === 'string' &&
        typeof record['title'] === 'string' &&
        (catalog === undefined || typeof catalog === 'string')
      );
    });
  } catch {
    return [];
  }
}

function write(key: string, value: readonly unknown[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private-mode localStorage — the in-memory store still works.
  }
}

// ── module store (one subscription set for both lists) ──────────────

let currentSites: readonly RecentSite[] = readSites();
let currentManga: readonly RecentManga[] = readManga();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

// ── recent sites ────────────────────────────────────────────────────

/** Record a site open: dedupe by module id (move to front), cap at 8. */
export function pushRecentSite(site: RecentSite): void {
  currentSites = [
    site,
    ...currentSites.filter((item): boolean => item.id !== site.id),
  ].slice(0, RECENT_SITES_MAX);
  write(SITES_KEY, currentSites);
  emit();
}

export function clearRecentSites(): void {
  currentSites = [];
  write(SITES_KEY, currentSites);
  emit();
}

export function useRecentSites(): readonly RecentSite[] {
  return useSyncExternalStore(
    subscribe,
    (): readonly RecentSite[] => currentSites,
    (): readonly RecentSite[] => currentSites,
  );
}

// ── recent manga ────────────────────────────────────────────────────

function sameManga(a: RecentManga, b: RecentManga): boolean {
  return a.moduleId === b.moduleId && a.url === b.url;
}

/** Record a manga open: dedupe by (module, url), cap at 8. */
export function pushRecentManga(manga: RecentManga): void {
  currentManga = [
    manga,
    ...currentManga.filter((item): boolean => !sameManga(item, manga)),
  ].slice(0, RECENT_MANGA_MAX);
  write(MANGA_KEY, currentManga);
  emit();
}

export function clearRecentManga(): void {
  currentManga = [];
  write(MANGA_KEY, currentManga);
  emit();
}

export function useRecentManga(): readonly RecentManga[] {
  return useSyncExternalStore(
    subscribe,
    (): readonly RecentManga[] => currentManga,
    (): readonly RecentManga[] => currentManga,
  );
}

/** Test seam: re-read from storage + notify (used between cases). */
export function __resetRecentsForTest(): void {
  currentSites = readSites();
  currentManga = readManga();
  emit();
}
