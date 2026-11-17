/**
 * The MODULE RUNTIME SUBSTRATE — the swap surface (engine-boundary story,
 * tsk-linear-varnish-restricts). Everything the assembly consumes that
 * touches the module substrate is constructed THROUGH this interface:
 * the host factory, the registry sweep, the info/login/download/walk
 * services. The production implementation is wasmoon-backed; the
 * stub-substrate test implements the SAME interface with canned data and
 * no wasmoon anywhere on its path — the existence proof that "no Lua
 * gets in" (the interfaces are COMPLETE: if the app secretly needed the
 * Lua substrate, the stub boot could not be written).
 *
 * The default (wasmoon) substrate is constructed LAZILY by the assembly
 * (`await import('../engine/index.js')`) so a substituted runtime never
 * even evaluates the wasmoon module — the facade stays wasmoon-free.
 */
import { createLuaHostFactory } from '../lua/host.js';
import { ModuleSyncService, type ModuleSyncOptions, type ModuleTreeSweepPort } from '../registry/module-sync.js';
import type { RegistrationRecord } from '../registry/capabilities.js';
import type { LuaHostFactory } from '../contract.js';
import {
  EngineLoginSession,
  type EngineLoginDriverOptions,
  type ModuleLoginPort,
} from './account-session.js';
import {
  EngineDownloadHooks,
  type EngineDownloadOptions,
  type ModuleDownloadHooks,
} from './download-hooks.js';
import {
  EngineDirectoryWalker,
  type EngineDirectoryWalkerOptions,
  type DirectoryWalkPort,
} from './directory-walk.js';
import { EngineInfoService, type EngineInfoOptions, type ModuleInfoPort } from './module-info.js';

/**
 * The swappable engine surface (domain-shaped; substrate-mechanism-free).
 * `initialModules` lets a substrate that already owns a registry (a
 * future native-registry substrate, or the test stub) vouch for its
 * rows without a tree sweep — the assembly then serves them immediately
 * as the booted registry.
 */
export interface ModuleRuntime {
  /** The opaque host factory (stub: a factory that must never be called). */
  createHostFactory(): LuaHostFactory;
  /** Registry sweep over the synced module tree. */
  createSweep(options: ModuleSyncOptions): ModuleTreeSweepPort;
  /** Live module info (GetInfo through the substrate). */
  createInfoService(options: EngineInfoOptions): ModuleInfoPort;
  /** §6.8 live-scrape directory walker. */
  createDirectoryWalker(options: EngineDirectoryWalkerOptions): DirectoryWalkPort;
  /** §7.1 download-event hooks for one chapter run. */
  createDownloadHooks(moduleId: string, options: EngineDownloadOptions): Promise<ModuleDownloadHooks>;
  /** §8.6 module OnLogin session. */
  createLoginSession(options: EngineLoginDriverOptions): ModuleLoginPort;
  /** Substrate-vouched registry rows (undefined = boot via sweep). */
  readonly initialModules?: readonly RegistrationRecord[];
}

/** The PRODUCTION (wasmoon-backed) substrate — loaded lazily by the assembly. */
export function createModuleRuntime(): ModuleRuntime {
  return {
    createHostFactory: (): LuaHostFactory => createLuaHostFactory(),
    createSweep: (options): ModuleSyncService => new ModuleSyncService(options),
    createInfoService: (options): ModuleInfoPort => new EngineInfoService(options),
    createDirectoryWalker: (options): DirectoryWalkPort => new EngineDirectoryWalker(options),
    createDownloadHooks: (moduleId, options): Promise<ModuleDownloadHooks> =>
      EngineDownloadHooks.create(moduleId, options),
    createLoginSession: (options): ModuleLoginPort => new EngineLoginSession(options),
  };
}
