export {
  StructuredLogger,
  ModuleScopedLogger,
  ExpressionFailureDeduper,
  LogCapture,
  createCaptureLogger,
  type LogLevel,
  type StructuredLogLine,
  type LogSink,
  type ExpressionDedupStats,
  type StructuredLoggerOptions,
} from './structured-log.js';
export {
  MetricsRegistry,
  FmdMetrics,
  declareFmdFamilies,
  LATENCY_BUCKETS_SECONDS,
  type CorpusPassRateEntry,
  type LabelSet,
  type MetricType,
  type SyncKind,
  type SyncOutcome,
} from './metrics.js';
export { InstrumentedJobQueue } from './instrumented-queue.js';
export { InstrumentedSyncService } from './instrumented-sync.js';
export {
  ReadinessProbe,
  composeReadiness,
  type ProbeCheck,
  type ReadinessProbeOptions,
} from './health.js';
export {
  backupDataDir,
  restoreDataDir,
  validateDataDir,
  type BackupOptions,
  type BackupReport,
  type RestoreOptions,
  type RestoreReport,
} from './backup.js';
