import { AppError } from '../errors.js';

/** Provider is reachable but cannot serve the request right now (retryable). */
export function storageUnavailable(detail: string, cause?: unknown): AppError {
  return new AppError('STORAGE_UNAVAILABLE', {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The declared size exceeds the provider's hard limit — retrying will not help. */
export function providerLimitExceeded(detail: string): AppError {
  return new AppError('PAYLOAD_TOO_LARGE', { detail });
}

/** Declared checksum does not match the received bytes. Nothing becomes readable. */
export function integrityCheckFailed(detail: string): AppError {
  return new AppError('INTEGRITY_CHECK_FAILED', { detail });
}

export function uploadNotFound(uploadId: string): AppError {
  return new AppError('NOT_FOUND', {
    detail: 'No upload session exists for this id.',
    context: { uploadId },
    expose: true,
  });
}

export function objectNotFound(): AppError {
  return new AppError('NOT_FOUND', {
    detail: 'The stored object does not exist. It may have been deleted.',
  });
}

/** Session is in a state that cannot accept the requested transition. */
export function invalidSessionState(detail: string): AppError {
  return new AppError('CONFLICT', { detail });
}

/** Duplicate part number or duplicate initiate request for the same session. */
export function duplicateRequest(detail: string): AppError {
  return new AppError('CONFLICT', { detail });
}

export function sessionExpired(uploadId: string): AppError {
  return new AppError('CONFLICT', {
    detail: 'The upload session expired before it was finalized.',
    context: { uploadId },
  });
}
