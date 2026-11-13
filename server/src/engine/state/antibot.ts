import { AsyncMutex, hostOf } from './locks.js';
import type { ModuleSharedState } from './module-state.js';

/**
 * Anti-bot / websitebypass host-level interceptor (DESIGN.md §5.9), port of
 * `LuaWebsiteBypass.pas:142-209` + `checkantibot.lua:5-12`:
 *
 * 1. Request-path hook: `AllowServerErrorResponse=True` forced on the
 *    initial request (:156), then antibot heuristics run — 403/429/503 +
 *    Content-Type/Server sniff (:5-12) — under ONE process-global lock
 *    (:94-115); the lock is RELEASED before bypass execution so
 *    bypass-internal HTTP safely re-enters the interceptor (:94-115 vs :159).
 * 2. On hit: module-settings cookies are cleared FIRST (:177), then the
 *    per-module single-flight `tryEnter` (TryEnterCriticalSection, :161) —
 *    a concurrent LOSER proceeds with the plain request (:197-200), it must
 *    NEVER wait behind an in-progress bypass.
 * 3. Successful bypass persists cookies + UA into module settings (:182-183)
 *    and re-issues the original request when `Storage['reload']` contains
 *    'true' (:184-188).
 * 4. Bypass execution is pluggable ({@link BypassExecutor}): the default is
 *    the known-broken stub (§5.10/§5.11); the browser-sidecar adapter
 *    replaces it when the `browser` compose profile is enabled.
 */

/** What the heuristics (checkantibot.lua) read off the last response. */
export interface AntiBotResponseView {
  readonly resultCode: number;
  /** `Headers.Values['Content-Type']` of the response. */
  readonly contentType: string;
  /** `Headers.Values['Server']` of the response. */
  readonly server: string;
}

/** The HTTP object surface the interceptor drives (THTTPSendThread subset). */
export interface InterceptableRequest {
  readonly method: string;
  readonly url: string;
  /** `ThreadTerminated` — a loser skips the plain re-issue when true (:198). */
  readonly terminated: boolean;
  /** `UserAgent` of the object (:183 persists it after a successful bypass). */
  readonly userAgent: string;
  /** The response view for the heuristics, AFTER the last execute(). */
  view(): AntiBotResponseView;
  /** `AllowServerErrorResponse` write — forced true (:156). */
  setAllowServerErrorResponse(value: boolean): void;
  /** `Reset()` before the reload re-issue (:186). */
  reset(): void;
  /** Perform the request with the current object state (:157, :187, :199). */
  execute(): Promise<boolean>;
}

/** Pluggable bypass execution (`____WebsiteBypass(METHOD, URL)`, §5.9/§5.11). */
export interface BypassExecutor {
  /**
   * False = bypass machinery unavailable (known-broken deployment, no
   * sidecar profile): the interceptor short-circuits to the plain request
   * exactly like FMD2 with the chunks absent (:149-153).
   */
  readonly available: boolean;
  /** Run the bypass for one request. True = clearance obtained. */
  bypass(ctx: BypassContext): Promise<boolean>;
}

export interface BypassContext {
  readonly method: string;
  readonly url: string;
  /** Lowercased host of `url`. */
  readonly host: string;
  /** The original request object (bypass-internal HTTP re-enters the interceptor). */
  readonly request: InterceptableRequest;
  /** The module's shared state (§5.3) — jar/storage/settings/bypass gate. */
  readonly module: ModuleSharedState;
}

/** The v1 default: no bypass executor wired — known-broken (§5.10). */
export class StubBypassExecutor implements BypassExecutor {
  readonly available = false;

  async bypass(): Promise<boolean> {
    return false;
  }
}

/**
 * `____CheckAntiBot` (checkantibot.lua:5-12), kept minimal — runs for every
 * HTTP request: 403/429/503 + Content-Type contains 'text/html' + Server
 * contains 'cloudflare' or 'ddos-guard' (Lua `find` ≙ substring, case-folded).
 */
export function checkAntiBot(response: AntiBotResponseView): boolean {
  const rc = response.resultCode;
  if ((rc === 403 || rc === 429 || rc === 503) && response.contentType.toLowerCase().includes('text/html')) {
    const server = response.server.toLowerCase();
    if (server.includes('cloudflare') || server.includes('ddos-guard')) {
      return true;
    }
  }
  return false;
}

export interface AntiBotInterceptorOptions {
  /** Injected heuristic (tests count concurrency; default {@link checkAntiBot}). */
  readonly check?: (response: AntiBotResponseView) => boolean | Promise<boolean>;
}

export interface InterceptOptions {
  /** Pluggable bypass execution; default = known-broken stub. */
  readonly bypassExecutor?: BypassExecutor;
}

export interface InterceptResult {
  /** Final request result (success ⇔ Document.Size > 0 upstream). */
  readonly result: boolean;
  /** True when the antibot heuristics fired for this request. */
  readonly antibotHit: boolean;
  /** 'bypass' = winner ran the executor; 'fallthrough' = loser's plain re-issue; 'plain' = no hit. */
  readonly path: 'plain' | 'bypass' | 'fallthrough';
}

/**
 * The interceptor. ONE instance per process (the antibot check lock is
 * global, FMD2 `checkantibot_cs`), driving every module's request path.
 */
export class AntiBotInterceptor {
  private readonly check: (response: AntiBotResponseView) => boolean | Promise<boolean>;
  /** ONE global antibot check at a time (LuaWebsiteBypass.pas:94-115). */
  private readonly checkLock = new AsyncMutex(undefined, 'antibot-check');
  /** Re-entrancy depth of the global check (test diagnostics). */
  private checkDepth = 0;
  private maxCheckDepth = 0;

  constructor(options: AntiBotInterceptorOptions = {}) {
    this.check = options.check ?? checkAntiBot;
  }

  get maxObservedCheckConcurrency(): number {
    return this.maxCheckDepth;
  }

  /** Whether the request looks like an antibot page (serialized globally). */
  async checkAntiBotActive(request: InterceptableRequest): Promise<boolean> {
    // Global lock scoped to the CHECK ONLY — released before bypass
    // execution so bypass-internal HTTP re-enters safely (:94-115 vs :159).
    return this.checkLock.runExclusive(async () => {
      this.checkDepth += 1;
      this.maxCheckDepth = Math.max(this.maxCheckDepth, this.checkDepth);
      try {
        return (await this.check(request.view())) === true;
      } finally {
        this.checkDepth -= 1;
      }
    });
  }

  /**
   * The request-path hook (WebsiteBypassRequest port). `module` is the
   * shared state of the URL's module; the caller resolves it via the state
   * service (§5.3).
   */
  async intercept(
    request: InterceptableRequest,
    module: ModuleSharedState,
    options: InterceptOptions = {},
  ): Promise<InterceptResult> {
    const executor = options.bypassExecutor;
    // Chunks absent / known-broken executor → plain request, no flow (:149-153).
    if (executor === undefined || !executor.available) {
      return { result: await request.execute(), antibotHit: false, path: 'plain' };
    }

    // AllowServerErrorResponse forced for the checked request (:156).
    request.setAllowServerErrorResponse(true);
    let result = await request.execute(); // :157

    if (!(await this.checkAntiBotActive(request))) {
      return { result, antibotHit: false, path: 'plain' };
    }

    // Per-module single-flight TryEnter (:161) — LOSER FALLS THROUGH.
    if (!module.bypass.tryEnter()) {
      if (!request.terminated) {
        result = await request.execute(); // :197-200 plain request, never waiting
      }
      return { result, antibotHit: true, path: 'fallthrough' };
    }

    try {
      // Cookies cleared from module settings BEFORE the bypass attempt (:177).
      await module.settings.setCookies('');
      let bypassOk = false;
      try {
        bypassOk = await executor.bypass({
          method: request.method,
          url: request.url,
          host: hostOf(request.url),
          request,
          module,
        });
      } catch {
        bypassOk = false; // WebsiteBypassGetAnswer catches → Result=false (:135-138)
      }
      result = bypassOk; // :178 Result := WebsiteBypassGetAnswer(...)
      if (bypassOk) {
        module.settings.enabled = true; // :181
        const jar = await module.cookies.snapshot();
        await module.settings.setCookies(jar.settingsText); // :182
        await module.settings.setUserAgent(request.userAgent); // :183
        // Persist module_state.cookies/ua (§9) so a restart keeps clearance.
        await module.persist();
        if (module.storage.getOrEmpty('reload').includes('true')) {
          // Original request re-issued after a reset (:184-188).
          request.reset();
          result = await request.execute();
        }
      }
      return { result, antibotHit: true, path: 'bypass' };
    } finally {
      module.bypass.leave(); // :191
    }
  }
}
