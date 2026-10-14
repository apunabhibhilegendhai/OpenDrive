import { describe, expect, it } from 'vitest';
import { createPreviewSigner } from './preview-tokens.js';

const SECRET = 'a-test-preview-secret-value';
const FILE_ID = 'file_00000000000000000000000001';
const NOW = new Date('2026-10-14T12:00:00.000Z');

function signer(overrides: { secret?: string | null; ttlSeconds?: number } = {}) {
  return createPreviewSigner({
    secret: overrides.secret === undefined ? SECRET : overrides.secret,
    ttlSeconds: overrides.ttlSeconds ?? 3600,
  });
}

describe('preview tokens', () => {
  it('is unconfigured without a secret, so previews fail closed', () => {
    expect(signer({ secret: null })).toBeNull();
    expect(signer({ secret: '   ' })).toBeNull();
    expect(signer({ secret: '' })).toBeNull();
  });

  it('mints a token that verifies for the file and expiry it names', () => {
    const tokens = signer();
    expect(tokens).not.toBeNull();
    const grant = tokens!.mint(FILE_ID, NOW);

    expect(grant.expiresAt.toISOString()).toBe('2026-10-14T13:00:00.000Z');
    expect(tokens!.verify(grant.token, FILE_ID, NOW)).toBe(true);
    // Still valid one second before the expiry...
    expect(tokens!.verify(grant.token, FILE_ID, new Date(grant.expiresAt.getTime() - 1000))).toBe(
      true,
    );
  });

  it('refuses a token once it has expired', () => {
    const grant = signer({ ttlSeconds: 60 })!.mint(FILE_ID, NOW);
    expect(signer({ ttlSeconds: 60 })!.verify(grant.token, FILE_ID, NOW)).toBe(true);
    expect(
      signer({ ttlSeconds: 60 })!.verify(grant.token, FILE_ID, new Date(NOW.getTime() + 61_000)),
    ).toBe(false);
  });

  it('refuses a token minted for a different file', () => {
    const grant = signer()!.mint(FILE_ID, NOW);
    expect(signer()!.verify(grant.token, 'file_00000000000000000000000002', NOW)).toBe(false);
  });

  it('refuses a tampered or malformed token', () => {
    const grant = signer()!.mint(FILE_ID, NOW);
    const [payload, mac] = grant.token.split('.') as [string, string];

    // Flip the final hex digit so the signature is always wrong, never coincidentally equal.
    const flipped = mac.slice(0, -1) + (mac.endsWith('0') ? '1' : '0');
    expect(signer()!.verify(`${payload}.${flipped}`, FILE_ID, NOW)).toBe(false);
    expect(signer()!.verify(grant.token, FILE_ID, NOW)).toBe(true);

    for (const bad of ['', '.', 'no-dot', `${payload}.`, `.${mac}`, 'not.a.token.at.all']) {
      expect(signer()!.verify(bad, FILE_ID, NOW), bad).toBe(false);
    }
  });

  it('refuses a token signed under a different secret', () => {
    const grant = signer({ secret: 'one-secret' })!.mint(FILE_ID, NOW);
    expect(signer({ secret: 'another-secret' })!.verify(grant.token, FILE_ID, NOW)).toBe(false);
  });

  it('encodes the payload so the separator cannot be smuggled through a file id', () => {
    const grant = signer()!.mint(FILE_ID, NOW);
    // The token is exactly `payload.signature`; the payload's base64url alphabet has no dot.
    expect(grant.token.split('.')).toHaveLength(2);
  });
});
