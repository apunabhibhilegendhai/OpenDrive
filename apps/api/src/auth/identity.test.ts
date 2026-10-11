import { describe, expect, it } from 'vitest';
import { isAppError } from '@opendrive/shared';
import { parseBearerToken, readPresentedCredentials, resolveRequestIdentity } from './identity.js';
import type { RequestIdentity } from './identity.js';
import { createAccessTokenVerifier } from './tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Credential handling, without a database.
 *
 * Everything here is about refusing: an unrecognised credential, a duplicated one, a wrong scheme,
 * and a deployment that cannot check anything at all. The database-backed paths are exercised in
 * `tests/integration`, where a real Postgres is available.
 */

const unconfiguredVerifier = createAccessTokenVerifier({
  configured: false,
  jwtSecret: null,
  jwksUrl: null,
  issuer: null,
  audience: 'authenticated',
} satisfies ApiConfig['auth']);

function resolve(headers: Record<string, unknown>): Promise<RequestIdentity> {
  return resolveRequestIdentity(headers, { sql: null, verifier: unconfiguredVerifier });
}

async function refusal(
  headers: Record<string, unknown>,
): Promise<{ code: string; status: number; detail: string }> {
  const outcome = await resolve(headers).catch((error: unknown) => error);
  if (!isAppError(outcome)) throw new Error(`expected an AppError, received ${String(outcome)}`);
  return { code: outcome.code, status: outcome.status, detail: outcome.detail };
}

describe('credential extraction', () => {
  it('reads a bearer token and an API key header', () => {
    expect(readPresentedCredentials({ authorization: 'Bearer abc' })).toEqual({
      authorization: 'Bearer abc',
      apiKey: null,
    });
    expect(readPresentedCredentials({ 'x-api-key': 'odk_x_y' })).toEqual({
      authorization: null,
      apiKey: 'odk_x_y',
    });
  });

  it('treats blank headers as absent', () => {
    expect(readPresentedCredentials({ authorization: '   ', 'x-api-key': '' })).toEqual({
      authorization: null,
      apiKey: null,
    });
  });

  it('refuses two credentials rather than preferring one', () => {
    expect(() =>
      readPresentedCredentials({ authorization: 'Bearer abc', 'x-api-key': 'odk_x_y' }),
    ).toThrow(/exactly one credential/);
  });

  it('accepts only the Bearer scheme, case-insensitively', () => {
    expect(parseBearerToken('Bearer abc')).toBe('abc');
    expect(parseBearerToken('bearer   abc  ')).toBe('abc');
    for (const value of ['Basic abc', 'Token abc', 'Bearer', 'Bearer    ']) {
      expect(() => parseBearerToken(value), value).toThrow(/Bearer/);
    }
  });
});

describe('identity resolution without a credential', () => {
  it('reports no identity rather than an anonymous one', async () => {
    await expect(resolve({})).resolves.toEqual({ kind: 'none' });
  });
});

describe('identity resolution refusals', () => {
  it('refuses a credential it cannot classify', async () => {
    const result = await refusal({ authorization: 'Bearer something-opaque' });
    expect(result.code).toBe('UNAUTHENTICATED');
    expect(result.status).toBe(401);
    expect(result.detail).toContain('ods_');
  });

  it('refuses a malformed API key shape', async () => {
    const result = await refusal({ 'x-api-key': 'odk_short_nope' });
    expect(result.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a well-formed session credential when the database is not configured', async () => {
    // Fail closed: an unverifiable credential is never accepted, and the caller is told the
    // service — not the credential — is unavailable.
    const result = await refusal({
      authorization: 'Bearer ods_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.status).toBe(503);
  });

  it('refuses a well-formed API key when the database is not configured', async () => {
    const result = await refusal({
      authorization: 'Bearer odk_4zrp37hg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('refuses a JWT when no verification key is configured, without decoding it as identity', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33', role: 'authenticated' }),
    ).toString('base64url');
    // The token establishes nothing; the refusal comes before any identity is derived.
    const result = await refusal({ authorization: `Bearer ${header}.${payload}.signature` });
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
  });
});
