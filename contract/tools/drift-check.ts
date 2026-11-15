import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContractDocument, EventBinding, FacadeTable, RequireShimRegistryEntry } from '../types.js';
import {
  ContractExtractionError,
  extractContractFacts,
  type ExtractedEvent,
  type ExtractedFacts,
} from './extract.js';

/**
 * CI drift check (DESIGN.md §5 implementation rule): extract the §5.2
 * event bindings + facade registration tables from a fresh parse of the
 * FMD2 Pascal sources and diff them against the shipped
 * `contract/contract.json`. Additionally — when `requireRegistry` is
 * supplied (the sanctioned CLI, scripts/contract-drift-check.ts, always
 * supplies it from server/src/engine/shims/require-registry.ts) — the
 * `requireShims[].status` rows are cross-checked against the shim
 * loader registry (single source of truth): any hand-edited status
 * diverging from what the loader actually registers fails the gate.
 *
 * Exit codes:
 * - 0: no drift
 * - 1: drift detected (messages list every mismatch)
 * - 2: extraction failure (unrecognized Pascal pattern — fail loud)
 */

export interface DriftCheckOptions {
  /** Path to the contract document to verify (default: `./contract.json`). */
  readonly contractPath?: string;
  /** FMD2 `baseunits/lua` directory (default: `<cwd>/../../FMD2/baseunits/lua`). */
  readonly luaDir?: string;
  /**
   * The shim loader registry (server/src/engine/shims/require-registry.ts
   * — REQUIRE_SHIM_REGISTRY). When present, `requireShims[].status` is
   * verified against it; omitting it skips ONLY the require-shim
   * cross-check (pure-function callers may do so), never weakens the
   * sanctioned gate.
   */
  readonly requireRegistry?: readonly RequireShimRegistryEntry[];
}

export interface DriftCheckResult {
  readonly exitCode: 0 | 1 | 2;
  readonly messages: readonly string[];
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i): boolean => x === b[i]);
}

function diffEvents(extracted: readonly ExtractedEvent[], contract: readonly EventBinding[]): readonly string[] {
  const messages: string[] = [];
  const byName = new Map<string, EventBinding>();
  for (const row of contract) {
    byName.set(row.event, row);
  }

  if (extracted.length !== contract.length) {
    messages.push(
      `events: extractor found ${String(extracted.length)} dispatchers but contract.json has ${String(contract.length)} rows`,
    );
  }

  for (const ev of extracted) {
    const row = byName.get(ev.event);
    if (row === undefined) {
      messages.push(`events: extractor produced "${ev.event}" but contract.json has no such row`);
      continue;
    }
    byName.delete(ev.event);
    if (row.returns !== ev.returns) {
      messages.push(
        `events[${ev.event}].returns: contract=${row.returns} extractor=${ev.returns}`,
      );
    }
    if (row.constants !== ev.constants) {
      messages.push(
        `events[${ev.event}].constants: contract=${row.constants} extractor=${ev.constants}`,
      );
    }
    if (!sameStrings([...row.globals], ev.globals)) {
      messages.push(
        `events[${ev.event}].globals: contract=[${row.globals.join(', ')}] extractor=[${ev.globals.join(', ')}]`,
      );
    }
    if (!sameStrings([...row.readBack], ev.readBack)) {
      messages.push(
        `events[${ev.event}].readBack: contract=[${row.readBack.join(', ')}] extractor=[${ev.readBack.join(', ')}]`,
      );
    }
  }
  for (const name of byName.keys()) {
    messages.push(`events: contract.json row "${name}" has no counterpart in the Pascal dispatchers`);
  }
  return messages;
}

function structuralEventChecks(contract: readonly EventBinding[]): readonly string[] {
  const messages: string[] = [];
  for (const row of contract) {
    if (row.globals[0] !== 'MODULE') {
      messages.push(`events[${row.event}]: MODULE must be the first bound global`);
    }
    for (const g of row.readBack) {
      if (!row.globals.includes(g)) {
        messages.push(`events[${row.event}]: read-back global ${g} is not a bound global`);
      }
    }
    if (row.pushOnly === true && row.readBack.length > 0) {
      messages.push(`events[${row.event}]: push-only row must have an empty readBack`);
    }
    if (!row.globals.includes('ACCOUNT')) {
      continue;
    }
    messages.push(`events[${row.event}]: ACCOUNT global must never appear (§5.2)`);
  }
  return messages;
}

function facadeMethodNames(facade: FacadeTable): readonly string[] {
  return facade.methods.map((m): string => m.name);
}

function facadeConstructorNames(facade: FacadeTable): readonly string[] {
  return (facade.constructors ?? []).map((m): string => m.name);
}

function diffOneFacade(
  name: string,
  extracted: { readonly methods: readonly string[] },
  contract: FacadeTable | undefined,
  what: readonly string[],
): readonly string[] {
  if (contract === undefined) {
    return [`facades: contract.json has no "${name}" facade`];
  }
  const messages: string[] = [];
  const actual = facadeMethodNames(contract);
  if (!sameStrings(extracted.methods, actual)) {
    messages.push(
      `facades[${name}].methods (${what.join(', ')}): contract=[${actual.join(', ')}] ` +
      `extractor=[${extracted.methods.join(', ')}]`,
    );
  }
  return messages;
}

function diffProps(
  label: string,
  extracted: readonly { readonly name: string; readonly access: string }[],
  contract: readonly { readonly name: string; readonly access: string }[] | undefined,
): readonly string[] {
  if (contract === undefined) {
    return [`${label}: contract.json has no such property list`];
  }
  const actual = contract.map((p): string => `${p.name}:${p.access}`);
  const expected = extracted.map((p): string => `${p.name}:${p.access}`);
  if (!sameStrings(expected, actual)) {
    return [`${label}: contract=[${actual.join(', ')}] extractor=[${expected.join(', ')}]`];
  }
  return [];
}

function diffFacades(facts: ExtractedFacts, contract: readonly FacadeTable[]): readonly string[] {
  const messages: string[] = [];
  const byName = new Map<string, FacadeTable>();
  for (const f of contract) {
    byName.set(f.name, f);
  }

  messages.push(...diffOneFacade('TXQuery', facts.facades.TXQuery, byName.get('TXQuery'), ['LuaXQuery.pas:192-201']));

  const storage = byName.get('Storage');
  const storageExtracted = facts.facades.Storage;
  if (storage === undefined) {
    messages.push('facades: contract.json has no "Storage" facade');
  } else {
    if (!sameStrings(storageExtracted.methods, facadeMethodNames(storage))) {
      messages.push(
        `facades[Storage].methods: contract=[${facadeMethodNames(storage).join(', ')}] ` +
        `extractor=[${storageExtracted.methods.join(', ')}]`,
      );
    }
    messages.push(...diffProps('facades[Storage].properties', storageExtracted.properties, storage.properties));
    const da = storageExtracted.defaultArrayProperty;
    const daContract = storage.defaultArrayProperty?.access;
    if (da !== daContract) {
      messages.push(
        `facades[Storage].defaultArrayProperty: contract=${daContract ?? 'absent'} ` +
        `extractor=${da ?? 'absent'}`,
      );
    }
  }

  const puzzle = byName.get('ImagePuzzle');
  const puzzleExtracted = facts.facades.ImagePuzzle;
  if (puzzle === undefined) {
    messages.push('facades: contract.json has no "ImagePuzzle" facade');
  } else {
    if (!sameStrings(puzzleExtracted.methods, facadeMethodNames(puzzle))) {
      messages.push(
        `facades[ImagePuzzle].methods: contract=[${facadeMethodNames(puzzle).join(', ')}] ` +
        `extractor=[${puzzleExtracted.methods.join(', ')}]`,
      );
    }
    const ctors = facadeConstructorNames(puzzle);
    if (!sameStrings(puzzleExtracted.constructors ?? [], ctors)) {
      messages.push(
        `facades[ImagePuzzle].constructors: contract=[${ctors.join(', ')}] ` +
        `extractor=[${(puzzleExtracted.constructors ?? []).join(', ')}]`,
      );
    }
    messages.push(...diffProps('facades[ImagePuzzle].properties', puzzleExtracted.properties, puzzle.properties));
    messages.push(...diffProps('facades[ImagePuzzle].arrayProperties', puzzleExtracted.arrayProperties ?? [], puzzle.arrayProperties ?? []));
  }

  messages.push(...diffOneFacade('Duktape', facts.facades.Duktape, byName.get('Duktape'), ['LuaDuktape.pas:27-30']));
  messages.push(...diffOneFacade('Crypto', facts.facades.Crypto, byName.get('Crypto'), ['LuaCrypto.pas:429-494']));

  return messages;
}

/**
 * Cross-check contract.json's `requireShims[].status` against the shim
 * loader registry (server/src/engine/shims/require-registry.ts — the
 * single source of truth, driven by installRequireShim itself).
 * Divergence in either direction fails, as does every structural
 * invariant (partial ⇔ gap note, non-planned ⇔ actually served,
 * planned ⇔ unserved, one registry row per contract row).
 */
export function diffRequireShims(
  contract: readonly { readonly require: string; readonly status: string }[],
  registry: readonly RequireShimRegistryEntry[],
): readonly string[] {
  const messages: string[] = [];
  const contractRows = new Map<string, string>();
  for (const row of contract) {
    contractRows.set(row.require, row.status);
  }
  const registryRows = new Map<string, RequireShimRegistryEntry>();
  for (const entry of registry) {
    if (registryRows.has(entry.require)) {
      messages.push(`requireShims: loader registry has duplicate rows for "${entry.require}"`);
    }
    registryRows.set(entry.require, entry);
  }

  for (const [name, status] of contractRows) {
    const entry = registryRows.get(name);
    if (entry === undefined) {
      messages.push(
        `requireShims: contract.json row "${name}" has no loader registry row (add one to server/src/engine/shims/require-registry.ts)`,
      );
      continue;
    }
    if (status !== entry.status) {
      messages.push(
        `requireShims["${name}"].status: contract=${status} registry=${entry.status}`,
      );
    }
  }
  for (const [name, entry] of registryRows) {
    if (!contractRows.has(name)) {
      messages.push(`requireShims: loader registry row "${name}" has no contract.json row`);
    }
    if (entry.status === 'partial' && (entry.gap === undefined || entry.gap.length === 0)) {
      messages.push(`requireShims["${name}"]: partial status requires a gap note`);
    }
    if (entry.status !== 'partial' && entry.gap !== undefined) {
      messages.push(`requireShims["${name}"]: gap note is only allowed on partial status`);
    }
    if (entry.status === 'planned' && entry.servedBy !== 'none') {
      messages.push(
        `requireShims["${name}"]: planned status must not claim loader registration (servedBy=${entry.servedBy})`,
      );
    }
    if (entry.status !== 'planned' && entry.servedBy === 'none') {
      messages.push(
        `requireShims["${name}"]: ${entry.status} status requires loader registration but servedBy=none`,
      );
    }
    if (entry.status !== 'planned' && entry.servedBy !== 'file-chunk' && entry.loaderKey === null) {
      messages.push(`requireShims["${name}"]: ${entry.servedBy} row must carry a loaderKey`);
    }
  }
  return messages;
}

/**
 * Walk up from `start` until `rel` exists below some directory.
 * Keeps the CLI defaults independent of the process working directory.
 */
function findUp(start: string, rel: string): string | undefined {
  let dir = start;
  for (;; ) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Pure extract→diff. Never throws for drift; throws only if the inputs
 * themselves are unreadable/malformed (surfaces as exit code 2).
 */
export function runDriftCheck(options: DriftCheckOptions = {}): DriftCheckResult {
  const contractPath = options.contractPath
    ?? process.env['CONTRACT_PATH']
    ?? findUp(moduleDir, 'contract.json')
    ?? resolve(process.cwd(), 'contract.json');
  const luaDir = options.luaDir
    ?? process.env['FMD2_LUA_DIR']
    ?? findUp(moduleDir, join('FMD2', 'baseunits', 'lua'));

  if (!existsSync(contractPath)) {
    return { exitCode: 2, messages: [`contract document not found: ${contractPath}`] };
  }
  if (luaDir === undefined || !existsSync(luaDir)) {
    return {
      exitCode: 2,
      messages: [`FMD2 lua dir not found (set FMD2_LUA_DIR or --lua-dir): ${luaDir ?? 'unresolved'}`],
    };
  }

  let facts: ExtractedFacts;
  try {
    facts = extractContractFacts(luaDir);
  } catch (err: unknown) {
    const detail = err instanceof ContractExtractionError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    return { exitCode: 2, messages: [`extraction failed: ${detail}`] };
  }

  let contract: ContractDocument;
  try {
    contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractDocument;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, messages: [`contract.json is not valid JSON: ${detail}`] };
  }

  const messages: string[] = [];
  if (facts.moduleBoundForEveryEvent !== true) {
    messages.push('MODULE binding could not be verified in LuaWebsiteModuleHandler.pas');
  }
  messages.push(...diffEvents(facts.events, contract.events));
  messages.push(...structuralEventChecks(contract.events));
  messages.push(...diffFacades(facts, contract.facades));
  if (options.requireRegistry !== undefined) {
    messages.push(...diffRequireShims(contract.requireShims, options.requireRegistry));
  }

  return { exitCode: messages.length === 0 ? 0 : 1, messages };
}

/**
 * CLI argument parsing, shared with the sanctioned CLI entry
 * (scripts/contract-drift-check.ts, run under tsx so the shim loader
 * registry can be imported from the server sources).
 */
export function parseArgs(argv: readonly string[]): DriftCheckOptions {
  const options: { contractPath?: string; luaDir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string => {
      const v = argv[i + 1];
      i += 1;
      return v ?? '';
    };
    if (arg === '--contract') {
      const v = next();
      options.contractPath = isAbsolute(v) ? v : resolve(process.cwd(), v);
    } else if (arg === '--lua-dir') {
      const v = next();
      options.luaDir = isAbsolute(v) ? v : resolve(process.cwd(), v);
    } else {
      throw new Error(`unknown argument: ${arg} (usage: drift-check [--contract <file>] [--lua-dir <dir>])`);
    }
  }
  return options;
}

/**
 * Run the drift check and report the outcome on stderr/stdout, setting
 * the process exit code (0 clean, 1 drift, 2 extraction failure). The
 * sanctioned CLI (scripts/contract-drift-check.ts) calls this with the
 * shim loader registry attached — there is deliberately no registry-less
 * CLI path, so a requireShims status lie can never slip past the gate.
 */
export function reportDriftCheckResult(result: DriftCheckResult, checkedWith: string): void {
  if (result.exitCode === 0) {
    console.log(
      `contract drift-check: OK — ${String(result.messages.length)} mismatches ` +
      `(${checkedWith} vs FMD2/baseunits/lua + shim loader registry)`,
    );
  } else {
    for (const m of result.messages) {
      console.error(`contract drift: ${m}`);
    }
  }
  process.exitCode = result.exitCode;
}
