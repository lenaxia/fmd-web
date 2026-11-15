import type {
  HostLogger,
  ModuleId,
  ParsedQueryDocument,
  QueryDocumentKind,
  QueryEngine,
  QueryEngineResult,
  QueryExpression,
} from '@fmd/contract';
import { parseHTML } from 'linkedom';
import fontoxpath from 'fontoxpath';
const { evaluateXPath, registerCustomXPathFunction } = fontoxpath;
import { transformExpression } from './query-dialect.js';

/**
 * TXQuery shim (DESIGN.md §5.6): FontoXPath over linkedom behind the
 * InternetTools dialect transform (`query-dialect.ts`). Registers the
 * `fmd:json` / `fmd:parse-json` node-tree adapters, `fmd:css`, and the
 * FMD2-string forms `fmd:not` / `fmd:string` / `fmd:string-join`, and
 * swallows evaluation errors to empty results with rate-limited WARN
 * logging (XQueryEngineHTML.pas:358-399).
 */

export const FMD_NS = 'https://fmd-web.dev/ns';
export const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** Minimal structural types for the linkedom documents we pass around. */
export interface DuckElement {
  readonly nodeName: string;
  readonly localName: string;
  textContent: string;
  readonly innerHTML: string;
  readonly outerHTML: string;
  getAttribute(name: string): string | null;
  appendChild(child: DuckElement): DuckElement;
  querySelectorAll(selectors: string): Iterable<DuckElement>;
}

export interface DuckNode {
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null;
  readonly textContent: string;
  getAttribute?(name: string): string | null;
}

export interface DuckDocument {
  createElement(tag: string): DuckElement;
  readonly documentElement: DuckElement | null;
  querySelector(selectors: string): DuckElement | null;
  querySelectorAll(selectors: string): Iterable<DuckElement>;
}

/** Namespace resolver: `fmd` → the shim namespace, default → XHTML. */
export function fmdNamespaceResolver(prefix: string | null): string | null {
  if (prefix === 'fmd') {
    return FMD_NS;
  }
  if (prefix === null || prefix === '') {
    return XHTML_NS;
  }
  return null;
}

// ---------------------------------------------------------------------------
// linkedom lowercasing — FMD2's repairing HTML parser matches element names
// case-insensitively and the corpus expressions are lowercase; linkedom
// uppercases HTML tag names. Patch the shared Element prototype once.
// ---------------------------------------------------------------------------

let linkedomPatched = false;
export function ensureLinkedomLowercase(): void {
  if (linkedomPatched) {
    return;
  }
  linkedomPatched = true;
  const { Element } = parseHTML('<html/>');
  const proto: unknown = Element.prototype;
  for (const prop of ['nodeName', 'localName', 'tagName'] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc?.get !== undefined) {
      const get = desc.get;
      Object.defineProperty(proto, prop, {
        ...desc,
        get(this: unknown): string {
          return get.call(this).toLowerCase();
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pascal string semantics (bbutils.pas strTrim / strNormalizeLineEndings)
// ---------------------------------------------------------------------------

/**
 * Pascal `strTrim` default set — chars in [#0..' '] (C0 controls + space).
 * Unlike JS `String.trim` this never strips unicode whitespace such as
 * NBSP (U+00A0), matching InternetTools exactly.
 */
export function pascalTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && s.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** strTrimAndNormalize: trim [#0..' '] then collapse runs to single spaces. */
function pascalTrimAndNormalize(s: string): string {
  // eslint-disable-next-line no-control-regex -- C0 controls are exactly the Trim set (uBaseUnit)
  return pascalTrim(s).replace(/[\u0000-\u0020]+/gu, ' ');
}

// ---------------------------------------------------------------------------
// JSON node-tree adapter (§5.6 JSON dialect): objects → key-named child
// elements (`fmd-kind="map"`), arrays → `item` child elements
// (`fmd-kind="array"`), scalars → typed leaf elements carrying text content.
// The kind markers drive JSONiq effective-boolean-value semantics
// (`fmd:not`) and the FOTY0014 container-stringification error.
// ---------------------------------------------------------------------------

type JsonKind = 'map' | 'array' | 'string' | 'number' | 'boolean' | 'null';

const jsonKinds = new WeakMap<object, JsonKind>();

function jsonKindOf(node: unknown): JsonKind | undefined {
  if (node !== null && typeof node === 'object') {
    return jsonKinds.get(node as object);
  }
  return undefined;
}

function jsonToNode(value: unknown, doc: DuckDocument, tag: string, kind: JsonKind): DuckElement {
  const el = doc.createElement(tag);
  jsonKinds.set(el, kind);
  if (kind === 'array') {
    for (const item of value as readonly unknown[]) {
      el.appendChild(jsonToNode(item, doc, 'item', jsonKindOfValue(item)));
    }
    return el;
  }
  if (kind === 'map') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      el.appendChild(jsonToNode(v, doc, k, jsonKindOfValue(v)));
    }
    return el;
  }
  el.textContent = value === null || value === undefined ? '' : String(value);
  return el;
}

function jsonKindOfValue(value: unknown): JsonKind {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value !== null && typeof value === 'object') {
    return 'map';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  return 'string';
}

/** Parse the joined string → node tree; throws on malformed JSON. */
function parseJsonOf(items: readonly unknown[]): unknown[] {
  if (items.length === 0) {
    return [];
  }
  let raw = '';
  try {
    raw = items.map((item) => fmdItemString(item)).join('');
  } catch {
    return []; // FOTY0014 stringification error → json() yields empty
  }
  if (raw.trim() === '') {
    // empty input parses to an EMPTY sequence, no error
    // (fastjsonreader: tkEOF with jpoLiberal → no data, no raise)
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // EXQEvaluationException propagates OUT of json() — FMD2's Eval
    // try/except then aborts the WHOLE expression to empty
    throw new Error(
      `pxp:JSON JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return [parsed];
}

function asSeq(seq: unknown): readonly unknown[] {
  return Array.isArray(seq) ? seq : [seq];
}

function ownerDocOf(first: unknown, fallback: DuckDocument): DuckDocument {
  if (first !== null && typeof first === 'object') {
    const node = first as DuckNode & { ownerDocument?: DuckDocument | null };
    if (node.nodeType === 9) {
      return node as unknown as DuckDocument;
    }
    if (node.ownerDocument !== null && node.ownerDocument !== undefined) {
      return node.ownerDocument;
    }
  }
  return fallback;
}

let functionsRegistered = false;
/** Register the fmd:* custom XPath functions (idempotent, module-level). */
export function registerFmdFunctions(): void {
  if (functionsRegistered) {
    return;
  }
  functionsRegistered = true;
  const fallbackDoc = parseHTML('<html/>').document as unknown as DuckDocument;

  const jsonAdapter = (_dc: unknown, seq: unknown): unknown[] => {
    const items = asSeq(seq);
    const parsed = parseJsonOf(items);
    if (parsed.length === 0) {
      return [];
    }
    const node = jsonToNode(parsed[0], ownerDocOf(items[0], fallbackDoc), 'json-root', jsonKindOfValue(parsed[0]));
    return [node];
  };
  registerCustomXPathFunction({ namespaceURI: FMD_NS, localName: 'json' }, ['item()*'], 'item()*', jsonAdapter);
  registerCustomXPathFunction({ namespaceURI: FMD_NS, localName: 'parse-json' }, ['item()*'], 'item()*', jsonAdapter);
  registerCustomXPathFunction({ namespaceURI: FMD_NS, localName: 'css' }, ['xs:string'], 'node()*', (dc: unknown, selector: string) => {
    const carrier = dc as { currentContext?: { currentContext?: unknown } } | undefined;
    const root = carrier?.currentContext?.currentContext;
    if (root === undefined || root === null) {
      return [];
    }
    const doc = root as DuckDocument;
    const scope = doc.documentElement ?? doc;
    try {
      return [...scope.querySelectorAll(selector)];
    } catch {
      return [];
    }
  });
  // fn:not with JSONiq effective-boolean-value semantics over the JSON
  // node tree (InternetTools boxed booleans/numbers/strings/null).
  registerCustomXPathFunction({ namespaceURI: FMD_NS, localName: 'not' }, ['item()*'], 'xs:boolean', (_dc: unknown, seq: unknown) => !jsonEbv(asSeq(seq)));
  // fn:string / fn:string-join with FMD2 node→string semantics
  // (XQueryGlobalTrimNodes: every node stringification is trimmed —
  // xquery.pas:5291).
  registerCustomXPathFunction({ namespaceURI: FMD_NS, localName: 'string' }, ['item()*'], 'xs:string', (_dc: unknown, seq: unknown) => {
    const items = asSeq(seq);
    return items.length === 0 ? '' : items.map(fmdItemString).join('');
  });
  registerCustomXPathFunction({ namespaceURI: FMD_NS, localName: 'string-join' }, ['item()*', 'xs:string'], 'xs:string', (_dc: unknown, seq: unknown, sep: string) => asSeq(seq).map(fmdItemString).join(String(sep ?? '')));
}

/**
 * JSONiq effective boolean value over the node tree (xquery_types.inc
 * toBooleanEffective): empty → false; JSON boolean/number/string/null
 * leaves follow their boxed value; nodes, maps and arrays → true;
 * atomics follow XPath rules.
 */
export function jsonEbv(items: readonly unknown[]): boolean {
  if (items.length === 0) {
    return false;
  }
  const first = items[0];
  if (typeof first === 'boolean') {
    return first;
  }
  if (typeof first === 'number') {
    return !Number.isNaN(first) && first !== 0;
  }
  if (typeof first === 'string') {
    return first !== '';
  }
  if (first === null || first === undefined) {
    return false;
  }
  if (typeof first === 'object') {
    const node = first as DuckNode;
    if (node.nodeType === 1) {
      const kind = jsonKindOf(node);
      const text = pascalTrim(node.textContent ?? '');
      if (kind === 'boolean') {
        return text === 'true';
      }
      if (kind === 'number') {
        const d = Number(text);
        return !Number.isNaN(d) && d !== 0;
      }
      if (kind === 'string') {
        return text !== '';
      }
      if (kind === 'null') {
        return false;
      }
    }
    return true;
  }
  return true;
}

/**
 * FMD2 item stringification (xquery.pas:5281 treeElementAsString +
 * XQGlobalTrimNodes): atomics verbatim; every NODE stringification is
 * trimmed as a whole (deep text for elements/documents). JSON map/array
 * containers raise FOTY0014 — objects cannot be used as strings
 * (xquery_types.inc pvkObject toString).
 */
export function itemToString(item: unknown): string {
  if (typeof item === 'string') {
    return item;
  }
  if (typeof item === 'number' || typeof item === 'boolean') {
    return String(item);
  }
  if (item === null || item === undefined) {
    return '';
  }
  return fmdItemString(item);
}

/** Node-only stringification with FMD2 trim semantics. */
export function fmdItemString(item: unknown): string {
  // atomic items first (upper-case(...) || ... feed string-join directly)
  if (typeof item === 'string') {
    return item;
  }
  if (typeof item === 'number' || typeof item === 'boolean') {
    return String(item);
  }
  const node = item as DuckNode & { value?: string | null };
  switch (node.nodeType) {
    case 1: {
      const kind = jsonKindOf(node);
      if (kind === 'map' || kind === 'array') {
        throw new Error('FOTY0014: object cannot be used as string');
      }
      return pascalTrim(node.textContent ?? '');
    }
    case 2:
      return pascalTrim(node.value ?? node.nodeValue ?? '');
    case 9: {
      const doc = node as unknown as { documentElement?: DuckNode | null };
      return pascalTrim(doc.documentElement?.textContent ?? '');
    }
    default:
      return pascalTrim(node.nodeValue ?? node.textContent ?? '');
  }
}

// ---------------------------------------------------------------------------
// Parsed documents + corpus QueryEngine (§13.1 live engine)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// linkedom tree repair — parser-divergence preprocessing. The corpus proves
// two divergences of linkedom's parser vs InternetTools' repairing parser
// (simplehtmltreeparser): (1) CRLF/CR are normalized to LF at tokenizer
// level in both text and attributes (dhefNormalizeLineEndings), (2) adjacent
// text nodes are merged into a single node (readText appends to the current
// text node), so character references do not split runs, and (3) text-only
// payloads (JSON bodies, plain sentences) are scaffolded into
// html/head/body by the repairing parser, while linkedom drops them.
// ---------------------------------------------------------------------------

function mergeAdjacentTextNodes(parent: DuckNode): void {
  const holder = parent as unknown as {
    childNodes?: readonly DuckNode[];
    removeChild?(child: DuckNode): unknown;
  };
  const kids = [...(holder.childNodes ?? [])];
  let prevText: DuckNode | null = null;
  for (const kid of kids) {
    if (kid.nodeType === 8 || kid.nodeType === 7 || kid.nodeType === 14) {
      // readComments / readProcessingInstructions are False
      // (XQueryEngineHTML.pas:395-396) — comments and PIs never reach the
      // tree, so whitespace around them is one contiguous text run.
      // linkedom models CDATA sections as comment nodes "[CDATA[…]]";
      // InternetTools parses them as tetText.
      const raw = kid.nodeValue ?? '';
      const m = /^\[CDATA\[([\s\S]*)\]\]$/u.exec(raw);
      if (m !== null && kid.nodeType === 8) {
        (kid as unknown as { nodeType: number }).nodeType = 3;
        kid.nodeValue = m[1] ?? '';
        prevText = kid;
        continue;
      }
      holder.removeChild?.(kid);
      continue;
    }
    if (kid.nodeType === 3 && prevText !== null) {
      prevText.nodeValue = (prevText.nodeValue ?? '') + (kid.nodeValue ?? '');
      holder.removeChild?.(kid);
      continue;
    }
    if (kid.nodeType === 1) {
      mergeAdjacentTextNodes(kid);
    }
    prevText = kid.nodeType === 3 ? kid : null;
  }
}

/**
 * Parse a recorded document (kind html|xml|json) into a linkedom tree,
 * normalized to InternetTools repairing-parser semantics. Leading
 * `<!DOCTYPE …>` / `<?xml …?>` prologs are stripped: fontoxpath yields no
 * element matches for documents carrying a document-type node (non-standard
 * DOM), and the doctype node itself is never queried by the corpus
 * expressions (FMD2's repairing parser ignores it equally).
 */
export function parseQueryDocument(_kind: QueryDocumentKind, content: string): DuckDocument {
  ensureLinkedomLowercase();
  const stripped = content
    .replace(/^\s*<\?xml[\s\S]*?\?>/u, '')
    .replace(/^\s*<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/iu, '');
  const normalized = stripped.replace(/\r\n?/gu, '\n');
  let doc = parseHTML(normalized).document as unknown as DuckDocument;
  if (doc.documentElement === null && normalized.trim() !== '') {
    // repairing-parser scaffold: bare text (JSON bodies, plain text) is
    // wrapped into html/head/body by FMD2's TTreeParser
    doc = parseHTML(`<html><head></head><body>${normalized}</body></html>`).document as unknown as DuckDocument;
  }
  mergeAdjacentTextNodes(doc as unknown as DuckNode);
  dropTextAfterBody(doc);
  return doc;
}

/**
 * bpmAfterBody whitespace skip: text after the `</body>` close never
 * reaches the tree (TTreeParser.readText, basic parsing state AfterBody —
 * whitespace-only input is skipped without a repair; probed via the FPC
 * oracle). Text between `</head>` and `<body>` IS kept as an html child.
 */
function dropTextAfterBody(doc: DuckDocument): void {
  const html = doc.documentElement;
  if (html === null) {
    return;
  }
  const holder = html as unknown as { childNodes?: readonly DuckNode[]; removeChild?(child: DuckNode): unknown };
  const kids = [...(holder.childNodes ?? [])];
  let seenBody = false;
  for (const kid of kids) {
    if (kid.nodeType === 1 && (kid as unknown as { localName?: string }).localName?.toLowerCase() === 'body') {
      seenBody = true;
      continue;
    }
    if (seenBody && kid.nodeType === 3) {
      holder.removeChild?.(kid);
    }
  }
}

interface DocHandle {
  readonly document: DuckDocument;
}

const EVAL_OPTIONS = {
  namespaceResolver: fmdNamespaceResolver,
};

export function trimLuaStyle(s: string): string {
  return pascalTrim(s);
}

/**
 * Live corpus replay engine (contract/types.ts `QueryEngine`): FontoXPath
 * + linkedom behind the dialect transform. Expression-level failures are
 * reported `ok: false` — never thrown (FMD2 swallow semantics,
 * XQueryEngineHTML.pas Eval: except end → empty IXQValue).
 */
export class FontoXPathQueryEngine implements QueryEngine {
  readonly name = 'fontoxpath-linkedom';

  private readonly swallower: SwallowLogger;

  constructor(logger: HostLogger | null = null) {
    ensureLinkedomLowercase();
    registerFmdFunctions();
    this.swallower = new SwallowLogger(logger);
  }

  parse(kind: QueryDocumentKind, content: string): ParsedQueryDocument {
    const handle: DocHandle = { document: parseQueryDocument(kind, content) };
    return { kind, handle };
  }

  evaluate(parsed: ParsedQueryDocument, expression: QueryExpression): QueryEngineResult {
    const doc = (parsed.handle as DocHandle).document;
    const transformed = transformExpression(expression.expression);
    const options = { ...EVAL_OPTIONS, currentContext: { currentContext: doc } };
    try {
      // one evaluation per expression: FMD2 Eval() runs once and all four
      // output shapes read the same IXQValue (fmd_capture.pas mirrors)
      const raw = evaluateXPath(transformed, doc, null, {}, evaluateXPath.ALL_RESULTS_TYPE, options);
      const items: readonly unknown[] = Array.isArray(raw)
        ? raw
        : raw === undefined || raw === null
          ? []
          : [raw];
      switch (expression.output) {
        case 'count': {
          // FMD2 EvalCount = Eval(...).Count — the result-sequence length
          return { ok: true, scalar: String(items.length), list: [], count: items.length };
        }
        case 'scalar': {
          // XPathString = Eval(...).toString: sequence → toJoinedString(''),
          // node items trimmed (XQGlobalTrimNodes)
          const scalar = items.length === 0 ? '' : items.map(itemToString).join('');
          return { ok: true, scalar, list: scalar === '' ? [] : [scalar], count: scalar === '' ? 0 : 1 };
        }
        case 'list': {
          // EvalStringAll(TheStrings): Add(Trim(v.toString)) per item
          const list = items.map((i) => pascalTrim(itemToString(i)));
          return { ok: true, scalar: joinSeparatorString(list), list, count: list.length };
        }
        case 'all':
        default: {
          // XPathStringAll: AddSeparatorString ', '-join of trimmed
          // non-empty values (XQueryEngineHTML.pas:130-137)
          const scalar = joinSeparatorString(items.map((i) => pascalTrim(itemToString(i))).filter((s) => s !== ''));
          return { ok: true, scalar, list: scalar === '' ? [] : [scalar], count: scalar === '' ? 0 : 1 };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.swallower.warnOnce('', expression.expression, message);
      return { ok: false, error: message };
    }
  }

  release(_parsed: ParsedQueryDocument): void {
    // linkedom trees are GC'd with the handle
  }
}

/** AddSeparatorString: skip trim-empty pieces, trim every kept piece. */
export function joinSeparatorString(parts: readonly string[], separator = ', '): string {
  let out = '';
  for (const part of parts) {
    const trimmed = pascalTrim(part);
    if (trimmed === '') {
      continue;
    }
    out = out === '' ? trimmed : `${pascalTrim(out)}${separator}${trimmed}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rate-limited error swallowing (§5.6: max 1 WARN per (module, expression)
// per RUN). Without a shared deduper the bound is per-instance; the
// observability assembly injects one ({@link SwallowSharedDeduper}) so the
// bound holds across engines/worker recycling and the counters feed the
// metrics endpoint. Structural contract — engine code stays independent
// of the observability module.
// ---------------------------------------------------------------------------

/** Shared run-level dedup contract (observability ExpressionFailureDeduper). */
export interface SwallowSharedDeduper {
  /** true → this (module, template) pair's WARN is due; false → suppressed. */
  report(moduleId: ModuleId, template: string): boolean;
}

export class SwallowLogger {
  private readonly seen = new Set<string>();
  constructor(
    private readonly logger: HostLogger | null,
    private readonly shared?: SwallowSharedDeduper,
  ) {}

  /** Report one swallowed evaluation error (deduplicated per key). */
  warnOnce(moduleId: ModuleId, key: string, message: string): void {
    const due = this.shared !== undefined
      ? this.shared.report(moduleId, key)
      : ((): boolean => {
          const dedupe = `${moduleId}|${key}`;
          if (this.seen.has(dedupe)) {
            return false;
          }
          this.seen.add(dedupe);
          return true;
        })();
    if (!due) {
      return;
    }
    this.logger?.write({
      level: 'warn',
      moduleId,
      message: `TXQuery> swallowed error for "${key}": ${message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// InnerText — InternetTools innerText algorithm port
// (simplehtmltreeparser.pas innerTextRangeInternal, the HTML5
// dom-htmlelement-innertext algorithm over the parsed tree)
// ---------------------------------------------------------------------------

const INNER_TEXT_SKIP = new Set([
  'area', 'base', 'basefont', 'datalist', 'head', 'link', 'meta', 'param',
  'rp', 'script', 'source', 'style', 'template', 'track', 'title',
]);

const INNER_TEXT_BREAKS: Record<string, string> = {
  br: '\n',
  td: '\t',
  th: '\t',
  tr: '\n',
  p: '\n\n',
};

/** Simplified CSSHasHiddenStyle: visibility:hidden / display:none inline. */
function cssHasHiddenStyle(style: string): boolean {
  if (style === '') {
    return false;
  }
  return /(^|[;{\s])display[\s]*:[\s]*none(?![\w-])/iu.test(style)
    || /(^|[;{\s])visibility[\s]*:[\s]*hidden(?![\w-])/iu.test(style);
}

function childrenOf(node: DuckNode): readonly DuckNode[] {
  return (node as unknown as { childNodes?: readonly DuckNode[] }).childNodes ?? [];
}

function localNameOf(node: DuckNode): string {
  return ((node as unknown as { localName?: string }).localName ?? node.nodeName ?? '').toLowerCase();
}

/**
 * InternetTools innerText: per-text-node strTrimAndNormalize with a single
 * space between whitespace-separated runs, skipped hidden/metadata
 * elements, `<br>`→\n, `<td>/<th>`→\t, `<tr>`→\n, `<p>`→\n\n. A bare text
 * node argument yields strTrim of its value.
 */
export function innerTextOf(node: unknown): string {
  if (node === null || node === undefined || typeof node !== 'object') {
    return '';
  }
  const n = node as DuckNode;
  if (n.nodeType === 3 || n.nodeType === 8) {
    return pascalTrim(n.nodeValue ?? '');
  }
  if (n.nodeType === 2) {
    return pascalTrim((n as unknown as { value?: string | null }).value ?? n.nodeValue ?? '');
  }
  const builder: string[] = [];
  let lastTextHadTrailingSpace = false;
  const bufferEndsWithWhitespace = (): boolean => {
    if (builder.length === 0) {
      return false;
    }
    const last = builder[builder.length - 1] as string;
    return last.length > 0 && last.charCodeAt(last.length - 1) <= 0x20;
  };
  const walk = (parent: DuckNode): void => {
    for (const child of childrenOf(parent)) {
      if (child.nodeType === 3) {
        const raw = child.nodeValue ?? '';
        if (raw !== '') {
          const norm = pascalTrimAndNormalize(raw);
          if (norm !== '') {
            if ((lastTextHadTrailingSpace || raw.charCodeAt(0) <= 0x20) && !bufferEndsWithWhitespace()) {
              builder.push(' ');
            }
            builder.push(norm);
            lastTextHadTrailingSpace = raw.charCodeAt(raw.length - 1) <= 0x20;
          } else {
            lastTextHadTrailingSpace = true;
          }
        }
      } else if (child.nodeType === 1) {
        const name = localNameOf(child);
        if (INNER_TEXT_SKIP.has(name)) {
          continue;
        }
        const style = child.getAttribute?.('style') ?? '';
        if (cssHasHiddenStyle(style)) {
          continue;
        }
        const brk = INNER_TEXT_BREAKS[name];
        if (brk !== undefined) {
          builder.push(brk);
          lastTextHadTrailingSpace = false;
        }
        walk(child);
      }
    }
  };
  walk(n);
  return builder.join('');
}
