import { describe, expect, it } from 'vitest';
import { createDeliverySigner } from './delivery-tokens.js';
import { createPreviewSigner } from './preview-tokens.js';

const SECRET = 'a-test-delivery-secret-value';
const FILE_ID = 'file_00000000000000000000000001';
const VERSION = 'sobj_00000000000000000000000001';
const NOW = new Date('2026-10-14T12:00:00.000Z');

function signer(overrides: { secret?: string | null; ttlSeconds?: number } = {}) {
  return createDeliverySigner({
    secret: overrides.secret === undefined ? SECRET : overrides.secret,
    ttlSeconds: overrides.ttlSeconds ?? 3600,
  });
}

describe('delivery tokens', () => {
  it('is unconfigured without a secret, so delivery fails closed', () => {
    expect(signer({ secret: null })).toBeNull();
    expect(signer({ secret: '   ' })).toBeNull();
    expect(signer({ secret: '' })).toBeNull();
  });

  it('mints a token that verifies for the file, version and expiry it names', () => {
    const tokens = signer();
    expect(tokens).not.toBeNull();
    const grant = tokens!.mint(FILE_ID, VERSION, NOW);

    expect(grant.expiresAt.toISOString()).toBe('2026-10-14T13:00:00.000Z');
    expect(tokens!.verify(grant.token, NOW)).toEqual({
      fileId: FILE_ID,
      version: VERSION,
      expiresAt: new Date('2026-10-14T13:00:00.000Z'),
    });
    // Still valid one second before the expiry.
    expect(tokens!.verify(grant.token, new Date(grant.expiresAt.getTime() - 1000))).not.toBeNull();
  });

  it('refuses a token once it has expired', () => {
    const tokens = signer({ ttlSeconds: 60 })!;
    const grant = tokens.mint(FILE_ID, VERSION, NOW);
    expect(tokens.verify(grant.token, NOW)).not.toBeNull();
    expect(tokens.verify(grant.token, new Date(NOW.getTime() + 61_000))).toBeNull();
  });

  it('binds the token to one object version, so re-uploaded bytes cannot reuse it', () => {
    const tokens = signer()!;
    const grant = tokens.mint(FILE_ID, VERSION, NOW);
    // The claims carry the version; the route is what refuses a mismatch. The token itself is
    // version-specific: a token minted for another version is a different token.
    const other = tokens.mint(FILE_ID, 'sobj_00000000000000000000000002', NOW);
    expect(grant.token).not.toBe(other.token);
    expect(tokens.verify(grant.token, NOW)?.version).toBe(VERSION);
  });

  it('refuses a tampered or malformed token', () => {
    const tokens = signer()!;
    const grant = tokens.mint(FILE_ID, VERSION, NOW);
    const [payload, mac] = grant.token.split('.') as [string, string];

    // Flip the final hex digit so the signature is always wrong, never coincidentally equal.
    const flipped = mac.slice(0, -1) + (mac.endsWith('0') ? '1' : '0');
    expect(tokens.verify(`${payload}.${flipped}`, NOW)).toBeNull();
    expect(tokens.verify(grant.token, NOW)).not.toBeNull();

    for (const bad of ['', '.', 'no-dot', `${payload}.`, `.${mac}`, 'not.a.token.at.all']) {
      expect(tokens.verify(bad, NOW), bad).toBeNull();
    }
  });

  it('refuses a token signed under a different secret', () => {
    const grant = signer({ secret: 'one-secret' })!.mint(FILE_ID, VERSION, NOW);
    expect(signer({ secret: 'another-secret' })!.verify(grant.token, NOW)).toBeNull();
  });

  it('cannot be substituted for a preview token: the key domains are distinct', () => {
    // Same secret, different HKDF `info`, so the two signers hold different keys. A token from one
    // surface must never verify on the other, even though the `payload.mac` framing is identical.
    const secret = 'shared-secret';
    const delivery = createDeliverySigner({ secret, ttlSeconds: 3600 })!;
    const preview = createPreviewSigner({ secret, ttlSeconds: 3600 })!;

    const deliveryGrant = delivery.mint(FILE_ID, VERSION, NOW);
    const previewGrant = preview.mint(FILE_ID, NOW);

    // Deterministic for the same inputs, so a retried mint is stable...
    expect(delivery.mint(FILE_ID, VERSION, NOW).token).toBe(deliveryGrant.token);
    // ...but the two surfaces are not interchangeable in either direction.
    expect(preview.verify(deliveryGrant.token, FILE_ID, NOW)).toBe(false);
    expect(delivery.verify(previewGrant.token, NOW)).toBeNull();
  });

  it('encodes the payload so the separator cannot be smuggled through an id', () => {
    const grant = signer()!.mint(FILE_ID, VERSION, NOW);
    // The token is exactly `payload.signature`; the payload's base64url alphabet has no dot.
    expect(grant.token.split('.')).toHaveLength(2);
  });
});
