import type { ModuleId } from '@fmd/contract';

/**
 * Structured JSON logging (DESIGN.md §4 observability): one JSON object
 * per line on stdout, with `module` carrying the module-id correlation
 * so an operator can trace every log line back to the site module (and
 * its engine call) that produced it.
 *
 * Expression-failure WARN dedup (§5.6 / review minors): modules routinely
 * evaluate hundreds of XPath/JSON expressions that fail by design (the
 * engine swallows evaluation errors, FMD2 Eval semantics). Unbounded WARN
 * spam would drown the log, so each (module, expression-template) pair
 * emits AT MOST ONE WARN per run — every suppressed repeat only bumps the
 * `suppressed` counter, which the metrics endpoint exports. The dedup set
 * lives on the logger instance (= one per process run), not per engine,
 * so the bound holds across worker recycling.
 *
 * Sink injectable: tests capture lines with a `LogCapture` instead of
 * process.stdout (log-capture test).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One structured log line, as serialized (the test-facing shape). */
export interface StructuredLogLine {
  /** RFC 3339 UTC timestamp. */
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  /** Module-id correlation (present when the line is module-scoped). */
  readonly module?: string;
  /** Stable event name for alerting/grepping (e.g. `expression_failure`). */
  readonly event?: string;
  /** Every other field passes through (numbers stay numbers). */
  readonly [field: string]: unknown;
}

export type LogSink = (line: string) => void;

export interface ExpressionDedupStats {
  /** Distinct (module, expression-template) pairs that warned this run. */
  readonly warned: number;
  /** Repeat failures suppressed after their pair's single WARN. */
  readonly suppressed: number;
}

/**
 * Run-level expression-failure deduper: max 1 WARN per
 * (module, expression-template) per run (review-minor bound), plus the
 * suppressed/reported counters the metrics endpoint re-exports.
 */
export class ExpressionFailureDeduper {
  private readonly seen = new Set<string>();
  private warnedCount = 0;
  private suppressedCount = 0;

  /**
   * Report one failed expression evaluation. Returns true when this
   * pair's WARN is due (first sighting this run) — the caller logs it —
   * and false when the failure was counted as suppressed instead.
   */
  report(moduleId: ModuleId, expressionTemplate: string): boolean {
    const key = `${moduleId}|${expressionTemplate}`;
    if (this.seen.has(key)) {
      this.suppressedCount += 1;
      return false;
    }
    this.seen.add(key);
    this.warnedCount += 1;
    return true;
  }

  stats(): ExpressionDedupStats {
    return { warned: this.warnedCount, suppressed: this.suppressedCount };
  }

  /** Distinct failing pairs so far (the cardinality bound, for tests). */
  get size(): number {
    return this.seen.size;
  }
}

export interface StructuredLoggerOptions {
  /** Default `process.stdout.write`; tests pass a capture sink. */
  readonly sink?: LogSink;
  /** Include ts even in tests? Default true. */
  readonly now?: () => Date;
}

export class StructuredLogger {
  private readonly sink: LogSink;
  private readonly now: () => Date;
  /** Run-level expression-failure dedup (§5.6 review bound). */
  readonly expressionDedup = new ExpressionFailureDeduper();
  /**
   * [parity-sweep] M13: diagnostics settings (PUT /api/settings/
   * diagnostics), applied LIVE — records below the minimum level (or
   * everything, when disabled) are dropped before the sink. Default:
   * enabled at debug (no filtering — the pre-settings behavior).
   */
  private diagnostics: { logEnabled: boolean; logLevel: LogLevel } = {
    logEnabled: true,
    logLevel: 'debug',
  };

  constructor(options: StructuredLoggerOptions = {}) {
    this.sink = options.sink ?? ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
    this.now = options.now ?? ((): Date => new Date());
  }

  /** [parity-sweep] M13: apply the diagnostics settings (live). */
  applyDiagnostics(settings: { logEnabled: boolean; logLevel: LogLevel }): void {
    this.diagnostics = { ...settings };
  }

  diagnosticsSettings(): { logEnabled: boolean; logLevel: LogLevel } {
    return { ...this.diagnostics };
  }

  debug(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('error', msg, fields);
  }

  /** Plain-message adapter for call sites that log `fmd: …` strings. */
  plain(message: string): void {
    this.write('info', message);
  }

  /**
   * Module-scoped line: `module` rides every record (module-id
   * correlation, §4).
   */
  forModule(moduleId: ModuleId): ModuleScopedLogger {
    return new ModuleScopedLogger(this, moduleId);
  }

  /**
   * A failed (swallowed) expression evaluation: ONE WARN per
   * (module, expression-template) per run; repeats only raise the
   * suppressed counter (observable via metrics + {@link dedupStats}).
   */
  warnExpressionFailure(
    moduleId: ModuleId,
    expressionTemplate: string,
    message: string,
  ): void {
    if (this.expressionDedup.report(moduleId, expressionTemplate)) {
      this.write('warn', `expression failed (suppressed repeats share this WARN): ${message}`, {
        event: 'expression_failure',
        module: moduleId,
        expressionTemplate,
      });
    }
  }

  /** The run-level dedup counters (tests + metrics export). */
  dedupStats(): ExpressionDedupStats {
    return this.expressionDedup.stats();
  }

  private write(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    // [parity-sweep] M13: the diagnostics filter (enable + min level).
    if (!this.diagnostics.logEnabled || LEVEL_RANK[level] < LEVEL_RANK[this.diagnostics.logLevel]) {
      return;
    }
    const record: Record<string, unknown> = { ts: this.now().toISOString(), level, msg };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        record[key] = value;
      }
    }
    this.sink(JSON.stringify(record));
  }
}

/** [parity-sweep] M13: level ordering for the minimum-level filter. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Module-bound view — every line carries the same `module` id. */
export class ModuleScopedLogger {
  constructor(
    private readonly parent: StructuredLogger,
    private readonly moduleId: ModuleId,
  ) {}

  debug(msg: string, fields: Record<string, unknown> = {}): void {
    this.parent.debug(msg, { ...fields, module: this.moduleId });
  }

  info(msg: string, fields: Record<string, unknown> = {}): void {
    this.parent.info(msg, { ...fields, module: this.moduleId });
  }

  warn(msg: string, fields: Record<string, unknown> = {}): void {
    this.parent.warn(msg, { ...fields, module: this.moduleId });
  }

  error(msg: string, fields: Record<string, unknown> = {}): void {
    this.parent.error(msg, { ...fields, module: this.moduleId });
  }

  warnExpressionFailure(expressionTemplate: string, message: string): void {
    this.parent.warnExpressionFailure(this.moduleId, expressionTemplate, message);
  }
}

/** Capture sink for log-capture tests (parses lines back to objects). */
export class LogCapture {
  readonly lines: StructuredLogLine[] = [];
  readonly raw: string[] = [];

  readonly sink: LogSink = (line: string): void => {
    this.raw.push(line);
    this.lines.push(JSON.parse(line) as StructuredLogLine);
  };

  byLevel(level: LogLevel): readonly StructuredLogLine[] {
    return this.lines.filter((line) => line.level === level);
  }

  byEvent(event: string): readonly StructuredLogLine[] {
    return this.lines.filter((line) => line.event === event);
  }

  forModule(moduleId: string): readonly StructuredLogLine[] {
    return this.lines.filter((line) => line.module === moduleId);
  }
}

export function createCaptureLogger(options: StructuredLoggerOptions = {}): {
  logger: StructuredLogger;
  capture: LogCapture;
} {
  const capture = new LogCapture();
  return { logger: new StructuredLogger({ ...options, sink: capture.sink }), capture };
}
