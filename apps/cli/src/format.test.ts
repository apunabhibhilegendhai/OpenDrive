import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration } from './format.js';

describe('formatBytes', () => {
  it('formats the documented limits', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GiB');
    expect(formatBytes(8 * 1024 ** 2)).toBe('8.00 MiB');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('refuses to print nonsense', () => {
    expect(formatBytes(-1)).toBe('unknown');
    expect(formatBytes(Number.NaN)).toBe('unknown');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(3725)).toBe('1h 02m 05s');
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });
});
