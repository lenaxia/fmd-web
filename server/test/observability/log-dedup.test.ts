/**
 * Expression-failure WARN dedup (§5.6 review bound, acceptance): 100
 * identical expression failures → exactly ONE WARN line + the
 * warned/suppressed counters (log-capture test). Also covers: distinct
 * templates/modules warn independently, the per-run bound holds ACROSS
 * separate engine SwallowLogger instances sharing one run deduper, and
 * every line carries module-id correlation.
 */
import { describe, expect, it } from 'vitest';
import {
  createCaptureLogger,
} from '../../src/observability/structured-log.js';
import { SwallowLogger } from '../../src/engine/shims/txquery-shim.js';
import type { HostLogRecord } from '@fmd/contract';

const MODULE = 'a'.repeat(32);
const TEMPLATE = 'css(.chapter-list a)@href';

describe('expression-failure WARN dedup (§5.6, per run)', (): void => {
  it('100 identical failures → 1 WARN + counters (warned 1, suppressed 99)', (): void => {
    const { logger, capture } = createCaptureLogger();
    for (let i = 0; i < 100; i += 1) {
      logger.warnExpressionFailure(MODULE, TEMPLATE, `evaluation failed (attempt ${String(i)})`);
    }
    const warns = capture.byEvent('expression_failure');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.level).toBe('warn');
    expect(warns[0]?.module).toBe(MODULE);
    expect(warns[0]?.expressionTemplate).toBe(TEMPLATE);
    expect(logger.dedupStats()).toEqual({ warned: 1, suppressed: 99 });
    // No other line leaked for the suppressed repeats.
    expect(capture.lines).toHaveLength(1);
  });

  it('distinct templates and modules warn independently', (): void => {
    const { logger, capture } = createCaptureLogger();
    for (let i = 0; i < 10; i += 1) {
      logger.warnExpressionFailure(MODULE, TEMPLATE, 'same template');
      logger.warnExpressionFailure(MODULE, 'json($.items)', 'other template');
      logger.warnExpressionFailure('b'.repeat(32), TEMPLATE, 'other module');
    }
    // 3 distinct pairs → 3 WARNs, 27 suppressed repeats.
    expect(capture.byEvent('expression_failure')).toHaveLength(3);
    expect(logger.dedupStats()).toEqual({ warned: 3, suppressed: 27 });
    expect(capture.forModule('b'.repeat(32))).toHaveLength(1);
  });

  it('the run-level bound holds across separate engine swallow loggers', (): void => {
    // Two "engines" (as worker recycling would create) sharing the ONE
    // run deduper: the second instance's identical failure is suppressed.
    const { logger } = createCaptureLogger();
    const shared = logger.expressionDedup;
    const records: HostLogRecord[] = [];
    const sink = {
      records,
      write: (record: HostLogRecord): void => {
        records.push(record);
      },
    };
    const engineA = new SwallowLogger(sink, shared);
    const engineB = new SwallowLogger(sink, shared);
    for (let i = 0; i < 50; i += 1) {
      engineA.warnOnce(MODULE, TEMPLATE, 'engine A failure');
      engineB.warnOnce(MODULE, TEMPLATE, 'engine B failure');
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.moduleId).toBe(MODULE);
    expect(logger.dedupStats()).toEqual({ warned: 1, suppressed: 99 });
    // Without a shared deduper each instance is its own scope (the
    // pre-observability behavior) — the test documents the contrast.
    const soloA = new SwallowLogger(sink);
    const soloB = new SwallowLogger(sink);
    soloA.warnOnce(MODULE, 'json($.x)', 'a');
    soloB.warnOnce(MODULE, 'json($.x)', 'b');
    expect(records).toHaveLength(3);
  });

  it('structured lines are JSON with ts/level/msg (machine-parseable)', (): void => {
    const { logger, capture } = createCaptureLogger();
    logger.forModule(MODULE).info('module info line', { jobId: 42 });
    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0] as Record<string, unknown>;
    expect(line['level']).toBe('info');
    expect(line['module']).toBe(MODULE);
    expect(line['jobId']).toBe(42); // numbers stay numbers
    expect(typeof line['ts']).toBe('string');
    expect(line['msg']).toBe('module info line');
    // Raw sink output parses back to the same object.
    expect(JSON.parse(capture.raw[0] as string)).toEqual(line);
    void logger;
  });
});
