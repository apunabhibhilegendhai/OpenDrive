import { z } from 'zod';

/**
 * Canonical error codes returned by the API and emitted by internal services.
 * The HTTP status is part of the contract, not an implementation detail.
 */
export const ERROR_DEFINITIONS = {
  VALIDATION_FAILED: { status: 400, title: 'Validation failed' },
  INVALID_REQUEST: { status: 400, title: 'Invalid request' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  NOT_FOUND: { status: 404, title: 'Resource not found' },
  CONFLICT: { status: 409, title: 'Conflicting state' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  RANGE_NOT_SATISFIABLE: { status: 416, title: 'Range not satisfiable' },
  INTEGRITY_CHECK_FAILED: { status: 422, title: 'Integrity check failed' },
  RATE_LIMITED: { status: 429, title: 'Rate limit exceeded' },
  QUOTA_EXCEEDED: { status: 429, title: 'Quota exceeded' },
  INTERNAL: { status: 500, title: 'Internal error' },
  STORAGE_CAPABILITY_UNSUPPORTED: { status: 500, title: 'Storage capability unsupported' },
  NOT_IMPLEMENTED: { status: 501, title: 'Not implemented' },
  STORAGE_UNAVAILABLE: { status: 503, title: 'Storage unavailable' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export const errorCodeSchema = z.enum(
  Object.keys(ERROR_DEFINITIONS) as [ErrorCode, ...ErrorCode[]],
);

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_DEFINITIONS[code].status;
}

/**
 * RFC 9457 problem details, extended with a stable machine-readable `code`,
 * the request identifier and per-field validation errors.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: ErrorCode;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  code: errorCodeSchema,
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export interface AppErrorOptions {
  /** Safe, human-readable explanation. Must not contain secrets or internal paths. */
  detail: string;
  /** Field-level details for validation failures. */
  errors?: { path: string; message: string }[];
  /** Machine-readable context that is safe to expose (never credentials or provider tokens). */
  context?: Record<string, string | number | boolean>;
  /** Set false to suppress `detail` from the response (server-side diagnostics only). */
  expose?: boolean;
  cause?: unknown;
}

/**
 * Base class for every expected failure. Anything that is not an AppError is
 * treated as an unexpected internal error and is not exposed to clients.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string;
  readonly errors?: { path: string; message: string }[];
  readonly context?: Record<string, string | number | boolean>;
  readonly expose: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions) {
    super(options.detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = httpStatusFor(code);
    this.detail = options.detail;
    this.errors = options.errors;
    this.context = options.context;
    this.expose = options.expose ?? true;
  }

  toProblemDetails(meta: { instance?: string; requestId?: string } = {}): ProblemDetails {
    const problem: ProblemDetails = {
      type: `https://docs.opendrive.example/errors/${this.code.toLowerCase()}`,
      title: ERROR_DEFINITIONS[this.code].title,
      status: this.status,
      detail: this.expose ? this.detail : 'The request could not be completed.',
      code: this.code,
    };
    if (meta.instance !== undefined) problem.instance = meta.instance;
    if (meta.requestId !== undefined) problem.requestId = meta.requestId;
    if (this.errors !== undefined) problem.errors = this.errors;
    return problem;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Marker used by endpoints whose contract is published before their implementation.
 * These routes must fail loudly (501) instead of pretending to succeed.
 */
export function notImplemented(feature: string, phase: string): AppError {
  return new AppError('NOT_IMPLEMENTED', {
    detail:
      `"${feature}" is a declared but unimplemented OpenDrive capability. ` +
      `It is scheduled for ${phase} and there is no implementation in this build.`,
    context: { feature, phase },
  });
}

export function validationFailed(
  detail: string,
  errors?: { path: string; message: string }[],
): AppError {
  return new AppError('VALIDATION_FAILED', errors === undefined ? { detail } : { detail, errors });
}

export function notFound(detail: string): AppError {
  return new AppError('NOT_FOUND', { detail });
}
