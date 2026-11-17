/**
 * Downloads filter state (FMD2 tsDownload filter tree + search box,
 * web-adapted; tsk-retro-fountain-tasks).
 *
 * ONE filter object <-> the URL query string (hash router), mirroring
 * browse-filter-state: the entries list is a PURE function of the
 * state; the toolbar/filters edit state only (never the fetch).
 *
 * URL params: `states` (csv multi-select), `q` (search substring),
 * `window` (all|today|7d|month|older|custom — FMD2's History date
 * windows), `from`/`to` (custom range, YYYY-MM-DD). The client maps
 * the window onto the API's addedFrom/addedTo range (see
 * {@link dateWindowToRange}); the server never sees the preset.
 */
import type { JobStateT } from '../api/hooks';

export type DateWindow = '' | 'today' | '7d' | 'month' | 'older' | 'custom';

export const DATE_WINDOWS: readonly { readonly value: DateWindow; readonly label: string }[] = [
  { value: '', label: 'all time' },
  { value: 'today', label: 'today' },
  { value: '7d', label: 'last 7 days' },
  { value: 'month', label: 'last 30 days' },
  { value: 'older', label: 'older' },
  { value: 'custom', label: 'custom range' },
];

export interface DownloadsFilterState {
  /** State multi-select (empty = every state). */
  readonly states: readonly JobStateT[];
  /** Title/chapter substring (FMD2 search box). */
  readonly q: string;
  /** Date-added window preset ('custom' uses from/to). */
  readonly window: DateWindow;
  /** Custom range start (YYYY-MM-DD; window === 'custom'). */
  readonly from: string;
  /** Custom range end (YYYY-MM-DD; window === 'custom'). */
  readonly to: string;
}

export const EMPTY_DOWNLOADS_FILTERS: DownloadsFilterState = {
  states: [],
  q: '',
  window: '',
  from: '',
  to: '',
};

const JOB_STATES: readonly JobStateT[] = [
  'queued',
  'running',
  'retry',
  'done',
  'failed',
  'cancelled',
];

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Derive the API addedFrom/addedTo range from the window preset. */
export function dateWindowToRange(
  state: Pick<DownloadsFilterState, 'window' | 'from' | 'to'>,
  now: Date = new Date(),
): { readonly addedFrom?: string; readonly addedTo?: string } {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = 86_400_000;
  switch (state.window) {
    case 'today':
      return { addedFrom: dayString(todayMs), addedTo: dayString(todayMs) };
    case '7d':
      return { addedFrom: dayString(todayMs - 6 * day), addedTo: dayString(todayMs) };
    case 'month':
      return { addedFrom: dayString(todayMs - 29 * day), addedTo: dayString(todayMs) };
    case 'older':
      return { addedTo: dayString(todayMs - 30 * day) };
    case 'custom': {
      const addedFrom = state.from !== '' ? state.from : undefined;
      const addedTo = state.to !== '' ? state.to : undefined;
      return {
        ...(addedFrom !== undefined ? { addedFrom } : {}),
        ...(addedTo !== undefined ? { addedTo } : {}),
      };
    }
    default:
      return {};
  }
}

/** Parse the URL query into filter state (unknown values dropped). */
export function parseDownloadsFilters(query: Record<string, string>): DownloadsFilterState {
  const rawStates = query['states'] ?? '';
  const states = rawStates
    .split(',')
    .map((value): string => value.trim())
    .filter((value): boolean => (JOB_STATES as readonly string[]).includes(value));
  const window = (query['window'] ?? '') as DateWindow;
  return {
    states: states as readonly JobStateT[],
    q: query['q'] ?? '',
    window: DATE_WINDOWS.some((entry): boolean => entry.value === window) ? window : '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(query['from'] ?? '') ? (query['from'] as string) : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query['to'] ?? '') ? (query['to'] as string) : '',
  };
}

/** Serialize filter state back into URL query params (empty = dropped). */
export function downloadsFiltersToQuery(state: DownloadsFilterState): Record<string, string> {
  const query: Record<string, string> = {};
  if (state.states.length > 0) {
    query['states'] = state.states.join(',');
  }
  if (state.q !== '') {
    query['q'] = state.q;
  }
  if (state.window !== '') {
    query['window'] = state.window;
  }
  if (state.window === 'custom') {
    if (state.from !== '') {
      query['from'] = state.from;
    }
    if (state.to !== '') {
      query['to'] = state.to;
    }
  }
  return query;
}
