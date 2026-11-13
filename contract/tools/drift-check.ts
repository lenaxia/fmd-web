import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ContractDocument, EventBinding, FacadeTable } from '../types.js';
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
 * `contract/contract.json`.
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

  return { exitCode: messages.length === 0 ? 0 : 1, messages };
}

function parseArgs(argv: readonly string[]): DriftCheckOptions {
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

function main(): void {
  let options: DriftCheckOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(detail);
    process.exitCode = 2;
    return;
  }
  const result = runDriftCheck(options);
  if (result.exitCode === 0) {
    console.log(
      `contract drift-check: OK — ${String(result.messages.length)} mismatches ` +
      `(events + TXQuery/Storage/ImagePuzzle/Duktape/Crypto facades vs FMD2/baseunits/lua)`,
    );
  } else {
    for (const m of result.messages) {
      console.error(`contract drift: ${m}`);
    }
  }
  process.exitCode = result.exitCode;
}

// Run as CLI only when executed directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main();
}
