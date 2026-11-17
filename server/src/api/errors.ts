/**
 * Typed API error envelope (DESIGN.md §10): every non-2xx response uses
 * ONE shape — `{ error: { code, message, details? } }` — produced by the
 * Fastify error handler in `app.ts`. Handlers and services throw
 * {@link ApiError}; everything else falls through as `internal_error`.
 */

/** Machine-readable error codes (stable contract values for the SPA). */
export type ApiErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'bad_request'
  | 'upstream_error'
  | 'internal_error'
  | 'no_site_match'
  | 'ambiguous_site';

/** The wire envelope. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

/** The only error type API code throws — everything maps through this. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 400 with the zod issue list as details. */
export function validationError(message: string, issues: readonly unknown[]): ApiError {
  return new ApiError(400, 'validation_error', message, { issues });
}

/** 404 for an unknown resource of the given kind. */
export function notFound(kind: string, id: string): ApiError {
  return new ApiError(404, 'not_found', `unknown ${kind}: ${id}`);
}

/** Render any thrown value into the envelope (error handler input). */
export function toErrorBody(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    const details = err.details;
    return {
      status: err.status,
      body: {
        error:
          details === undefined
            ? { code: err.code, message: err.message }
            : { code: err.code, message: err.message, details },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { code: 'internal_error', message } },
  };
}
