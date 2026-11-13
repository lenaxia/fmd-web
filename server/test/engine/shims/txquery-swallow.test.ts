import { describe, expect, it } from 'vitest';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger, type MemoryLogger } from '../../../src/engine/lua/logger.js';
import { TxQueryShim } from '../../../src/engine/shims/txquery-facade.js';
import {
  FontoXPathQueryEngine,
  parseQueryDocument,
} from '../../../src/engine/shims/txquery-shim.js';
import type { ModuleId } from '@fmd/contract';

/**
 * §5.6 error swallowing (XQueryEngineHTML.pas:358-399 Eval try/except):
 * every evaluation failure → empty result (ok:false / empty sequences),
 * a WARN log carrying the module id + expression, and rate-limited
 * dedup — max ONE warn per (module, expression) per run.
 */

const MODULE_A = '11111111111111111111111111111111' as ModuleId;

describe('TXQuery error swallowing (§5.6)', () => {
  it('malformed expression → empty result + WARN with the expression', () => {
    const logger: MemoryLogger = createMemoryLogger();
    const engine = new FontoXPathQueryEngine(logger);
    const doc = engine.parse('html', '<html><body><p>ok</p></body></html>');

    const r = engine.evaluate(doc, { id: 'x', expression: 'div[', language: 'xpath', output: 'scalar' });
    expect(r.ok).toBe(false);

    const warns = logger.records.filter((rec) => rec.level === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0]?.level).toBe('warn');
    expect(warns[0]?.message).toContain('div[');
    expect(warns[0]?.message).toContain('TXQuery>');
  });

  it('swallowed evaluation errors behave as FMD2 empty results per output shape', () => {
    const logger = createMemoryLogger();
    const engine = new FontoXPathQueryEngine(logger);
    const doc = engine.parse('html', '<html><body><a href="/x">t</a></body></html>');
    // all four output shapes carry the FMD2 swallow verdict (ok:false)
    for (const output of ['scalar', 'list', 'count', 'all'] as const) {
      const r = engine.evaluate(doc, { id: output, expression: 'a[[', language: 'xpath', output });
      expect(r.ok, output).toBe(false);
    }
    // one WARN per (module, expression) — all four share the expression key
    const warns = logger.records.filter((rec) => rec.level === 'warn');
    expect(warns.length).toBe(1);
  });

  it('warn dedupe keys on the expression: a different expression warns again', () => {
    const logger = createMemoryLogger();
    const engine = new FontoXPathQueryEngine(logger);
    const doc = engine.parse('html', '<html/>');
    engine.evaluate(doc, { id: '1', expression: 'a[[', language: 'xpath', output: 'scalar' });
    engine.evaluate(doc, { id: '2', expression: 'a[[', language: 'xpath', output: 'scalar' });
    engine.evaluate(doc, { id: '3', expression: 'b[[', language: 'xpath', output: 'scalar' });
    engine.evaluate(doc, { id: '4', expression: 'a[[', language: 'xpath', output: 'list' });
    // 'a[[' warned once (two failures), 'b[[' warned once
    const warns = logger.records.filter((rec) => rec.level === 'warn');
    expect(warns.length).toBe(2);
    expect(warns.map((w) => w.message)).toEqual([
      expect.stringContaining('a[['),
      expect.stringContaining('b[['),
    ]);
  });

  it('shim swallow path: WARN carries the module id and is deduplicated per run', async () => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const engine = await host.createEngine();
    await host.chunkCache.get('a.lua', 'A = 1');
    await engine.loadModule('a.lua');
    const shim = new TxQueryShim({
      bridge: engine.debugBridge,
      engine: engine.innerEngine,
      logger,
      moduleId: MODULE_A,
    });
    const txqId = shim.createTxQuery(parseQueryDocument('html', '<html/>'));
    engine.innerEngine.global.set('__txq_id', txqId);
    engine.innerEngine.doStringSync('TXQ = __fmd_facades[__txq_id]');
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);

    // malformed expression → empty string, never a Lua error
    expect(run(`return TXQ.XPathString('div[[[')`)).toBe('');
    expect(run(`return TXQ.XPathStringAll('div[[[')`)).toBe('');
    expect(run(`return TXQ.XPathCount('div[[[')`)).toBe(0);

    const warns = logger.records.filter((rec) => rec.level === 'warn');
    expect(warns.length).toBe(1); // deduplicated per (module, expression)
    expect(warns[0]?.moduleId).toBe(MODULE_A);
    expect(warns[0]?.message).toContain('div[[[');

    // a DIFFERENT malformed expression warns again; the first stays silent
    expect(run(`return TXQ.XPathString('a[[')`)).toBe('');
    expect(logger.records.filter((rec) => rec.level === 'warn').length).toBe(2);
    expect(run(`return TXQ.XPathString('div[[[')`)).toBe('');
    expect(logger.records.filter((rec) => rec.level === 'warn').length).toBe(2);

    await engine.dispose();
    await host.dispose();
  });

  it('parse-time divergence hardening: bare JSON payload scaffolds and preserves text', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = engine.parse('json', '{"series":{"title":"T"}}');
    const r = engine.evaluate(doc, { id: 't', expression: 'json(*).series.title', language: 'json', output: 'scalar' });
    expect(r.ok && r.scalar).toBe('T');
  });
});
