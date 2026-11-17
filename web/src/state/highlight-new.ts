/**
 * Highlight-new manga state (FMD2 miHighlightNewManga parity,
 * frmMain.lfm:5817 + frmMain.pas:2465-2468): ONE persisted,
 * workspace-global toggle that gates the new-manga row accent on every
 * catalog entry list (site browse AND all-sites union — FMD2's setting
 * is global too, settingsfile 'general'/'HighlightNewManga', default
 * True at frmMain.pas:5820).
 *
 * The accent's recency window reuses the filter's only-new day setting
 * (`newDays`, URL param `new`) exactly like FMD2's single
 * OptionNewMangaTime feeding both cbOnlyNew and the paint
 * (frmMain.pas:6329-6330); when no window is active the FMD2 default
 * applies (NewMangaTime default 1 day, frmMain.pas:5953).
 *
 * Persistence: localStorage (the client-side stand-in for FMD2's
 * settingsfile, same pattern as the theme + per-manga save-to recall).
 */
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'fmd.highlight-new';

/** FMD2 default: ReadBool('general', 'HighlightNewManga', True). */
export const HIGHLIGHT_NEW_DEFAULT = true;
/** FMD2 default window: ReadInteger('update', 'NewMangaTime', 1) days. */
export const NEW_MANGA_WINDOW_DAYS_DEFAULT = 1;

function isHighlightNewStored(): boolean {
  const raw: string | null = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  return raw === null ? HIGHLIGHT_NEW_DEFAULT : raw === '1';
}

// Module-level store: the toggle is global (FMD2 parity), shared by
// every list without a provider — useSyncExternalStore keeps instances
// in sync, localStorage keeps it across sessions.
let current: boolean = isHighlightNewStored();
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

function getSnapshot(): boolean {
  return current;
}

function setHighlightNew(next: boolean): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Private-mode localStorage — the in-memory toggle still works.
  }
  emit();
}

/** [enabled, toggle]: the global persisted highlight-new state. */
export function useHighlightNew(): readonly [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = useCallback((next: boolean): void => {
    setHighlightNew(next);
  }, []);
  return [enabled, set] as const;
}

// ── JDN window math (uBaseUnit.pas:2740 DateToJDN parity) ──────────

/**
 * Gregorian date → Julian day number — the same integer algorithm as
 * the server's `dateToJdn` (sync/db/jdn.ts; FMD2 uBaseUnit.pas:2740).
 * Client-local so the accent computation never needs a fetch.
 */
export function dateToJdn(date: { readonly year: number; readonly month: number; readonly day: number }): number {
  const a: number = Math.floor((14 - date.month) / 12);
  const y: number = date.year + 4800 - a;
  const m: number = date.month + 12 * a - 3;
  return (
    date.day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** JDN of today (UTC — the same anchor the server's only-new filter uses). */
export function todayJdn(now: Date = new Date()): number {
  return dateToJdn({
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  });
}

/**
 * vtMangaListBeforeCellPaint parity (frmMain.pas:5132):
 * `jdn > OptionJDNNewMangaTime` where the threshold is JDN(today) -
 * windowDays. The window is the filter's day setting when active, the
 * FMD2 default otherwise.
 */
export function isNewEntry(
  jdn: number,
  windowDays: number | undefined,
  now: Date = new Date(),
): boolean {
  const days: number = windowDays ?? NEW_MANGA_WINDOW_DAYS_DEFAULT;
  return jdn > todayJdn(now) - days;
}

/** Test seam: reset the module store between cases. */
export function __resetHighlightNewForTest(): void {
  current = isHighlightNewStored();
  emit();
}
