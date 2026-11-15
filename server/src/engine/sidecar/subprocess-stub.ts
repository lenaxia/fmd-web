import type { HostLogger } from '@fmd/contract';
import { LuaMultiReturn } from 'wasmoon';
import { toStr } from '../lua/base-globals.js';
import { extractUrl, type BypassExecutorPort, type BypassSolution } from './bypass-adapter.js';

/**
 * `fmd.subprocess` facade (§5.7 require-shim row; LuaSubprocess.pas
 * surface). Two modes per the contract row:
 *
 * - **Denied stub (default)** — `RunCommand` / `RunCommandHide` return
 *   nil: without the §5.11 browser sidecar profile the subprocess
 *   surface is knowingly unavailable and the §5.10 known-broken flags
 *   (`fmd.subprocess`, and via the template closure
 *   `madara.run_html_load`) stand.
 * - **Sidecar-routed** — with a `bypass` adapter the host routes
 *   `RunCommandHide` to the BypassExecutor: the command line's URL is
 *   solved through the FlareSolverr sidecar (bounded concurrency 2,
 *   60 s budget, health-gated — enforced by the adapter) and the call
 *   returns the REAL `LuaSubprocess.pas` 4-value contract
 *   (`_runcommand`: `lua_pushboolean; lua_pushstring(OutputString);
 *   lua_pushstring(ErrorString); lua_pushinteger(ExitStatus); Result:=4`)
 *   — `OutputString` is the `cloudflare.py` stdout shape
 *   (`flaresolver_status_code` + `flaresolver_result`) built from the
 *   solved solution, so FMD2's `cloudflare.lua:solveWithWebDriver`
 *   consumes it unchanged. The file-handoff utils/nodejs.lua relies on
 *   (npm-installed puppeteer writing scratch files) is NOT replicated —
 *   the adapter returns the solved page to the HOST boundary and logs
 *   the outcome.
 */

export interface SubprocessShimOptions {
  /** Present = the §5.11 browser profile is enabled. */
  readonly bypass?: BypassExecutorPort;
  readonly logger?: HostLogger | null;
  readonly moduleId?: string;
}

/** The LuaSubprocess.pas 4-value return: (result, output, errors, exitStatus).
 * A plain tuple: spreadable/destructurable at every consumer (the wasmoon
 * LuaMultiReturn instance constructed at runtime IS iterable — this is
 * its type-level shape). */
export type RunCommandReturn = [boolean, string, string, number];

export interface SubprocessShim {
  /** `RunCommand(exe, ...params)` (LuaSubprocess.pas — executable + N parameters). */
  RunCommand(exe: unknown, ...params: unknown[]): RunCommandReturn | undefined;
  /** `RunCommandHide(exe, ...params)` (LuaSubprocess.pas:41 hidden window). */
  RunCommandHide(exe: unknown, ...params: unknown[]): RunCommandReturn | undefined;
}

function warnShim(options: SubprocessShimOptions, message: string): void {
  options.logger?.write({ level: 'warn', moduleId: options.moduleId ?? '', message });
}

/**
 * wasmoon spreads a `LuaMultiReturn` instance into multiple Lua return
 * values (the same pattern the `pb` shim uses for pb.load's two-value
 * contract — pb-shim.ts).
 */
function runCommandReturn(result: boolean, output: string, errors: string, exitStatus: number): RunCommandReturn {
  return Reflect.construct(LuaMultiReturn, [result, output, errors, exitStatus]) as RunCommandReturn;
}

/**
 * The `cloudflare.py` stdout shape `solveWithWebDriver` json.decodes:
 * `{flaresolver_status_code, flaresolver_result}` where
 * `flaresolver_result` is the STRINGIFIED flat cookie map +
 * `user_agent` (cloudflare.py solve_flare flattens solution.cookies and
 * deletes the debug `solution` key before dumping).
 */
export function flaresolverrStdout(solution: BypassSolution): string {
  const flat: Record<string, string> = {};
  for (const cookie of solution.cookies) {
    flat[cookie.name] = cookie.value;
  }
  flat['user_agent'] = solution.userAgent;
  return JSON.stringify({
    flaresolver_status_code: solution.status,
    flaresolver_result: JSON.stringify(flat),
    rookiepy_status_code: 400,
    rookiepy_result: 'rookiepy did not run',
  });
}

export function makeSubprocessShim(options: SubprocessShimOptions): SubprocessShim {
  if (options.bypass === undefined) {
    // §5.7 contract row: denied stub — RunCommand* => nil
    const denied = (): undefined => undefined;
    return { RunCommand: denied, RunCommandHide: denied };
  }
  const bypass = options.bypass;
  // LuaSubprocess.pas _runcommand: executable + ALL trailing parameters
  // (lua_gettop loop) — cloudflare.lua calls RunCommandHide(table.unpack(cmd_))
  // with 7 arguments; joining every argument keeps extractUrl faithful.
  const run = (...args: unknown[]): RunCommandReturn => {
    const commandLine = args.map((a) => String(toStr(a))).join(' ');
    const url = extractUrl(commandLine);
    if (url === undefined) {
      warnShim(options, `subprocess: no http(s) URL in command line; refusing: ${commandLine}`);
      return runCommandReturn(false, '', 'no http(s) URL in command line', 1);
    }
    let solution: BypassSolution;
    try {
      // the blocking bridge (engine thread; §5.11 budgets enforced by
      // the adapter: concurrency 2, 60 s, health gate)
      solution = bypass.solveSync({ url });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      warnShim(
        options,
        `subprocess: sidecar solve failed for ${url}: ${message}`,
      );
      return runCommandReturn(false, '', message, 1);
    }
    warnShim(
      options,
      `subprocess: routed to browser sidecar — ${url} -> status ${String(solution.status)} (${String(solution.userAgent)})`,
    );
    return runCommandReturn(true, flaresolverrStdout(solution), '', 0);
  };
  return { RunCommand: run, RunCommandHide: run };
}
