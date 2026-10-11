import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';
import { isAppError } from '@opendrive/shared';
import { createAccessTokenVerifier } from './tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Access-token verification.
 *
 * These tests sign real tokens with real keys and assert what the verifier refuses, because the
 * interesting behaviour of a token verifier is almost entirely about refusals: an expired token, a
 * token from another issuer, a token signed by a key it does not know, and — most importantly — the
 * Supabase `service_role` token, which must never be accepted as a user identity.
 */

const SECRET = 'test-secret-with-enough-entropy-for-hs256';
const ISSUER = 'https://supabase.example.com/auth/v1';
const AUDIENCE = 'authenticated';

function authConfig(overrides: Partial<ApiConfig['auth']> = {}): ApiConfig['auth'] {
  return {
    configured: true,
    jwtSecret: SECRET,
    jwksUrl: null,
    issuer: ISSUER,
    audience: AUDIENCE,
    ...overrides,
  };
}

async function signHs256(
  claims: Record<string, unknown> = {},
  options: { expiresIn?: number; issuer?: string | null; audience?: string; secret?: string } = {},
): Promise<string> {
  const expiresIn = options.expiresIn ?? 3600;
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({ role: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(
      typeof claims.sub === 'string' ? claims.sub : 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33',
    )
    .setIssuedAt(now)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(now + expiresIn);
  if (options.issuer !== null) builder = builder.setIssuer(options.issuer ?? ISSUER);
  return builder.sign(new TextEncoder().encode(options.secret ?? SECRET));
}

describe('supabase access token verification', () => {
  it('accepts a well-formed token and reports the identity it proves', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    const verified = await verifier.verify(await signHs256());
    expect(verified.userId).toBe('b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33');
    expect(verified.role).toBe('authenticated');
    expect(verified.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses an expired token', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    const token = await signHs256({}, { expiresIn: -60 });
    await expect(verifier.verify(token)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'UNAUTHENTICATED',
    );
  });

  it('refuses a token signed with a different secret', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    await expect(
      verifier.verify(await signHs256({}, { secret: 'some-other-secret' })),
    ).rejects.toThrow(/not valid/);
  });

  it('refuses a token from another issuer or for another audience', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    await expect(
      verifier.verify(await signHs256({}, { issuer: 'https://evil.example.com/auth/v1' })),
    ).rejects.toThrow(/not valid/);
    await expect(verifier.verify(await signHs256({}, { audience: 'other' }))).rejects.toThrow(
      /not valid/,
    );
  });

  it('refuses a token with no issuer when an issuer is configured', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    await expect(verifier.verify(await signHs256({}, { issuer: null }))).rejects.toThrow(
      /not valid/,
    );
  });

  it('refuses the service_role token, which is the Supabase secret key', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    const token = await signHs256({ role: 'service_role' });
    const error = await verifier.verify(token).catch((caught: unknown) => caught);
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.detail).toContain('authenticated');
  });

  it('refuses a token with no subject', async () => {
    const verifier = createAccessTokenVerifier(authConfig());
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifier.verify(token)).rejects.toThrow(/not valid/);
  });

  it('refuses an unsigned (alg: none) token and a malformed one', async () => {
    // `alg: none` is the oldest JWT attack there is: the refusal names the algorithm rather than
    // pretending the token was merely unverifiable.
    const verifier = createAccessTokenVerifier(authConfig());
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'x', role: 'authenticated', exp: now + 60 })).toString(
        'base64url',
      ),
      '',
    ].join('.');
    await expect(verifier.verify(unsigned)).rejects.toThrow(/unsupported signing algorithm/);
    await expect(verifier.verify('not-a-jwt')).rejects.toThrow(/well-formed/);
  });

  it('refuses an HS256 token when only a JWKS endpoint is configured', async () => {
    // Algorithm/key-source confusion: the verifier picks the key source from the header but never
    // lets the header decide *whether* the token is acceptable.
    const verifier = createAccessTokenVerifier(
      authConfig({ jwtSecret: null, jwksUrl: 'http://127.0.0.1:9/jwks.json' }),
    );
    const error = await verifier.verify(await signHs256()).catch((caught: unknown) => caught);
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.detail).toContain('signing key this deployment does not accept');
  });

  it('refuses everything with 503 when no key source is configured', async () => {
    const verifier = createAccessTokenVerifier(
      authConfig({ configured: false, jwtSecret: null, jwksUrl: null }),
    );
    expect(verifier.configured).toBe(false);
    const error = await verifier.verify(await signHs256()).catch((caught: unknown) => caught);
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.status).toBe(503);
  });
});

describe('asymmetric verification through a JWKS endpoint', () => {
  let server: ReturnType<typeof createServer>;
  let jwksUrl = '';
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    publicJwk = {
      ...(await exportJWK(keyPair.publicKey)),
      kid: 'test-key-1',
      alg: 'RS256',
      use: 'sig',
    };

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;
  });

  afterAll(() => {
    server.close();
  });

  it('verifies an RS256 token against a fetched JWKS document', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject('b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const verifier = createAccessTokenVerifier(authConfig({ jwtSecret: null, jwksUrl }));
    const verified = await verifier.verify(token);
    expect(verified.userId).toBe('b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33');
  });

  it('refuses an RS256 token signed by a key the JWKS document does not contain', async () => {
    const other = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject('b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(now + 3600)
      .sign(other.privateKey);

    const verifier = createAccessTokenVerifier(authConfig({ jwtSecret: null, jwksUrl }));
    await expect(verifier.verify(token)).rejects.toThrow(/not valid/);
  });
});
