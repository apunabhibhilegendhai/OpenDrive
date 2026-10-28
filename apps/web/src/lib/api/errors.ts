import { problemDetailsResponseSchema } from '@opendrive/shared';

/**
 * Typed API failure.
 *
 * The API answers with RFC 9457 problem details plus a stable `code`. This class keeps the
 * machine-readable parts (status, code, requestId, field errors) so the UI can branch on them,
 * while never carrying a credential: nothing here is ever built from the request headers.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | null;
  readonly fieldErrors: { path: string; message: string }[];
  /**
   * Server-suggested wait before retrying, in milliseconds, when this failure is a rate limit
   * (`429`). `null` when the server did not say, or when this is not a rate limit. Mutable so the
   * XHR path can fill it in after parsing the response headers.
   */
  retryAfterMs: number | null;

  constructor(input: {
    status: number;
    code: string;
    detail: string;
    requestId?: string | null;
    fieldErrors?: { path: string; message: string }[];
    retryAfterMs?: number | null;
  }) {
    super(input.detail);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
    this.requestId = input.requestId ?? null;
    this.fieldErrors = input.fieldErrors ?? [];
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

/** Parse a `Retry-After` header value (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  // Delta-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, 5 * 60 * 1000);
  }
  // HTTP-date form.
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - now;
  if (delta <= 0) return 0;
  return Math.min(delta, 5 * 60 * 1000);
}

/**
 * The one sentence a transport failure is described with.
 *
 * A rejected `fetch` carries an engine-specific string — "Failed to fetch" in Chromium,
 * "NetworkError when attempting to fetch resource" in Firefox — which explains nothing to a person
 * and differs per browser. It is never the message anyone reads. Exported so the client that raises
 * the failure and this module that describes it cannot drift apart on the wording.
 */
export const NETWORK_FAILURE_MESSAGE =
  'The API could not be reached. Check the connection and try again.';

export class NetworkError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = 'NetworkError';
  }
}

export class ContractError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ContractError';
    this.status = status;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isAuthFailure(error: unknown): boolean {
  return (
    (isApiError(error) && (error.status === 401 || error.status === 403)) ||
    (error instanceof ContractError && error.status === 401)
  );
}

/**
 * Statuses worth retrying: the edge answered, but the origin did not serve the request.
 *
 * `408` is a request timeout; `524` is the edge's own "origin took too long" and is the one a large
 * ranged download actually meets (`520`-`523` are its siblings for an unreachable or unresponsive
 * origin). A `525`/`526` is a TLS misconfiguration, which a retry cannot fix, so it is left out.
 */
const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * A failure that re-sending the same, identical request can recover from.
 *
 * Used by the upload queue and the windowed download: both retry the exact same request, so the
 * only honest distinction is "the edge/origin hiccupped" (retry) versus "the server said no"
 * (final). A `401`/`403` is never transient, and neither is a contract or validation failure.
 */
export function isTransientFailure(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (isApiError(error) && (RETRYABLE_STATUSES.has(error.status) || error.status === 429))
  );
}

/** Build an `ApiError` from a response body that may or may not match the problem schema. */
export function problemFrom(status: number, payload: unknown): ApiError {
  const parsed = problemDetailsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError({
      status,
      code: 'UNEXPECTED_RESPONSE',
      detail: 'The server answered with a response this build does not understand.',
    });
  }
  const problem = parsed.data;
  return new ApiError({
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
    requestId: problem.requestId ?? null,
    fieldErrors: problem.errors ?? [],
  });
}

/**
 * Plain-language copy for a failure. The server's `detail` is already written to be shown to a
 * person, so it is preferred; the status-specific lines exist for the cases where a status
 * means something the UI must state explicitly (unavailable capability, unconfigured provider).
 */
export function describeFailure(error: unknown): string {
  if (error instanceof NetworkError) {
    return NETWORK_FAILURE_MESSAGE;
  }
  if (error instanceof ContractError) {
    return error.message;
  }
  if (isApiError(error)) {
    switch (error.status) {
      case 401:
        return 'This session is no longer valid. Sign in again to continue.';
      case 403:
        return 'This credential is not allowed to do that.';
      case 404:
        return error.detail;
      case 409:
        return error.detail;
      case 413:
        return error.detail;
      case 429:
        return 'Too many requests right now. Wait a moment and try again.';
      case 501:
        return error.detail;
      case 503:
        return error.detail;
      default:
        return error.detail;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong.';
}
