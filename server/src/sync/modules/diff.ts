/**
 * Module diff report (D9 review gate): compare two Init-pass inventories by
 * module ID — the stable join key across modules, catalogs and DB rows.
 * `added`/`removed` are ID-set differences; `changed` is an ID present on
 * both sides whose Name or source file moved. Entries are sorted by ID so
 * the report (and its golden test) is deterministic.
 */

export interface ModuleInventoryEntry {
  /** 32-hex module ID (lowercase). */
  readonly id: string;
  readonly name: string;
  /** Tree-relative file the registration came from (e.g. `modules/AsuraScans.lua`). */
  readonly sourceFile: string;
}

export interface AddedModule {
  readonly kind: 'added';
  readonly id: string;
  readonly name: string;
  readonly sourceFile: string;
}

export interface RemovedModule {
  readonly kind: 'removed';
  readonly id: string;
  readonly name: string;
  readonly sourceFile: string;
}

export interface ChangedModule {
  readonly kind: 'changed';
  readonly id: string;
  readonly previousName: string;
  readonly currentName: string;
  readonly previousSourceFile: string;
  readonly currentSourceFile: string;
}

export type ModuleDiffEntry = AddedModule | RemovedModule | ChangedModule;

export interface ModuleDiffReport {
  readonly added: readonly AddedModule[];
  readonly removed: readonly RemovedModule[];
  readonly changed: readonly ChangedModule[];
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function diffModuleInventories(
  previous: readonly ModuleInventoryEntry[],
  current: readonly ModuleInventoryEntry[],
): ModuleDiffReport {
  const prevById = new Map(previous.map((entry) => [entry.id, entry]));
  const currentById = new Map(current.map((entry) => [entry.id, entry]));

  const added: AddedModule[] = [];
  const changed: ChangedModule[] = [];
  for (const entry of currentById.values()) {
    const prev = prevById.get(entry.id);
    if (prev === undefined) {
      added.push({ kind: 'added', id: entry.id, name: entry.name, sourceFile: entry.sourceFile });
    } else if (prev.name !== entry.name || prev.sourceFile !== entry.sourceFile) {
      changed.push({
        kind: 'changed',
        id: entry.id,
        previousName: prev.name,
        currentName: entry.name,
        previousSourceFile: prev.sourceFile,
        currentSourceFile: entry.sourceFile,
      });
    }
  }

  const removed: RemovedModule[] = [];
  for (const entry of prevById.values()) {
    if (!currentById.has(entry.id)) {
      removed.push({ kind: 'removed', id: entry.id, name: entry.name, sourceFile: entry.sourceFile });
    }
  }

  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    changed: changed.sort(byId),
  };
}
