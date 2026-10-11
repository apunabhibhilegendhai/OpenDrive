import { describe, expect, it } from 'vitest';
import { newOpaqueToken, sha256Hex, sha256HexOfBytes, tokensEqual } from './tokens.js';

describe('opaque tokens', () => {
  it('produces URL-safe tokens with at least 256 bits of entropy', () => {
    const token = newOpaqueToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('produces distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newOpaqueToken()));
    expect(tokens.size).toBe(1000);
  });

  it('honours a custom byte length', () => {
    expect(newOpaqueToken(16)).toHaveLength(22);
  });
});

describe('sha256Hex', () => {
  it('matches the published test vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the published test vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces a stable 64-character lowercase hex digest', async () => {
    const digest = await sha256Hex('opendrive');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('opendrive')).toBe(digest);
  });
});

describe('sha256HexOfBytes', () => {
  it('hashes bytes identically to their UTF-8 string form', async () => {
    expect(await sha256HexOfBytes(new TextEncoder().encode('abc'))).toBe(await sha256Hex('abc'));
  });
});

describe('tokensEqual', () => {
  it('accepts identical values and rejects different ones', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', '')).toBe(true);
    expect(tokensEqual(newOpaqueToken(), newOpaqueToken())).toBe(false);
  });
});
