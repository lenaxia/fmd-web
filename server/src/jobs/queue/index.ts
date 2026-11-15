/**
 * Job queue (DESIGN.md §4/§9) — public surface.
 */
// NOTE: `canonicalJson` / `payloadFingerprint` are NOT re-exported
// here — the §10 API store (api/services.js) exports the same names on
// the package barrel; import them from './queue/payloads.js' directly.
export {
  DownloadChapterJobSchema,
  InfoJobSchema,
  JobPayloadSchema,
  SyncJobSchema,
  UpdateFavoriteJobSchema,
  JOB_TYPES,
  laneForPayload,
  parseJobPayload,
  InvalidJobPayloadError,
  type DownloadChapterJob,
  type InfoJob,
  type JobPayload,
  type SyncJob,
  type UpdateFavoriteJob,
} from './payloads.js';
export {
  JOB_FAILURE_KINDS,
  InvalidJobTransitionError,
  MissingJobFailureKindError,
  assertJobTransition,
  isJobFailureKind,
  isTerminalJobState,
  type JobFailureDetail,
  type JobTransitionDetail,
} from './state-machine.js';
export {
  BUSY_TIMEOUT_MS,
  CheckpointMonitor,
  WAL_AUTOCHECKPOINT_DEFAULT_PAGES,
  openQueueDb,
  ensureJobSchema,
  walSizeBytes,
  type CheckpointMode,
  type CheckpointOutcome,
  type CheckpointStats,
  type OpenQueueDbOptions,
} from './connection.js';
export {
  ProgressCoalescer,
  type CoalescerStats,
  type JobProgress,
  type JobProgressValue,
  type ProgressCoalescerOptions,
} from './coalesce.js';
export {
  IdempotencyConflictError,
  LaneRunner,
  RETENTION_MS,
  SqliteJobQueue,
  type ClaimOptions,
  type EnqueueOptions,
  type EnqueueResult,
  type JobQueue,
  type LaneHandler,
  type LaneHandlerOutcome,
  type LaneRunnerLaneOptions,
  type LaneRunnerOptions,
  type QueueJob,
  type QueueListOptions,
  type SqliteJobQueueOptions,
} from './queue.js';
