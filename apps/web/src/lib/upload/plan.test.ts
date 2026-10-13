import { describe, expect, it } from 'vitest';
import { planForFile, planParts, type UploadLimits } from './plan.js';

/**
 * The upload planner decides what the UI promises before a byte moves.
 *
 * These tests use the real numbers this deployment publishes: a 1 MiB floor, a 2,000,000,000-byte
 * part ceiling (the Local Bot API server's limit) and a 5 GiB file ceiling.
 */
const limits: UploadLimits = {
  maxFileSizeBytes: 5 * 1024 ** 3,
  chunkSizeBytes: 8 * 1024 ** 2,
  minChunkSizeBytes: 1024 ** 2,
  maxChunkSizeBytes: 2_000_000_000,
  maxPartsPerUpload: 10_000,
};

describe('planParts', () => {
  it('covers the whole object with contiguous parts', () => {
    const parts = planParts(20, 8, 10);
    expect(parts).toEqual([
      { partNumber: 1, start: 0, end: 8, sizeBytes: 8 },
      { partNumber: 2, start: 8, end: 16, sizeBytes: 8 },
      { partNumber: 3, start: 16, end: 20, sizeBytes: 4 },
    ]);
  });

  it('numbers parts from one, because the API does', () => {
    expect(planParts(4, 8, 10).map((part) => part.partNumber)).toEqual([1]);
  });

  it('stops at the part ceiling rather than emitting more parts than the API accepts', () => {
    expect(planParts(100, 8, 3)).toHaveLength(3);
  });
});

describe('planForFile', () => {
  it('accepts a file at exactly the ceiling', () => {
    const result = planForFile(limits.maxFileSizeBytes, limits);
    expect(result.ok).toBe(true);
  });

  it('refuses a file above the ceiling, naming the ceiling in the reason', () => {
    const result = planForFile(limits.maxFileSizeBytes + 1, limits);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('5.00 GiB');
  });

  it('refuses an empty file instead of sending a zero-byte part', () => {
    expect(planForFile(0, limits)).toEqual({
      ok: false,
      reason: 'An empty file has nothing to upload.',
    });
  });

  it('pauses when the API reports a part size outside its own range', () => {
    const result = planForFile(1024, { ...limits, chunkSizeBytes: 512 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'part size outside its own allowed range',
    );
  });

  it('refuses when the part count needed exceeds the API ceiling', () => {
    const result = planForFile(4 * 1024 ** 2, {
      ...limits,
      chunkSizeBytes: 1024 ** 2,
      maxPartsPerUpload: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'more than the 2 this deployment accepts',
    );
  });

  it('splits a multi-gigabyte object into the fewest parts the part ceiling allows', () => {
    // 4 GB at the provider's 2,000,000,000-byte part ceiling: two parts, not four.
    const result = planForFile(4 * 1024 ** 3, { ...limits, chunkSizeBytes: 2_000_000_000 });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.parts).toHaveLength(3);
    expect(result.ok === true && result.parts.map((part) => part.sizeBytes)).toEqual([
      2_000_000_000, 2_000_000_000, 294_967_296,
    ]);
  });
});
