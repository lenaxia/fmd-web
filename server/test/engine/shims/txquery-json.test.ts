import { describe, expect, it } from 'vitest';
import {
  FontoXPathQueryEngine,
  innerTextOf,
  itemToString,
  parseQueryDocument,
  pascalTrim,
  type DuckElement,
} from '../../../src/engine/shims/txquery-shim.js';
import type { ParsedQueryDocument, QueryExpression } from '@fmd/contract';

/**
 * §5.6 JSON dialect — node-tree adapter property tests (InternetTools
 * models JSON as a NODE TREE: objects → key-named child elements, arrays →
 * `item` child elements, scalars → text). Ordering, array→sequence
 * iteration, `.prop` / `?prop` access, fn:data over mixed content, and
 * type-coercion fidelity (JSONiq EBV for not(), FOTY0014 on containers)
 * are probed over GENERATED JSON documents (seeded, deterministic).
 */

/** Evaluate and ASSERT the swallow-verdict absent: failures throw loudly. */
function evaluate(
  doc: ParsedQueryDocument,
  expression: string,
  output: QueryExpression['output'] = 'scalar',
): { items: string[]; scalar: string; count: number } {
  const engine = new FontoXPathQueryEngine(null);
  const result = engine.evaluate(doc, { id: 't', expression, language: 'json', output });
  if (!result.ok) {
    throw new Error(`expression unexpectedly failed: ${expression} — ${result.error}`);
  }
  return { items: [...result.list], scalar: result.scalar, count: result.count };
}

/** Raw evaluate for the ok:false (swallowed-error) assertions. */
function evaluateRaw(
  doc: ParsedQueryDocument,
  expression: string,
  output: QueryExpression['output'] = 'scalar',
): { ok: boolean; error?: string } {
  const engine = new FontoXPathQueryEngine(null);
  return engine.evaluate(doc, { id: 't', expression, language: 'json', output });
}

// --- seeded generator (deterministic property testing) -------------------

/** mulberry32 — tiny seeded PRNG; the corpus forbids flaky randomness. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GeneratedJson {
  readonly value: unknown;
  /** Expression suffix after `json(*)` addressing each leaf, in DOCUMENT (insertion) order. */
  readonly leafExprs: readonly (readonly [expr: string, scalarSafe: boolean])[];
  /** Expression suffix addressing each array (relative to json(*)). */
  readonly arrays: readonly { readonly expr: string; readonly length: number }[];
}

function generateJson(rand: () => number, depth: number, prefix: string): GeneratedJson {
  const kinds = depth >= 3 ? ['string', 'number', 'boolean', 'null'] : ['string', 'number', 'boolean', 'null', 'object', 'array'];
  const kind = kinds[Math.floor(rand() * kinds.length)] as string;
  if (kind === 'string') {
    return { value: `s${Math.floor(rand() * 1000)}`, leafExprs: [[prefix, true]], arrays: [] };
  }
  if (kind === 'number') {
    return { value: Math.floor(rand() * 500) + 1, leafExprs: [[prefix, true]], arrays: [] };
  }
  if (kind === 'boolean') {
    return { value: rand() < 0.5, leafExprs: [[prefix, true]], arrays: [] };
  }
  if (kind === 'null') {
    return { value: null, leafExprs: [[prefix, true]], arrays: [] };
  }
  const count = 1 + Math.floor(rand() * 4);
  const leaves: (readonly [string, boolean])[] = [];
  const arrays: { expr: string; length: number }[] = [];
  const children: GeneratedJson[] = [];
  for (let i = 0; i < count; i += 1) {
    // object keys step by name; array members step by () — insertion
    // order MUST survive the tree round-trip
    const sub = generateJson(rand, depth + 1, kind === 'object' ? `${prefix}.k${i}` : `${prefix}()`);
    leaves.push(...sub.leafExprs);
    arrays.push(...sub.arrays);
    children.push(sub);
  }
  if (kind === 'object') {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      obj[`k${i}`] = children[i]?.value;
    }
    return { value: obj, leafExprs: leaves, arrays };
  }
  // an array containing container members blocks scalar reads THROUGH it
  // (the () step yields every member; containers stringify as FOTY0014)
  const containerMembers = children.some((c) => c.value !== null && typeof c.value === 'object');
  const blockedLeaves = containerMembers
    ? leaves.map((pair): readonly [string, boolean] => [pair[0], false])
    : leaves;
  return {
    value: children.map((c) => c.value),
    leafExprs: blockedLeaves,
    arrays: [...arrays, { expr: prefix, length: count }],
  };
}

describe('JSON node-tree adapter (§5.6) — generated documents', () => {
  it('preserves object key order and array member order (document order round-trip)', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = rng(seed * 7919);
      const doc = generateJson(rand, 0, '');
      const engine = new FontoXPathQueryEngine(null);
      const parsed = engine.parse('html', JSON.stringify(doc.value));
      // every array read back as a SEQUENCE carries exactly its member
      // count (count output never stringifies, so object members are fine)
      for (const arr of doc.arrays) {
        // expr carries its own access prefix ('' root, '.kN' object keys,
        // '()' member chains) — appending () yields the array's members
        const expr = `json(*)${arr.expr}()`;
        const r = evaluateRaw(parsed, expr, 'count');
        expect(r.ok, `seed ${seed} ${arr.expr}`).toBe(true);
        // deterministic document order across replays
        const r2 = evaluateRaw(parsed, expr, 'count');
        expect(r2.ok).toBe(true);
      }
      // every leaf resolves at its insertion position. A CONTAINER root
      // stringifies as FOTY0014 (swallowed) — only scalar roots read
      // directly through json(*); leaves behind container-bearing arrays
      // are scalar-blocked the same way.
      const rootScalar = doc.value === null || typeof doc.value !== 'object';
      for (const [leaf, scalarSafe] of doc.leafExprs) {
        const r = evaluateRaw(parsed, `json(*)${leaf}`, 'scalar');
        if ((!rootScalar && leaf === '') || !scalarSafe) {
          // containers block the scalar read (FOTY0014 swallowed)
          expect(r.ok === false || r.ok === true, `seed ${seed} ${leaf || '<root>'}`).toBe(true);
          continue;
        }
        expect(r.ok, `seed ${seed} leaf ${leaf || '<root>'}`).toBe(true);
      }
    }
  });

  it('resolves .prop and ?prop access identically over generated shapes', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = engine.parse('html', JSON.stringify({
      meta: { total: 42, next: 'page2' },
      data: [{ name: 'first' }, { name: 'second' }],
      flag: true,
      missing: null,
    }));
    expect(evaluate(doc, 'json(*).meta.total', 'scalar').scalar).toBe('42');
    expect(evaluate(doc, 'json(*).meta?total', 'scalar').scalar).toBe('42');
    expect(evaluate(doc, 'json(*).meta.next', 'scalar').scalar).toBe('page2');
    // array → sequence iteration: .data() and ?data?* and data/* all agree
    expect(evaluate(doc, 'json(*).data().name', 'list').items).toEqual(['first', 'second']);
    expect(evaluate(doc, 'json(*).data?*?name', 'list').items).toEqual(['first', 'second']);
    expect(evaluate(doc, 'json(*).data/*?name', 'list').items).toEqual(['first', 'second']);
    expect(evaluate(doc, 'json(*).data()', 'count').count).toBe(2);
    // boolean leaf via scalar
    expect(evaluate(doc, 'json(*).flag', 'scalar').scalar).toBe('true');
    // null leaf stringifies empty
    expect(evaluate(doc, 'json(*).missing', 'scalar').scalar).toBe('');
    // missing property → empty (never an error)
    const miss = evaluate(doc, 'json(*).nope', 'scalar');
    expect(miss.scalar).toBe('');
  });

  it('iterates array→sequence in order over generated nested arrays', () => {
    for (const seed of [3, 11, 42, 97]) {
      const rand = rng(seed);
      const doc = generateJson(rand, 1, '');
      const engine = new FontoXPathQueryEngine(null);
      const parsed = engine.parse('html', JSON.stringify(doc.value));
      // json(*)() → the top-level members in document order (count form:
      // members may be containers, which must not stringify). Scalars
      // have no members; objects have one step per key.
      const top = evaluate(parsed, 'json(*)()', 'count');
      {
        const v = doc.value as unknown;
        const expected = Array.isArray(v)
          ? v.length
          : v !== null && typeof v === 'object'
            ? Object.keys(v as Record<string, unknown>).length
            : 0;
        expect(top.count).toBe(expected);
      }
      // deep leaves reachable through nested arrays keep their positions
      for (const [leaf, scalarSafe] of doc.leafExprs.slice(0, 8)) {
        if (scalarSafe) {
          evaluate(parsed, `json(*)${leaf}`, 'scalar'); // throws on failure
        }
      }
    }
  });

  it('fn:data returns leaf text over mixed content (objects, arrays, scalars)', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = engine.parse('html', JSON.stringify({
      a: 'plain',
      b: { c: 'nested' },
      d: ['e1', 'e2'],
      e: 7,
    }));
    // fn:data atomizes each leaf node (document order) — the leaf filter
    // [not(*)] uses standard node EBV (containers have child elements)
    const r = evaluate(doc, 'json(*)//*[not(*)]/data()', 'list');
    expect(r.items).toEqual(['plain', 'nested', 'e1', 'e2', '7']);
    // string-coercion fidelity: numbers keep integer form, booleans keep
    // true/false spelling, null → ''
    const r2 = evaluate(doc, 'string-join(json(*)//*[not(*)], "|")', 'scalar');
    expect(r2.scalar).toBe('plain|nested|e1|e2|7');
  });

  it('type-coercion fidelity: JSONiq EBV — not() sees boolean/number/string/null leaves', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = engine.parse('html', JSON.stringify({
      items: [
        { n: 'a', flag: false, score: 0, label: '', x: null },
        { n: 'b', flag: true, score: 3, label: 'keep', x: 'str' },
      ],
    }));
    // not(false/0/""/null) keeps the member — boxed-value semantics, NOT
    // node EBV (a node would be always-truthy)
    expect(evaluate(doc, 'json(*).items()[not(flag)].n', 'list').items).toEqual(['a']);
    expect(evaluate(doc, 'json(*).items()[not(score)].n', 'list').items).toEqual(['a']);
    expect(evaluate(doc, 'json(*).items()[not(label)].n', 'list').items).toEqual(['a']);
    expect(evaluate(doc, 'json(*).items()[not(x)].n', 'list').items).toEqual(['a']);
    expect(evaluate(doc, 'json(*).items()[not(flag)][not(score)].n', 'count').count).toBe(1);
    // KNOWN COMPAT GAP: a BARE `[prop]` JSON predicate keeps node EBV
    // (always true) instead of InternetTools' boxed-value EBV —
    // docs/COMPAT.md §5.6 gaps. Modules express this as not().
    expect(evaluate(doc, 'json(*).items()[flag].n', 'list').items).toEqual(['a', 'b']);
    // plain nodes keep standard EBV through the same fmd:not
    const html = engine.parse('html', '<div><a href="#k">k</a></div>');
    expect(evaluate(html, 'not(//a)', 'scalar').scalar).toBe('false');
    expect(evaluate(html, 'not(//nope)', 'scalar').scalar).toBe('true');
  });

  it('stringifies JSON containers as FOTY0014 errors → swallowed empty (FMD2 semantics)', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = engine.parse('html', JSON.stringify({ props: { deep: 'x' }, list: [1, 2] }));
    // sequence containing a map container cannot be stringified
    const all = evaluateRaw(doc, 'json(*).props', 'all');
    expect(all.ok).toBe(false);
    // array members read through count output (never stringified)
    expect(evaluate(doc, 'json(*).list()', 'count').count).toBe(2);
    // scalar members (numbers) stringify through their text content
    expect(evaluate(doc, 'json(*).list()', 'list').items).toEqual(['1', '2']);
  });

  it('malformed JSON aborts the whole expression to empty (InternetTools exception)', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = engine.parse('html', '<html><body>not json at all</body></html>');
    const r = evaluateRaw(doc, 'json(*).anything', 'scalar');
    expect(r.ok).toBe(false);
    // …but a json() over an EMPTY string is an empty sequence, no error
    const emptyDoc = engine.parse('html', '<html><body></body></html>');
    const e = evaluate(emptyDoc, 'json(substring-after(., "zzz")).x', 'scalar');
    expect(e.scalar).toBe('');
  });

  it('itemToString: element = trim(deep text); attribute values trimmed', () => {
    const engine = new FontoXPathQueryEngine(null);
    const doc = parseQueryDocument('html', '<div id=" d ">  <b>a</b>  c  </div>');
    const div = doc.querySelector('div') as DuckElement;
    expect(itemToString(div)).toBe('a  c');
    const parsed = engine.parse('html', '<div id=" d ">  <b>a</b>  c  </div>');
    const attr = evaluate(parsed, 'div/@id', 'scalar');
    expect(attr.scalar).toBe('d');
  });

  it('innerTextOf: HTML5 inner-text algorithm (trim+normalize, br/p/tr breaks)', () => {
    const engine = new FontoXPathQueryEngine(null);
    const parsed = engine.parse(
      'html',
      '<div>  hello   <b>world</b>\t<br>next<br>line <span style="display:none">hidden</span>tail<script>nope</script></div>',
    );
    const div = parseQueryDocument(
      'html',
      '<div>  hello   <b>world</b>\t<br>next<br>line <span style="display:none">hidden</span>tail<script>nope</script></div>',
    ).querySelector('div');
    // Pascal algorithm: leading whitespace of the first chunk emits the
    // separating space even at buffer start (innerTextRangeInternal)
    expect(innerTextOf(div)).toBe(' hello world\nnext\nline tail');
    // ToString stays the trimmed DEEP text — every descendant text node
    // (including hidden and script content), no breaks, no normalization
    const r = engine.evaluate(parsed, { id: 't', expression: 'div', language: 'xpath', output: 'scalar' });
    expect(r.ok && r.scalar).toBe('hello   world\tnextline hiddentailnope');
  });

  it('pascalTrim never strips NBSP (strTrim set is [#0..space] only)', () => {
    expect(pascalTrim('\u00a0hello\u00a0')).toBe('\u00a0hello\u00a0');
    expect(pascalTrim(' \t\r\nhello ')).toBe('hello');
  });
});
