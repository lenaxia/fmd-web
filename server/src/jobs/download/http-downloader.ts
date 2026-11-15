import { applyAcceptImage, composeReset, NameValueMap } from '../../engine/shims/http-headers.js';
import { DEFAULT_USER_AGENT } from '../../engine/shims/http-pipeline.js';
import type { CancelToken, ImageDownloader, ImageFetchResult, SiteLimiter } from './types.js';

/**
 * The per-image HTTP download step (DESIGN §7.1; FMD2
 * `DownloadImage` :367-378 — `HTTP.Reset; HTTP.AcceptImage;
 * HTTP.GET(workURL)`): the §5.4 default header set with AcceptImage,
 * the per-site limiter slot around every hop, the transport retry loop
 * (`>500`/no-response bounded by the retry budget — the per-image retry
 * within the job budget), and §4 cancellation: the abort signal kills
 * in-flight hops, queued limiter waiters fail fast via the limiter.
 */
export interface HttpDownloaderOptions {
  readonly limiter: SiteLimiter;
  readonly cancel: CancelToken;
  /** Per-image retry budget for transport failures / 5xx (FMD2 RetryCount analog). */
  readonly retryCount?: number;
  /** Per-request timeout (ms). */
  readonly timeoutMs?: number;
  /** Extra headers the module set (e.g. Referer via BeforeDownloadImage). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpImageDownloader implements ImageDownloader {
  private readonly headers = new NameValueMap();
  private readonly retryCount: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpDownloaderOptions) {
    this.retryCount = Math.max(0, Math.trunc(options.retryCount ?? DEFAULT_RETRY_COUNT));
    this.timeoutMs = Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async download(url: string): Promise<ImageFetchResult> {
    if (this.options.cancel.cancelled) {
      return { ok: false, status: 0, contentType: '', bytes: new Uint8Array(0), cancelled: true };
    }
    const release = await this.options.limiter.acquire(url, () => this.options.cancel.cancelled);
    if (release === null) {
      // queued-but-unstarted → fail fast (§4, httpsendthread.pas:417-435 divergence)
      return { ok: false, status: 0, contentType: '', bytes: new Uint8Array(0), cancelled: true };
    }
    try {
      let result: ImageFetchResult = {
        ok: false,
        status: 0,
        contentType: '',
        bytes: new Uint8Array(0),
        cancelled: false,
      };
      for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
        result = await this.hop(url);
        if (result.cancelled || result.ok) {
          return result;
        }
        if (this.options.cancel.cancelled) {
          return { ...result, cancelled: true };
        }
        // retry while the hop did not produce a response or carried a 5xx
        // (httpsendthread.pas:623-629: `not sent or ResultCode > 500`)
        if (result.status <= 500 && result.status !== 0) {
          return result;
        }
      }
      return result;
    } finally {
      release();
    }
  }

  /** One transport hop with the Reset+AcceptImage header set (:367-369). */
  private async hop(url: string): Promise<ImageFetchResult> {
    composeReset(this.headers, true);
    applyAcceptImage(this.headers); // HTTP.AcceptImage (httpsendthread.pas:919-922)
    // the request-side UA insert (httpsendthread.pas:469-477)
    this.headers.set('User-Agent', DEFAULT_USER_AGENT);
    for (const [name, value] of Object.entries(this.options.extraHeaders ?? {})) {
      this.headers.set(name, value);
    }
    const requestHeaders: Record<string, string> = {};
    for (const [name, value] of this.headers.entries()) {
      requestHeaders[name] = value;
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    this.options.cancel.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal,
        redirect: 'follow',
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        ok: response.ok && bytes.length > 0,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes,
        cancelled: false,
      };
    } catch {
      // transport error / abort — the aborted flag distinguishes §4 cancel
      const aborted = this.options.cancel.cancelled;
      return {
        ok: false,
        status: 0,
        contentType: '',
        bytes: new Uint8Array(0),
        cancelled: aborted,
      };
    } finally {
      clearTimeout(timer);
      this.options.cancel.signal.removeEventListener('abort', onAbort);
    }
  }
}
