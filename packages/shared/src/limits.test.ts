import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  GIB,
  MAX_PARTS_PER_UPLOAD,
  TARGET_MAX_FILE_SIZE_BYTES,
  checkChunkSize,
  checkFileSize,
  partCount,
  resolveLimits,
} from './limits.js';

describe('resolveLimits', () => {
  it('returns documented defaults when the environment is empty', () => {
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.maxFileSizeBytes).toBe(TARGET_MAX_FILE_SIZE_BYTES);
    expect(DEFAULT_LIMITS.maxFileSizeVerified).toBe(false);
  });

  it('reads overrides from the environment', () => {
    const limits = resolveLimits({
      STORAGE_MAX_FILE_SIZE_BYTES: String(100 * 1024 * 1024),
      STORAGE_CHUNK_SIZE_BYTES: String(4 * 1024 * 1024),
      ANONYMOUS_UPLOADS_PER_DAY: '5',
      MALWARE_SCAN_ENABLED: 'true',
    });
    expect(limits.maxFileSizeBytes).toBe(100 * 1024 * 1024);
    expect(limits.chunkSizeBytes).toBe(4 * 1024 * 1024);
    expect(limits.anonymousUploadsPerDay).toBe(5);
    expect(limits.malwareScanEnabled).toBe(true);
  });

  it('rejects invalid configuration instead of silently defaulting', () => {
    expect(() => resolveLimits({ STORAGE_CHUNK_SIZE_BYTES: 'lots' })).toThrow(/positive integer/);
    expect(() => resolveLimits({ STORAGE_CHUNK_SIZE_BYTES: '-1' })).toThrow(/positive integer/);
    expect(() => resolveLimits({ MALWARE_SCAN_ENABLED: 'yes' })).toThrow(/true.*false/);
    expect(() => resolveLimits({ STORAGE_MAX_FILE_SIZE_BYTES: String(50 * GIB) })).toThrow(
      /Invalid limits configuration/,
    );
    expect(() => resolveLimits({ STORAGE_CHUNK_SIZE_BYTES: '128' })).toThrow(
      /Invalid limits configuration/,
    );
  });

  it('never claims the target size is verified by default', () => {
    expect(
      resolveLimits({ STORAGE_MAX_FILE_SIZE_BYTES: String(2 * GIB) }).maxFileSizeVerified,
    ).toBe(false);
  });
});

describe('size validation', () => {
  it('accepts a file at exactly the configured ceiling', () => {
    const limits = { ...DEFAULT_LIMITS, chunkSizeBytes: 8 * 1024 * 1024 };
    expect(checkFileSize(TARGET_MAX_FILE_SIZE_BYTES, limits).ok).toBe(true);
    expect(checkFileSize(TARGET_MAX_FILE_SIZE_BYTES + 1, limits).ok).toBe(false);
    expect(checkFileSize(0, limits).ok).toBe(false);
    expect(partCount(TARGET_MAX_FILE_SIZE_BYTES, limits.chunkSizeBytes)).toBe(256);
  });

  it('enforces the part ceiling for configurations that would exceed it', () => {
    // With the sanctioned defaults (2 GiB target, >= 1 MiB chunks) the file-size ceiling
    // binds first and the part ceiling is a backstop. It must still fire if a future
    // provider forces a smaller chunk size.
    const pathological = { ...DEFAULT_LIMITS, chunkSizeBytes: 64 * 1024, maxFileSizeBytes: GIB };
    const parts = partCount(pathological.maxFileSizeBytes, pathological.chunkSizeBytes);
    expect(parts).toBeGreaterThan(MAX_PARTS_PER_UPLOAD);
    const result = checkFileSize(pathological.maxFileSizeBytes, pathological);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/part ceiling/);
  });

  it('allows the full 2 GiB target at the smallest sanctioned chunk size', () => {
    const limits = { ...DEFAULT_LIMITS, chunkSizeBytes: 1024 * 1024 };
    expect(partCount(limits.maxFileSizeBytes, limits.chunkSizeBytes)).toBeLessThanOrEqual(
      MAX_PARTS_PER_UPLOAD,
    );
    expect(checkFileSize(limits.maxFileSizeBytes, limits).ok).toBe(true);
  });

  it('checks individual parts against the chunk size', () => {
    const limits = { ...DEFAULT_LIMITS, chunkSizeBytes: 8 * 1024 * 1024 };
    expect(checkChunkSize(8 * 1024 * 1024, limits).ok).toBe(true);
    expect(checkChunkSize(8 * 1024 * 1024 + 1, limits).ok).toBe(false);
  });
});
