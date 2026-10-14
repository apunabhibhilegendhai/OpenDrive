import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from './range.js';

describe('parseRangeHeader', () => {
  it('returns null when there is no usable range', () => {
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader('', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=-', 1000)).toBeNull();
    expect(parseRangeHeader('items=0-1', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=0-1,5-6', 1000)).toBeNull();
  });

  it('parses a bounded range, an open range and a suffix range', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, endInclusive: 99 });
    expect(parseRangeHeader('bytes=100-', 1000)).toEqual({ start: 100, endInclusive: 999 });
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, endInclusive: 999 });
  });

  it('clamps an end past the object and a suffix longer than the object', () => {
    expect(parseRangeHeader('bytes=0-99999', 1000)).toEqual({ start: 0, endInclusive: 999 });
    expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ start: 0, endInclusive: 999 });
  });

  it('trims surrounding space and accepts an upper-case unit', () => {
    expect(parseRangeHeader(' bytes=0-9 ', 1000)).toEqual({ start: 0, endInclusive: 9 });
    expect(parseRangeHeader('BYTES=0-9', 1000)).toEqual({ start: 0, endInclusive: 9 });
  });

  it('reports a range outside the object as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=1000-2000', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=500-100', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
