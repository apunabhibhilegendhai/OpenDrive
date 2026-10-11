import { describe, expect, it } from 'vitest';
import { ID_KINDS, isIdOfKind, newId, parseId } from './ids.js';

describe('identifiers', () => {
  it('prefixes every id with its resource kind', () => {
    for (const kind of Object.keys(ID_KINDS) as (keyof typeof ID_KINDS)[]) {
      const id = newId(kind);
      expect(id.startsWith(`${ID_KINDS[kind]}_`)).toBe(true);
      const parsed = parseId(id);
      expect(parsed?.kind).toBe(kind);
      expect(parsed?.suffix).toHaveLength(26);
      expect(isIdOfKind(id, kind)).toBe(true);
    }
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('file')));
    expect(ids.size).toBe(2000);
  });

  it('is URL-safe and free of ambiguous characters', () => {
    const id = newId('share');
    expect(id).toMatch(/^shr_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it('rejects malformed or tampered ids', () => {
    expect(parseId('file_short')).toBeNull();
    expect(parseId('nope_0123456789012345678901234a')).toBeNull();
    expect(parseId('file_0123456789012345678901234i')).toBeNull(); // 'i' is not in the alphabet
    expect(parseId('file_0123456789012345678901234A')).toBeNull(); // uppercase is not emitted
    expect(isIdOfKind(newId('file'), 'share')).toBe(false);
  });
});
