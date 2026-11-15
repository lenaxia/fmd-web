import { PackError } from './errors.js';

/**
 * D16 per-job memory budget (DESIGN.md §7.3): the pack stage samples the
 * process memory between item appends and fails the pack — as `pack`,
 * retryable — when the attributed memory crosses the budget. The metric
 * is `heapUsed + external + arrayBuffers`: Buffers and typed arrays live
 * outside the V8 heap, so heapUsed alone would miss the interesting part
 * of a streaming pack.
 */

/** Attributed-memory snapshot (`process.memoryUsage()` derived). */
export interface MemorySample {
  readonly heapUsedBytes: number;
  readonly rssBytes: number;
}

export const DEFAULT_MEMORY_BUDGET_BYTES: number = 512 * 1024 * 1024;

/** The attributed-memory metric used for sampling (exported for tests). */
export function attributedMemoryBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external + usage.arrayBuffers;
}

/**
 * Pack-context memory budget. `sample()` must be called between item
 * appends (it throws on breach); `charge()` accounts for the few bytes a
 * packer deliberately routes through memory (metadata documents, xref
 * offsets) so small-chapter packs still exercise the budget honestly.
 */
export class MemoryBudget {
  readonly limitBytes: number;
  private peakHeap = 0;
  private peakRss = 0;

  constructor(limitBytes: number = DEFAULT_MEMORY_BUDGET_BYTES) {
    this.limitBytes = limitBytes;
  }

  /** Account `bytes` of deliberate in-memory data, failing on breach. */
  charge(bytes: number): void {
    if (bytes > this.limitBytes) {
      throw new PackError(
        'pack-budget-exceeded',
        `in-memory charge ${bytes} bytes exceeds the ${this.limitBytes} byte pack budget`,
        { recoveryHint: 're-encode-pages' },
      );
    }
  }

  /**
   * Sample the process and enforce the budget. Throws PackError
   * (`pack-budget-exceeded`, retryable, re-encode hint) on breach.
   */
  sample(): MemorySample {
    const usage = process.memoryUsage();
    const attributed = usage.heapUsed + usage.external + usage.arrayBuffers;
    this.peakHeap = Math.max(this.peakHeap, attributed);
    this.peakRss = Math.max(this.peakRss, usage.rss);
    if (attributed > this.limitBytes) {
      throw new PackError(
        'pack-budget-exceeded',
        `pack attributed memory ${(attributed / 1024 / 1024).toFixed(1)} MiB exceeds the D16 budget (${(this.limitBytes / 1024 / 1024).toFixed(0)} MiB)`,
        { recoveryHint: 're-encode-pages' },
      );
    }
    return { heapUsedBytes: attributed, rssBytes: usage.rss };
  }

  get peakHeapBytes(): number {
    return this.peakHeap;
  }

  get peakRssBytes(): number {
    return this.peakRss;
  }
}
