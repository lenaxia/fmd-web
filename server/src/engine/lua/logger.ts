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
