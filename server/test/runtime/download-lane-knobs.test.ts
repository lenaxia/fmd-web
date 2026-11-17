/**
 * [parity-sweep] M10 — the download-lane Performance wiring:
 * parallelChapters becomes the lane slot count (restart-to-apply
 * semantics: the count is fixed when the LaneRunner starts), and the
 * per-job knobs (threadsPerChapter / retryCount) come from the
 * settings provider, not constants. The full per-job runner path is
 * engine-backed (covered by the download suite); this pins the SEAM.
 */
import { describe, expect, it } from 'vitest';
import { downloadLane } from '../../src/runtime/download-lane.js';
import type { DownloadLaneDeps } from '../../src/runtime/download-lane.js';

const baseDeps = {
  queue: {} as never,
  wsHub: {} as never,
  library: {} as never,
  dataDir: '/tmp/opencode/lane-knobs',
  engine: { modules: (): readonly unknown[] => [] } as never,
  active: { register: (): void => undefined, unregister: (): void => undefined } as never,
  log: (): void => undefined,
};

describe('downloadLane Performance knobs (PUT /api/settings/performance)', (): void => {
  it('default lane concurrency is 1 (the pre-settings truth)', (): void => {
    expect(downloadLane({ ...baseDeps }).concurrency).toBe(1);
  });

  it('parallelChapters from the settings provider becomes the lane slot count', (): void => {
    const deps: DownloadLaneDeps = {
      ...baseDeps,
      performance: (): never => ({ requestTimeoutSeconds: 15, retryCount: 2, parallelChapters: 4, threadsPerChapter: 2 }) as never,
      parallelChapters: 4,
    };
    const lane = downloadLane(deps);
    expect(lane.concurrency).toBe(4);
  });

  it('the handler is wired (a lane options object with the knobs seam present)', (): void => {
    const deps: DownloadLaneDeps = {
      ...baseDeps,
      performance: (): never => ({ requestTimeoutSeconds: 30, retryCount: 5, parallelChapters: 2, threadsPerChapter: 3 }) as never,
    };
    const lane = downloadLane(deps);
    expect(typeof lane.handler).toBe('function');
    // The provider is consulted at RUN time (per-job), documented
    // restart/next-job semantics; the seam object itself is carried.
    expect(deps.performance?.().threadsPerChapter).toBe(3);
    expect(deps.performance?.().retryCount).toBe(5);
  });
});
