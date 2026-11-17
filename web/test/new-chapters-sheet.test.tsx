// @vitest-environment jsdom
/**
 * NewChaptersSheet unit tests (favorites-parity): the frmNewChapter
 * ADAPT's decision state machine — auto-download rows start PRE-DECIDED
 * (auto-queued, the check already enqueued them), per-row and global
 * Download / Add-to-queue / Dismiss decisions, and the pending count
 * the global controls gate on.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useNewChapterDecisions,
  type NewChapterRow,
} from '../src/components/favorites/NewChaptersSheet';

function row(overrides: Partial<NewChapterRow> & { favoriteId: string }): NewChapterRow {
  return {
    title: 'Fixture',
    website: 'site',
    count: 2,
    autoDownload: false,
    preQueued: false,
    newChapters: [
      { position: 1, link: '/ch/3', name: 'Ch. 3' },
      { position: 2, link: '/ch/4', name: 'Ch. 4' },
    ],
    ...overrides,
  };
}

describe('useNewChapterDecisions', (): void => {
  it('auto-download rows start decided (auto-queued); manual rows start pending', (): void => {
    const rows = [
      row({ favoriteId: 'auto', autoDownload: true, preQueued: true }),
      row({ favoriteId: 'manual' }),
    ];
    const { result } = renderHook((props: NewChapterRow[]) => useNewChapterDecisions(props), {
      initialProps: rows,
    });
    expect(result.current.decisions['auto']).toBe('auto-queued');
    expect(result.current.decisions['manual']).toBe('pending');
    expect(result.current.pendingCount).toBe(1);
  });

  it('per-row decisions land and clear the pending count', (): void => {
    const rows = [row({ favoriteId: 'a' }), row({ favoriteId: 'b' })];
    const { result } = renderHook((props: NewChapterRow[]) => useNewChapterDecisions(props), {
      initialProps: rows,
    });
    act((): void => {
      result.current.decide('a', 'download');
    });
    expect(result.current.decisions['a']).toBe('download');
    expect(result.current.pendingCount).toBe(1);
    act((): void => {
      result.current.decide('b', 'dismissed');
    });
    expect(result.current.pendingCount).toBe(0);
  });

  it('decideAll decides ONLY pending rows (auto-queued rows are never overwritten)', (): void => {
    const rows = [
      row({ favoriteId: 'auto', autoDownload: true, preQueued: true }),
      row({ favoriteId: 'm1' }),
      row({ favoriteId: 'm2' }),
    ];
    const { result } = renderHook((props: NewChapterRow[]) => useNewChapterDecisions(props), {
      initialProps: rows,
    });
    act((): void => {
      result.current.decideAll('queued');
    });
    expect(result.current.decisions['auto']).toBe('auto-queued');
    expect(result.current.decisions['m1']).toBe('queued');
    expect(result.current.decisions['m2']).toBe('queued');
    expect(result.current.pendingCount).toBe(0);
  });

  it('a new rows array (a fresh check result) resets the decisions', (): void => {
    const first = [row({ favoriteId: 'a' })];
    const { result, rerender } = renderHook(
      (props: NewChapterRow[]) => useNewChapterDecisions(props),
      { initialProps: first },
    );
    act((): void => {
      result.current.decide('a', 'download');
    });
    expect(result.current.decisions['a']).toBe('download');

    rerender([row({ favoriteId: 'a' }), row({ favoriteId: 'b' })]);
    expect(result.current.decisions['a']).toBe('pending');
    expect(result.current.decisions['b']).toBe('pending');
    expect(result.current.pendingCount).toBe(2);
  });
});
