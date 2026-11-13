/**
 * Typed error raised when a §10 route answers with the error envelope
 * (`components["schemas"]["ApiErrorEnvelope"]`) or the transport fails.
 * React Query surfaces this as the query/mutation error.
 */
import type { components } from './openapi';

export type ApiErrorEnvelopeT = components['schemas']['ApiErrorEnvelope'];

export class ApiError extends Error {
  readonly code: ApiErrorEnvelopeT['error']['code'] | 'network_error';
  readonly status: number;

  constructor(message: string, code: ApiError['code'], status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Flatten a wire error envelope into an ApiError (thrown). */
export function throwEnvelope(error: ApiErrorEnvelopeT, status: number): never {
  throw new ApiError(error.error.message, error.error.code, status);
}

/** Transport-level failure (fetch rejection): typed network error. */
export function throwNetwork(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  throw new ApiError(`network error: ${message}`, 'network_error', 0);
}
