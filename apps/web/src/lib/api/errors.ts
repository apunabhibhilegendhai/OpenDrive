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

  constructor(input: {
    status: number;
    code: string;
    detail: string;
    requestId?: string | null;
    fieldErrors?: { path: string; message: string }[];
  }) {
    super(input.detail);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
    this.requestId = input.requestId ?? null;
    this.fieldErrors = input.fieldErrors ?? [];
  }
}

export class NetworkError extends Error {
  constructor(detail: string) {
    super(detail);
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
    return 'The API could not be reached. Check the connection and try again.';
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
