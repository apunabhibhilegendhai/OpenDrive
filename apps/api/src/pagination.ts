import { AppError } from '@opendrive/shared';

/**
 * Pagination cursors.
 *
 * A cursor identifies the last row of a page by `(created_at, id)`, base64url-encoded so clients
 * treat it as opaque. Keyset pagination is used instead of `offset` for two reasons that matter
 * here: an offset re-reads and skips rows on every page (and drifts when rows are inserted), and it
 * lets a caller enumerate the whole table cheaply — the id ordering has to be given away for that
 * to work.
 *
 * `created_at` is carried as the exact string the database returned, not a JavaScript `Date`.
 * `Date` only resolves to milliseconds, while Postgres stores microseconds: two rows written in the
 * same millisecond would round to the same cursor position, and the strictly-less-than comparison
 * would then skip whichever of them had the smaller timestamp. Selecting the value as text keeps
 * the exact microsecond the database compares against.
 *
 * The cursor is decoded strictly. A malformed cursor is a validation error, never "start from the
 * beginning": silently restarting would return duplicates that a client cannot detect.
 */

const CURSOR_SEPARATOR = '\u0000';

export interface CursorPosition {
  /** Exact `created_at`, as an ISO-8601 string; microsecond precision is preserved. */
  readonly createdAt: string;
  readonly id: string;
}

/**
 * The shape {@link toPage} needs from a row.
 *
 * `cursorAt` is the row's exact `created_at` as an ISO-8601 string, selected alongside the entity
 * by the list queries. It is deliberately kept off the entity: only the repository's list rows can
 * build a cursor, and the value never reaches an API response.
 *
 * The matching SQL expression is:
 *   `to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
 * — six fractional-second digits (microseconds) and a `Z`, exactly what `timestamptz` accepts back.
 */
export interface PageableRow {
  readonly id: string;
  readonly cursorAt: string;
}

export function encodeCursor(position: CursorPosition): string {
  const raw = `${position.createdAt}${CURSOR_SEPARATOR}${position.id}`;
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

  const createdAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (Number.isNaN(new Date(createdAt).getTime()) || id === '') {
    throw new AppError('VALIDATION_FAILED', { detail: 'The pagination cursor is not valid.' });
  }

  return { createdAt, id };
}

/**
 * Builds the page envelope: fetch one row more than requested, and use its presence only to decide
 * whether a next page exists. The extra row is never returned.
 */
export function toPage<T extends PageableRow>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  if (last === undefined) return { items: [], nextCursor: null };
  return { items, nextCursor: encodeCursor({ createdAt: last.cursorAt, id: last.id }) };
}
