import { describe, expect, it } from 'vitest';
import { formatBytes, formatClockTime, verifiedShare } from './format.js';

describe('formatBytes', () => {
  it('formats storage sizes for the console', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GiB');
    expect(formatBytes(8 * 1024 ** 2)).toBe('8.00 MiB');
    expect(formatBytes(64 * 1024 ** 2)).toBe('64.0 MiB');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(-5)).toBe('unknown');
  });
});

describe('formatClockTime', () => {
  it('renders a local time and refuses invalid input', () => {
    expect(formatClockTime('2026-10-10T12:34:56.000Z')).not.toBe('unknown');
    expect(formatClockTime('not-a-date')).toBe('unknown');
  });
});

describe('verifiedShare', () => {
  it('is zero while nothing has been verified', () => {
    expect(verifiedShare({ maxFileSizeBytes: 2147483648, maxFileSizeVerified: false })).toBe(0);
    expect(verifiedShare({ maxFileSizeBytes: 2147483648, maxFileSizeVerified: true })).toBe(100);
  });
});
