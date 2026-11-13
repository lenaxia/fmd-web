import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { makeTStrings } from '../../../src/engine/lua/stubs.js';
import type { WasmoonLuaEngine } from '../../../src/engine/lua/engine.js';
import type { WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { TxQueryShim } from '../../../src/engine/shims/txquery-facade.js';
import { parseQueryDocument } from '../../../src/engine/shims/txquery-shim.js';
import { HttpDocument } from '../../../src/engine/shims/http-shim.js';

/**
 * §5.6 list-fill overloads (LuaXQuery.pas:91-176 over
 * XQueryEngineHTML.pas:369-394 + 520-543): XPathStringAll(expr, list),
 * XPathStringAll(expr, node, list), XPathHREFAll(links, texts[, node]) and
 * XPathHREFTitleAll(links, titles[, node]) MUTATE the TStrings facade —
 * entries appended in evaluation (document) order — and the string forms
 * return the ', '-join of trimmed non-empty values. ParseHTML is the 1-arg
 * instance reparse (LuaXQuery.pas:45-56).
 */

const MODULE_ID = 'a1b2c3d4e5f601020304050607080910';

const CHAPTERS_HTML = [
  '<html><body>',
  '<div class="list">',
  '<a href="/c/1" title="First">Chapter 1 </a>',
  '<a href="/c/2">Chapter 2</a>',
  '<a href="/c/3" title="Third">  Chapter 3  </a>',
  '</div>',
  '<a href="/other">Other</a>',
  '</body></html>',
].join('');

describe('TXQuery list-fill overloads (§5.6 TStrings mutation)', () => {
  let host: WasmoonLuaHost;
  let engine: WasmoonLuaEngine;
  let shim: TxQueryShim;
  let txqId: number;
  let linksId: number;
  let namesId: number;
  let titlesId: number;
  let documents: Map<number, HttpDocument>;

  beforeEach(async () => {
    host = createLuaHost(createMemoryLogger());
    engine = await host.createEngine();
    await host.chunkCache.get('fill.lua', 'FILL_PLACEHOLDER = true');
    await engine.loadModule('fill.lua');
    documents = new Map<number, HttpDocument>();
    shim = new TxQueryShim({
      bridge: engine.debugBridge,
      engine: engine.innerEngine,
      logger: null,
      moduleId: MODULE_ID as never,
      documents,
    });
    // Facade identity marker (install.ts): every facade table carries a
    // rawset `__fmd_id` so shims resolve facade arguments across the bridge
    engine.innerEngine.doStringSync(`
      local real_facade_new = __fmd_facade_new
      function __fmd_facade_new(id, target)
        local t = real_facade_new(id, target)
        if rawget(t, '__fmd_id') == nil then rawset(t, '__fmd_id', id) end
        return t
      end
    `);
    txqId = shim.createTxQuery(parseQueryDocument('html', CHAPTERS_HTML));
    const links = makeTStrings(engine.debugBridge);
    const names = makeTStrings(engine.debugBridge);
    const titles = makeTStrings(engine.debugBridge);
    linksId = engine.debugBridge.create('LINKS', links.spec);
    namesId = engine.debugBridge.create('NAMES', names.spec);
    titlesId = engine.debugBridge.create('TITLES', titles.spec);
    engine.innerEngine.global.set('__fmd_ids', { txq: txqId, links: linksId, names: namesId, titles: titlesId });
    engine.innerEngine.doStringSync(`
      TXQ = __fmd_facades[__fmd_ids.txq]
      LINKS = __fmd_facades[__fmd_ids.links]
      NAMES = __fmd_facades[__fmd_ids.names]
      TITLES = __fmd_facades[__fmd_ids.titles]
    `);
  });

  afterEach(async () => {
    await engine.dispose();
    await host.dispose();
  });

  const run = (code: string): unknown => engine.innerEngine.doStringSync(code);

  it('XPathStringAll(expr, list) fills the TStrings facade in document order (trimmed)', () => {
    run(`TXQ.XPathStringAll('//div[@class="list"]//a', LINKS)`);
    // Trim(v.toString) per item — ALL items (order preserved)
    expect(run(`return LINKS.Count`)).toBe(3);
    expect(run(`return LINKS.Get(0)`)).toBe('Chapter 1');
    expect(run(`return LINKS.Get(1)`)).toBe('Chapter 2');
    expect(run(`return LINKS.Get(2)`)).toBe('Chapter 3');
  });

  it('XPathStringAll(expr, node, list) fills with the IXQValue context', () => {
    run(`
      local info = TXQ.XPath('//div[@class="list"]')
      TXQ.XPathStringAll('a', info, NAMES)
    `);
    expect(run(`return NAMES.Count`)).toBe(3);
    expect(run(`return NAMES.Get(2)`)).toBe('Chapter 3');
    // the string form (expr, node) still ', '-joins trimmed non-empty
    expect(run(`return TXQ.XPathStringAll('a', TXQ.XPath('//div[@class="list"]'))`)).toBe(
      'Chapter 1, Chapter 2, Chapter 3',
    );
  });

  it('XPathStringAll string form skips trim-empty values (AddSeparatorString)', () => {
    // an EMPTY element between the anchors contributes nothing to the join
    run(`TXQ.ParseHTML('<html><body><a href="/1"> </a><a href="/2">Two</a><a href="/3">  Three  </a></body></html>')`);
    const joined = run(`return TXQ.XPathStringAll('//a')`) as string;
    expect(joined).toBe('Two, Three');
    // …while the FILL form still records the trimmed empty entry
    run(`TXQ.XPathStringAll('//a', NAMES)`);
    expect(run(`return NAMES.Count`)).toBe(3);
    expect(run(`return NAMES.Get(0)`)).toBe('');
    expect(run(`return NAMES.Get(1)`)).toBe('Two');
  });

  it('XPathHREFAll(expr, links, texts) fills both lists in lockstep order', () => {
    run(`TXQ.XPathHREFAll('//div[@class="list"]//a', LINKS, NAMES)`);
    expect(run(`return LINKS.Count`)).toBe(3);
    expect(run(`return NAMES.Count`)).toBe(3);
    // href raw, text trimmed (XQueryEngineHTML.pas:520-527)
    expect(run(`return LINKS.Get(0)`)).toBe('/c/1');
    expect(run(`return LINKS.Get(1)`)).toBe('/c/2');
    expect(run(`return LINKS.Get(2)`)).toBe('/c/3');
    expect(run(`return NAMES.Get(0)`)).toBe('Chapter 1');
    expect(run(`return NAMES.Get(2)`)).toBe('Chapter 3');
  });

  it('XPathHREFAll(expr, links, texts, node) with the IXQValue context', () => {
    run(`
      local scope = TXQ.XPath('//div[@class="list"]')
      TXQ.XPathHREFAll('a', LINKS, NAMES, scope)
    `);
    expect(run(`return LINKS.Count`)).toBe(3);
    expect(run(`return LINKS.Get(0)`)).toBe('/c/1');
    // the /other link outside the scope is NOT filled
    expect(run(`return NAMES.Get(2)`)).toBe('Chapter 3');
  });

  it('XPathHREFTitleAll fills titles from the title attribute (raw, untrimmed)', () => {
    run(`TXQ.XPathHREFTitleAll('//div[@class="list"]//a', LINKS, TITLES)`);
    expect(run(`return LINKS.Count`)).toBe(3);
    expect(run(`return TITLES.Count`)).toBe(3);
    expect(run(`return TITLES.Get(0)`)).toBe('First');
    expect(run(`return TITLES.Get(1)`)).toBe(''); // no title attribute
    expect(run(`return TITLES.Get(2)`)).toBe('Third');
  });

  it('XPathHREFTitleAll(expr, links, titles, node) with context', () => {
    run(`
      local scope = TXQ.XPath('//div[@class="list"]')
      TXQ.XPathHREFTitleAll('a', LINKS, TITLES, scope)
    `);
    expect(run(`return LINKS.Count`)).toBe(3);
    expect(run(`return TITLES.Get(0)`)).toBe('First');
    expect(run(`return TITLES.Get(2)`)).toBe('Third');
  });

  it('fill overloads append to EXISTING content without clearing (LuaStrings.Add semantics)', () => {
    run(`LINKS.Add('pre-existing')`);
    run(`TXQ.XPathStringAll('//div[@class="list"]//a', LINKS)`);
    expect(run(`return LINKS.Count`)).toBe(4);
    expect(run(`return LINKS.Get(0)`)).toBe('pre-existing');
    expect(run(`return LINKS.Get(3)`)).toBe('Chapter 3');
  });

  it('ParseHTML is the 1-arg instance reparse (string and HTTP-document forms)', () => {
    run(`
      TXQ.ParseHTML('<html><body><a href="/new">Fresh</a></body></html>')
    `);
    expect(run(`return TXQ.XPathString('//a')`)).toBe('Fresh');
    expect(run(`return TXQ.XPathCount('//a')`)).toBe(1);
    // the old document is gone
    expect(run(`return TXQ.XPathCount('//div[@class="list"]//a')`)).toBe(0);
    // string-returning XPathStringAll over the REPLACED document
    expect(run(`return TXQ.XPathStringAll('//a')`)).toBe('Fresh');
  });

  it('ParseHTML accepts an HTTP Document facade argument (TStream form)', () => {
    // the shim resolves HTTP Document facades through its documents map
    // (install.ts wires the same map for HTTP.Document)
    const httpDoc = new HttpDocument();
    httpDoc.setContent('<html><body><a href="/s">FromStream</a></body></html>');
    const docFacadeId = engine.debugBridge.create('', { get: () => undefined, set: () => undefined });
    documents.set(docFacadeId, httpDoc);
    // CreateTXQuery over an HTTP Document facade (install.ts wiring)
    engine.innerEngine.global.set('__doc_id', docFacadeId);
    engine.innerEngine.global.set('__fmd_new_txquery', (arg?: unknown) => {
      const marker = (arg as Record<string, unknown> | undefined)?.['__fmd_id'];
      const state = typeof marker === 'number' ? documents.get(marker) : undefined;
      return shim.createTxQuery(parseQueryDocument('html', state?.toString() ?? ''));
    });
    engine.innerEngine.doStringSync(
      'function CreateTXQuery(arg) return __fmd_facades[__fmd_new_txquery(arg)] end',
    );
    engine.innerEngine.doStringSync('DOC = __fmd_facades[__doc_id]');
    run('NEWXQ = CreateTXQuery(DOC)');
    expect(run(`return NEWXQ.XPathString('//a')`)).toBe('FromStream');
    // the SAME stream-form through ParseHTML (instance method, 1 arg)
    run(`TXQ.ParseHTML(DOC)`);
    expect(run(`return TXQ.XPathString('//a')`)).toBe('FromStream');
  });
});
