import type { HostLogRecord, HostLogger, ModuleId } from '@fmd/contract';

/**
 * Structured logger sink (§5.1 print routing): collects records for
 * assertions; the production sink plugs into the API logging story.
 */

export class MemoryLogger implements HostLogger {
  private readonly records_: HostLogRecord[] = [];

  get records(): readonly HostLogRecord[] {
    return this.records_;
  }

  write(record: HostLogRecord): void {
    this.records_.push(record);
  }

  forModule(moduleId: ModuleId): readonly HostLogRecord[] {
    return this.records_.filter((r) => r.moduleId === moduleId);
  }

  clear(): void {
    this.records_.length = 0;
  }
}

export function createMemoryLogger(): MemoryLogger {
  return new MemoryLogger();
}

/**
 * MemoryLogger that ALSO forwards every record to a sink (§4
 * observability tee): engine internals keep their full in-memory
 * record set, while the run's structured log receives the same lines
 * (module-id correlation + swallow WARN dedup happen downstream).
 */
export class TeeMemoryLogger extends MemoryLogger {
  private readonly tee: (record: HostLogRecord) => void;

  constructor(tee: (record: HostLogRecord) => void) {
    super();
    this.tee = tee;
  }

  override write(record: HostLogRecord): void {
    super.write(record);
    this.tee(record);
  }
}
