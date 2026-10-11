import { AppError } from '@opendrive/shared';

/**
 * Column value parsing.
 *
 * The Postgres driver returns `bigint` (int8) columns as **strings** to avoid the precision loss
 * that a JavaScript number would introduce above 2^53. Byte counts are the fields most affected,
 * and reading one as a string is exactly the kind of bug that turns a quota check into
 * `"1073741824" > 1073741823 === false`. Conversion therefore happens through these helpers,
 * which validate the value instead of coercing it: a value that is not a safe integer is a
 * server fault, not a zero.
 */

function toSafeInteger(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new AppError('INTERNAL', {
        detail: `Column "${field}" is not a safe integer.`,
        expose: false,
      });
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new AppError('INTERNAL', {
        detail: `Column "${field}" exceeds Number.MAX_SAFE_INTEGER.`,
        expose: false,
      });
    }
    return Number(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new AppError('INTERNAL', {
        detail: `Column "${field}" exceeds Number.MAX_SAFE_INTEGER.`,
        expose: false,
      });
    }
    return parsed;
  }
  throw new AppError('INTERNAL', {
    detail: `Column "${field}" is not an integer.`,
    expose: false,
  });
}

/** A non-negative integer column (byte counts, file counts). */
export function parseByteCount(value: unknown, field: string): number {
  const parsed = toSafeInteger(value, field);
  if (parsed < 0) {
    throw new AppError('INTERNAL', { detail: `Column "${field}" is negative.`, expose: false });
  }
  return parsed;
}

export function parseNullableByteCount(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return parseByteCount(value, field);
}

/**
 * Timestamps arrive as `Date`. A string is accepted and converted so that a database or driver
 * change surfaces as a working read rather than a crash, but anything else is refused.
 */
export function parseTimestamp(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new AppError('INTERNAL', {
    detail: `Column "${field}" is not a timestamp.`,
    expose: false,
  });
}

export function parseNullableTimestamp(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null;
  return parseTimestamp(value, field);
}
