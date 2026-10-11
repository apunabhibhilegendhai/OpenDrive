import { AppError } from '@opendrive/shared';

/**
 * Pagination cursors.
 *
 * A cursor is `(created_at, id)` of the last row on the previous page, base64url-encoded so clients
 * treat it as opaque. Keyset pagination is used instead of `offset` for two reasons that matter
 * here: an offset re-reads and skips rows on every page (and drifts when rows are inserted), and it
 * lets a caller enumerate the whole table cheaply — the id ordering has to be given away for that
 * to work.
 *
 * The cursor is decoded strictly. A malformed cursor is a validation error, never "start from the
 * beginning": silently restarting would return duplicates that a client cannot detect.
 */

const CURSOR_SEPARATOR = '\u0000';

export interface CursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(position: CursorPosition): string {
  const raw = `${position.createdAt.toISOString()}${CURSOR_SEPARATOR}${position.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The pagination cursor is not valid.',
      cause: error,
    });
  }

  const separator = raw.indexOf(CURSOR_SEPARATOR);
  if (separator <= 0) {
    throw new AppError('VALIDATION_FAILED', { detail: 'The pagination cursor is not valid.' });
  }

  const timestamp = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime()) || id === '') {
    throw new AppError('VALIDATION_FAILED', { detail: 'The pagination cursor is not valid.' });
  }

  return { createdAt, id };
}

/**
 * Builds the page envelope: fetch one row more than requested, and use its presence only to decide
 * whether a next page exists. The extra row is never returned.
 */
export function toPage<T extends { createdAt: Date; id: string }>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  if (last === undefined) return { items: [], nextCursor: null };
  return { items, nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) };
}
