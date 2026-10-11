import { describe, expect, it } from 'vitest';
import { isAppError } from '@opendrive/shared';
import {
  parseByteCount,
  parseNullableByteCount,
  parseNullableTimestamp,
  parseTimestamp,
} from './parse.js';
import {
  translateWriteError,
  isCheckViolation,
  isUniqueViolation,
  constraintNameOf,
} from './errors.js';

/**
 * The two conversion boundaries that a byte quota depends on: reading an int8 column, and turning a
 * constraint violation into an answer. Both are tested for the string form the driver actually
 * returns, not for the shape a developer might assume.
 */

describe('column parsing', () => {
  it('accepts the string form the driver returns for bigint columns', () => {
    // postgres.js returns int8 as a string to avoid precision loss; reading it as a number would
    // otherwise produce a silent NaN or a string comparison in a quota check.
    expect(parseByteCount('2147483648', 'files.size_bytes')).toBe(2147483648);
    expect(parseByteCount('0', 'files.size_bytes')).toBe(0);
    expect(parseByteCount(1024, 'files.size_bytes')).toBe(1024);
    expect(parseByteCount(1024n, 'files.size_bytes')).toBe(1024);
  });

  it('refuses anything that is not a safe non-negative integer', () => {
    for (const value of ['abc', '', '1.5', '-1', null, undefined, {}]) {
      const error = (() => {
        try {
          parseByteCount(value, 'files.size_bytes');
        } catch (caught) {
          return caught;
        }
        throw new Error('expected a refusal');
      })();
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('INTERNAL');
      expect(error.expose).toBe(false);
    }
    expect(() => parseByteCount('9007199254740993', 'x')).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('passes null through for nullable columns and parses timestamps', () => {
    expect(parseNullableByteCount(null, 'x')).toBeNull();
    expect(parseNullableByteCount('7', 'x')).toBe(7);
    expect(parseTimestamp(new Date('2026-10-11T10:00:00.000Z'), 'x').toISOString()).toBe(
      '2026-10-11T10:00:00.000Z',
    );
    expect(parseTimestamp('2026-10-11T10:00:00.000Z', 'x').toISOString()).toBe(
      '2026-10-11T10:00:00.000Z',
    );
    expect(parseNullableTimestamp(null, 'x')).toBeNull();
    expect(() => parseTimestamp('not-a-date', 'x')).toThrow(/timestamp/);
  });
});

describe('write error translation', () => {
  it('recognises SQLSTATE codes', () => {
    const unique = Object.assign(new Error('duplicate key'), { code: '23505' });
    const check = Object.assign(new Error('check failed'), { code: '23514', constraint_name: 'x' });
    expect(isUniqueViolation(unique)).toBe(true);
    expect(isCheckViolation(check)).toBe(true);
    expect(constraintNameOf(check)).toBe('x');
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });

  it('names a known constraint and maps it to a specific status', () => {
    const error = translateWriteError(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint_name: 'folders_sibling_name_unique',
      }),
      'fallback',
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.status).toBe(409);
    expect(error.detail).toBe('A folder with that name already exists in this location.');
  });

  it('falls back to the SQLSTATE meaning for an unknown constraint', () => {
    expect(
      translateWriteError(
        Object.assign(new Error('foreign key violation'), {
          code: '23503',
          constraint_name: 'some_new_constraint',
        }),
        'fallback',
      ).code,
    ).toBe('NOT_FOUND');
  });

  it('does not expose an unrecognised failure, and keeps the cause', () => {
    const original = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '08006',
    });
    const translated = translateWriteError(original, 'The file record could not be created.');
    expect(translated.code).toBe('INTERNAL');
    expect(translated.expose).toBe(false);
    expect(translated.toProblemDetails().detail).toBe('The request could not be completed.');
    expect(translated.cause).toBe(original);
  });

  it('never echoes a constraint name or message in the client-facing detail', () => {
    const translated = translateWriteError(
      Object.assign(
        new Error('duplicate key value violates unique constraint "folders_sibling_name_unique"'),
        {
          code: '23505',
          constraint_name: 'folders_sibling_name_unique',
        },
      ),
      'fallback',
    );
    expect(translated.detail).not.toContain('folders_sibling_name_unique');
    expect(JSON.stringify(translated.toProblemDetails())).not.toContain('duplicate key value');
  });
});
