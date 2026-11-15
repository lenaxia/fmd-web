import type { ImageWorkerPool, PoolItemFailure } from './types.js';
import type { PipelineWorkId } from '../../engine/pipeline/chapter-pipeline.js';

/**
 * ImageWorkerPool — the download-phase thread pool (DESIGN §7.1; FMD2
 * `TDownloadThreads` + `Checkout`, uDownloadsManager.pas:870-920):
 * `MaxThreadPerTaskLimit` concurrent workers pulling a FIFO of work ids
 * (the `InternalGetDownloadWorkId` cursor), `shouldStop` = the job
 * cancel flag stops scheduling queued-but-unstarted items (§4 fail
 * fast), and a throwing worker is isolated — the rest of the pool
 * proceeds and the error surfaces per item.
 */
export class ConcurrentImageWorkerPool implements ImageWorkerPool {
  async run(
    workIds: readonly PipelineWorkId[],
    maxThreads: number,
    worker: (workId: PipelineWorkId) => Promise<void>,
    shouldStop?: () => boolean,
  ): Promise<readonly PoolItemFailure[]> {
    const failures: PoolItemFailure[] = [];
    const queue = [...workIds];
    const threads = Math.max(1, Math.min(Math.trunc(maxThreads), queue.length));

    const runOne = async (): Promise<void> => {
      for (;;) {
        if (shouldStop?.() === true) {
          return; // queued-but-unstarted work fails fast (§4)
        }
        const workId = queue.shift();
        if (workId === undefined) {
          return;
        }
        try {
          await worker(workId);
        } catch (error) {
          failures.push({
            workId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: threads }, () => runOne()));
    return failures;
  }
}
