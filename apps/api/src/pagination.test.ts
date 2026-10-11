import { describe, expect, it } from 'vitest';
import { isAppError } from '@opendrive/shared';
import { decodeCursor, encodeCursor, toPage } from './pagination.js';

/** A position with microsecond precision, as the database returns it. */
const createdAt = '2026-10-11T12:00:00.123456Z';
const id = 'file_0123456789012345678901234a';

function row(offsetSeconds: number, rowId: string): { cursorAt: string; id: string } {
  return {
    cursorAt: new Date(new Date(createdAt).getTime() + offsetSeconds * 1000).toISOString(),
    id: rowId,
  };
}

describe('pagination cursors', () => {
  it('round-trips a position, preserving microsecond precision', () => {
    expect(decodeCursor(encodeCursor({ createdAt, id }))).toEqual({ createdAt, id });
  });

  it('produces an opaque value that does not disclose the row id in plain text', () => {
    const cursor = encodeCursor({ createdAt, id });
    expect(cursor).not.toContain(id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a malformed cursor instead of restarting from the beginning', () => {
    for (const value of ['', 'not-base64!!', Buffer.from('no-separator').toString('base64url')]) {
      const error = (() => {
        try {
          decodeCursor(value);
        } catch (caught) {
          return caught;
        }
        throw new Error('expected a refusal');
      })();
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('page assembly', () => {
  it('returns no cursor when the page is the last one', () => {
    const page = toPage([row(0, 'a'), row(-1, 'b')], 5);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('uses the extra row only to decide that more exist, never returning it', () => {
    const page = toPage([row(0, 'a'), row(-1, 'b'), row(-2, 'c')], 2);
    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe(encodeCursor({ createdAt: row(-1, 'b').cursorAt, id: 'b' }));
  });

  it('handles an exactly-full final page', () => {
    const page = toPage([row(0, 'a'), row(-1, 'b')], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    expect(toPage([], 20)).toEqual({ items: [], nextCursor: null });
  });
});
