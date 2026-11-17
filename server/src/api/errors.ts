/**
 * Typed API error envelope (DESIGN.md §10): every non-2xx response uses
 * ONE shape — `{ error: { code, message, details? } }` — produced by the
 * Fastify error handler in `app.ts`. Handlers and services throw
 * {@link ApiError}; everything else falls through as `internal_error`.
 *
 * `ApiError`/`ApiErrorCode`/`ApiErrorBody` are DEFINED in @fmd/contract
 * (engine-boundary story): engine-side module services throw the SAME
 * typed domain error, so the envelope rendering below recognizes every
 * typed failure in the app without the engine importing the api layer.
 * Re-exported here so existing api-layer imports stay untouched.
 */
import { ApiError, type ApiErrorBody, type ApiErrorCode } from '@fmd/contract';

export { ApiError };
export type { ApiErrorBody, ApiErrorCode };

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
