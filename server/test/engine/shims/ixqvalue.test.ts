import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import type { WasmoonLuaEngine } from '../../../src/engine/lua/engine.js';
import type { WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { TxQueryShim } from '../../../src/engine/shims/txquery-facade.js';

/**
 * IXQValue facade unit tests (§5.6, LuaIXQValue.pas:135-149 + contract.json
 * facades[IXQValue]): Get (iterator + 1-based index), GetProperty (JSON
 * node-tree children), GetAttribute (elements), ToString (inner text, NOT
 * outerHTML), InnerHTML/OuterHTML, Count. The facade is the TxQueryShim's
 * `createIxq` — driven from real Lua through the facade bridge.
 */

const MODULE_ID = '0123456789abcdef0123456789abcdef';

describe('IXQValue facade (LuaIXQValue.pas:135-149)', () => {
  let host: WasmoonLuaHost;
  let engine: WasmoonLuaEngine;
  let shim: TxQueryShim;

  beforeEach(async () => {
    host = createLuaHost(createMemoryLogger());
    engine = await host.createEngine();
    await host.chunkCache.get('ixq.lua', 'IXQ_PLACEHOLDER = true');
    await engine.loadModule('ixq.lua');
    shim = new TxQueryShim({
      bridge: engine.debugBridge,
      engine: engine.innerEngine,
      logger: null,
      moduleId: MODULE_ID as never,
    });
    // Wire the real CreateTXQuery global exactly like install.ts does
    // (§5.6 constructor: HTTP Document facade | HTML string | none).
    const { parseQueryDocument } = await import('../../../src/engine/shims/txquery-shim.js');
    engine.innerEngine.global.set('__fmd_new_txquery', (arg?: unknown) => {
      const doc =
        typeof arg === 'string'
          ? parseQueryDocument('html', arg)
          : parseQueryDocument('html', '');
      return shim.createTxQuery(doc);
    });
    engine.innerEngine.doStringSync(
      // resolve-if-exists: createTxQuery materializes + rawsets the slot
      // BEFORE facade_new would; re-running facade_new unconditionally
      // would overwrite the table and lose the slot.
      `function CreateTXQuery(_document_or_html)
         local id = __fmd_new_txquery(_document_or_html)
         local t = __fmd_facades[id]
         if t ~= nil and rawget(t, 'XPath') ~= nil then return t end
         return __fmd_facade_new(id, '')
       end`,
    );
  });

  afterEach(async () => {
    await engine.dispose();
    await host.dispose();
  });

  function bind(name: string, items: readonly unknown[]): void {
    const id = shim.createIxq(items);
    engine.innerEngine.doStringSync(`${name} = __fmd_facades[${id}]`);
  }

  function multiNodeItems(): unknown[] {
    const { document } = parseHTML(
      '<div id="root"><a href="/c/1">Chapter 1</a><a href="/c/2">Chapter 2</a><span>Tail</span></div>',
    );
    const root = document.querySelector('div');
    const children: unknown[] = Array.from(root?.children ?? []);
    expect(children.length).toBe(3);
    return children;
  }

  it('Get() over multi-node results iterates every node then stops (nil at end)', () => {
    bind('X', multiNodeItems());
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    const collected = run(`
      local out = {}
      local n = 0
      for v in X:Get() do
        n = n + 1
        out[n] = v.ToString()
      end
      return table.concat(out, '|') .. '#' .. n
    `);
    expect(collected).toBe('Chapter 1|Chapter 2|Tail#3');
    // the iterator keeps returning nil after exhaustion (Lua loop protocol)
    expect(
      run(`
      local it = X:Get()
      for _ in it do end
      return it()
    `),
    ).toBeNull();
  });

  it('Get(i) is 1-based and returns nil past the end (LuaIXQValue get(i))', () => {
    bind('X', multiNodeItems());
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return X.Get(1).ToString()`)).toBe('Chapter 1');
    expect(run(`return X.Get(2).ToString()`)).toBe('Chapter 2');
    expect(run(`return X.Get(3).ToString()`)).toBe('Tail');
    expect(run(`return X:Get(4)`)).toBeNull();
    // Get(0)/negative → nil (internettools get() is 1-based; 0 is out of range)
    expect(run(`return X:Get(0)`)).toBeNull();
  });

  it('Count is read-only and exact', () => {
    bind('X', multiNodeItems());
    bind('E', []);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return X.Count`)).toBe(3);
    expect(run(`return E.Count`)).toBe(0);
  });

  it('GetAttribute reads element attributes; missing attribute reads ""', () => {
    bind('X', multiNodeItems());
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return X.Get(1).GetAttribute('href')`)).toBe('/c/1');
    expect(run(`return X.Get(2).GetAttribute('href')`)).toBe('/c/2');
    expect(run(`return X.Get(3).GetAttribute('href')`)).toBe(''); // span has none
    expect(run(`return X.Get(1).GetAttribute('data-x')`)).toBe('');
  });

  it('ToString is the inner TEXT for elements (NOT outerHTML) and identity for strings', () => {
    const { document } = parseHTML('<div><b>Bold</b> and <i>ital</i></div>');
    const div = document.querySelector('div');
    bind('X', [div]);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    // contract row: "element => inner text (NOT outerHTML)"
    expect(run(`return X.ToString()`)).toBe('Bold and ital');
    bind('S', ['plain string']);
    expect(run(`return S.ToString()`)).toBe('plain string');
    bind('E', []);
    expect(run(`return E.ToString()`)).toBe('');
  });

  it('InnerHTML/OuterHTML expose the node HTML forms', () => {
    const { document } = parseHTML('<div><b>Bold</b></div>');
    const div = document.querySelector('div');
    bind('X', [div]);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return X.InnerHTML()`)).toBe('<b>Bold</b>');
    expect(run(`return X.OuterHTML()`)).toBe('<div><b>Bold</b></div>');
  });

  it('GetProperty resolves JSON node-tree children (fmd:json shape) and nests', () => {
    // The §5.6 JSON dialect models JSON as a node tree: objects → key-named
    // child elements, arrays → `item` children, scalars → text content.
    const { document } = parseHTML('<json-root/>');
    const root = document.querySelector('json-root') as unknown as {
      appendChild(el: unknown): unknown;
    };
    const el = (tag: string, text?: string): unknown => {
      const node = document.createElement(tag);
      if (text !== undefined) {
        (node as unknown as { textContent: string }).textContent = text;
      }
      return node;
    };
    const manga = el('manga');
    (manga as { appendChild(el: unknown): unknown }).appendChild(el('title', 'T Title'));
    (manga as { appendChild(el: unknown): unknown }).appendChild(el('lang', 'en'));
    const chapters = el('chapters');
    (chapters as { appendChild(el: unknown): unknown }).appendChild(el('item', '1'));
    (chapters as { appendChild(el: unknown): unknown }).appendChild(el('item', '2'));
    (manga as { appendChild(el: unknown): unknown }).appendChild(chapters);
    root.appendChild(manga);

    bind('X', [root]);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    // dot syntax: FMD2 modules call facade methods with DOT calls
    // (LuaClass.pas:94-169 — colon calls shift args, modules never use them)
    expect(run(`return X.GetProperty('manga').GetProperty('title').ToString()`)).toBe('T Title');
    expect(run(`return X.GetProperty('manga').GetProperty('lang').ToString()`)).toBe('en');
    expect(run(`return X.GetProperty('manga').GetProperty('chapters').Count`)).toBe(1);
    expect(run(`return X.GetProperty('manga').GetProperty('chapters').ToString()`)).toBe('12');
  });

  it('GetProperty on a missing property returns an EMPTY facade, never nil (FMD2 xqvalue())', () => {
    bind('X', multiNodeItems());
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`local m = X.GetProperty('nope') return m ~= nil and m.Count == 0`)).toBe(true);
    expect(run(`return X.GetProperty('nope'):ToString()`)).toBe('');
    // nested miss is also empty-safe
    expect(run(`return X.GetProperty('nope'):GetProperty('deeper'):GetAttribute('x')`)).toBe('');
  });

  it('XPath results flow through the same facade (multi-node XPath → Get iterator)', () => {
    // CreateTXQuery(html):XPath(expr) — the full §5.6 path, asserting the
    // IXQValue facade is the SAME object shape the corpus modules consume.
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    const html = '<html><body><a href="/1">A</a><a href="/2">B</a></body></html>';
    const result = run(`
      local x = CreateTXQuery('${html}')
      local links = x.XPath('//a')
      local out = {}
      for v in links.Get() do
        out[#out + 1] = v.GetAttribute('href') .. '=' .. v.ToString()
      end
      return links.Count .. '#' .. table.concat(out, '|')
    `);
    expect(result).toBe('2#/1=A|/2=B');
  });
});
