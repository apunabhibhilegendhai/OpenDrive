import { describe, expect, it } from 'vitest';
import {
  ERROR_DEFINITIONS,
  AppError,
  httpStatusFor,
  isAppError,
  notFound,
  notImplemented,
  problemDetailsSchema,
  validationFailed,
} from './errors.js';

describe('error model', () => {
  it('maps every code to a documented HTTP status', () => {
    for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(definition.status).toBeLessThan(600);
      expect(httpStatusFor(code as keyof typeof ERROR_DEFINITIONS)).toBe(definition.status);
    }
  });

  it('serialises to RFC 9457 problem details', () => {
    const error = new AppError('NOT_FOUND', { detail: 'No such file.' });
    const problem = error.toProblemDetails({
      instance: '/api/v1/files/file_x',
      requestId: 'req-1',
    });
    expect(problem.status).toBe(404);
    expect(problem.code).toBe('NOT_FOUND');
    expect(problem.type).toContain('not_found');
    expect(problem.requestId).toBe('req-1');
    expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
  });

  it('hides details when expose is false, keeping the code and status', () => {
    const error = new AppError('INTERNAL', {
      detail: 'connection string contains secret',
      expose: false,
    });
    const problem = error.toProblemDetails();
    expect(problem.detail).not.toContain('secret');
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL');
  });

  it('carries field-level validation errors', () => {
    const error = validationFailed('Request body is invalid', [
      { path: 'filename', message: 'Required' },
    ]);
    expect(error.status).toBe(400);
    expect(error.errors).toEqual([{ path: 'filename', message: 'Required' }]);
  });

  it('labels unimplemented capabilities explicitly instead of succeeding', () => {
    const error = notImplemented('uploads.initiate', 'Phase 1');
    expect(error.code).toBe('NOT_IMPLEMENTED');
    expect(error.status).toBe(501);
    expect(error.detail).toContain('Phase 1');
    expect(error.context).toEqual({ feature: 'uploads.initiate', phase: 'Phase 1' });
  });

  it('identifies AppErrors for the HTTP error handler', () => {
    expect(isAppError(notFound('gone'))).toBe(true);
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError('boom')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
