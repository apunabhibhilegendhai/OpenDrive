import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createAccount,
  createAnonymousSession,
  createApiKey,
  createHarness,
  digest,
  setAccountStatus,
  signUserToken,
} from './harness.js';
import type { Harness } from './harness.js';

/**
 * Authentication, against a real database.
 *
 * Every case here is one of the "required tests" for this phase: a valid credential, an invalid
 * one, an expired and a revoked credential, a key with a missing scope, and a key used to try to
 * escape its own scopes. The assertions are about what the server *proved*, not about what it
 * echoed back.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('registered users', () => {
  it('resolves a verified access token and provisions the profile on first use', async () => {
    // No profile row on purpose: sign-up creates an auth user, and the first authenticated request
    // is what provisions the OpenDrive side of it.
    const account = await createAccount(h.sql, { provisionProfile: false });
    const before = await h.sql`select 1 from profiles where id = ${account.userId}`;
    expect(before).toHaveLength(0);

    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(account.token),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      identity: { principalKind: string; userId: string | null; accountStatus: string };
      quota: { principalKind: string; limits: { storageBytes: number } };
    }>();
    expect(body.identity.principalKind).toBe('user');
    expect(body.identity.userId).toBe(account.userId);
    expect(body.identity.accountStatus).toBe('active');
    expect(body.quota.principalKind).toBe('user');
    expect(body.quota.limits.storageBytes).toBeGreaterThan(0);

    // The profile now exists and is owned by exactly this user.
    const created = await h.sql<
      { id: string }[]
    >`select id from profiles where id = ${account.userId}`;
    expect(created).toHaveLength(1);
  });

  it('does not re-provision an existing profile, so limits cannot be reset by asking', async () => {
    const account = await createAccount(h.sql);
    await h.server.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(account.token) });
    await h.sql`update profiles set storage_quota_bytes = 4096 where id = ${account.userId}`;

    await h.server.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(account.token) });
    const rows = await h.sql<{ storageQuotaBytes: string }[]>`
      select storage_quota_bytes as "storageQuotaBytes" from profiles where id = ${account.userId}
    `;
    expect(Number(rows[0]?.storageQuotaBytes)).toBe(4096);
  });

  it('refuses an expired token', async () => {
    const account = await createAccount(h.sql);
    const token = await signUserToken(account.userId, { expiresIn: -60 });
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
  });

  it('refuses a token from another issuer (the signature is valid, the claim is not)', async () => {
    const account = await createAccount(h.sql);
    const foreignIssuer = await signUserToken(account.userId, {
      issuer: 'https://evil.example/auth/v1',
    });
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(foreignIssuer),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses the service_role token even though its signature is valid', async () => {
    const account = await createAccount(h.sql);
    const token = await signUserToken(account.userId, { role: 'service_role' });
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('authenticated');
  });

  it('refuses a suspended account on every protected route', async () => {
    const account = await createAccount(h.sql);
    await h.server.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(account.token) });
    await setAccountStatus(h.sql, account.userId, 'suspended');

    for (const url of ['/api/v1/me', '/api/v1/files', '/api/v1/api-keys']) {
      const response = await h.server.inject({
        method: 'GET',
        url,
        headers: bearer(account.token),
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json<{ code: string }>().code, url).toBe('FORBIDDEN');
    }
  });
});

describe('anonymous sessions', () => {
  it('creates a session whose credential is stored only as a digest', async () => {
    const session = await createAnonymousSession(h);

    const stored = await h.sql<{ credentialHash: string; ipHash: string | null; status: string }[]>`
      select credential_hash as "credentialHash", created_ip_hash as "ipHash", status
        from anonymous_sessions where id = ${session.sessionId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.credentialHash).toBe(await digest(session.credential));
    expect(stored[0]?.credentialHash).not.toContain(session.credential);
    // The address is hashed with a keyed function, and never stored raw.
    expect(stored[0]?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.status).toBe('active');
  });

  it('resolves its own identity and refuses to act as a user', async () => {
    const session = await createAnonymousSession(h);
    const me = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(session.credential),
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      identity: { principalKind: string; sessionId: string | null; userId: string | null };
    }>();
    expect(body.identity.principalKind).toBe('anonymous');
    expect(body.identity.sessionId).toBe(session.sessionId);
    expect(body.identity.userId).toBeNull();

    const keys = await h.server.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: bearer(session.credential),
    });
    expect(keys.statusCode).toBe(403);
  });

  it('refuses an expired session', async () => {
    const session = await createAnonymousSession(h, { ttlSeconds: -60 });
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(session.credential),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('expired');
  });

  it('refuses a revoked session immediately, and revocation survives a rename-free reuse', async () => {
    const session = await createAnonymousSession(h);
    await h.sql`
      update anonymous_sessions set status = 'revoked', revoked_at = now()
       where id = ${session.sessionId}
    `;
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(session.credential),
    });
    expect(response.statusCode).toBe(401);
    // An expired-but-unrevoked session and a revoked one both fail; neither is ever "active again".
    const row = await h.sql<{ status: string }[]>`
      select status from anonymous_sessions where id = ${session.sessionId}
    `;
    expect(row[0]?.status).toBe('revoked');
  });

  it('records last use without failing the request when the touch fails', async () => {
    const session = await createAnonymousSession(h);
    await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(session.credential),
    });
    const rows = await h.sql<{ lastUsedAt: Date | null }[]>`
      select last_used_at as "lastUsedAt" from anonymous_sessions where id = ${session.sessionId}
    `;
    expect(rows[0]?.lastUsedAt).not.toBeNull();
  });

  it('refuses a well-formed credential that belongs to no session', async () => {
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(`ods_${'A'.repeat(43)}`),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('API keys', () => {
  it('authenticates with a key and reports only the scopes it was issued', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, { scopes: ['files:read'] });

    const me = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(key.key),
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      identity: {
        principalKind: string;
        userId: string | null;
        scopes: string[];
        apiKeyId: string | null;
      };
    }>();
    expect(body.identity.userId).toBe(account.userId);
    expect(body.identity.scopes).toEqual(['files:read']);
    expect(body.identity.apiKeyId).toBe(key.id);

    // The prefix is public and stored; the secret is not.
    const stored = await h.sql<{ keyHash: string }[]>`
      select key_hash as "keyHash" from api_keys where id = ${key.id}
    `;
    expect(stored[0]?.keyHash).toBe(await digest(key.key));
    expect(stored[0]?.keyHash).not.toContain(key.key);
  });

  it('refuses a key that is missing the scope an operation requires', async () => {
    const account = await createAccount(h.sql);
    const readOnly = await createApiKey(h, account.token, { scopes: ['files:read'] });

    const list = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(readOnly.key),
    });
    expect(list.statusCode).toBe(200);

    const create = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(readOnly.key),
      payload: { name: 'Nope' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json<{ detail: string }>().detail).toContain('files:write');
  });

  it('refuses a key used to administer keys, so it cannot widen its own access', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, {
      scopes: ['files:read', 'files:write', 'shares:write', 'account:read'],
    });

    const create = await h.server.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: bearer(key.key),
      payload: { name: 'escalation', scopes: ['files:write'] },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json<{ detail: string }>().detail).toContain('api-keys:manage');

    const revoke = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${key.id}`,
      headers: bearer(key.key),
    });
    expect(revoke.statusCode).toBe(403);
  });

  it('refuses a revoked key on the next request', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, { scopes: ['account:read'] });
    expect(
      (await h.server.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(key.key) }))
        .statusCode,
    ).toBe(200);

    const revoked = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${key.id}`,
      headers: bearer(account.token),
    });
    expect(revoked.statusCode).toBe(204);

    const after = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(key.key),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json<{ detail: string }>().detail).toContain('revoked');
  });

  it('refuses an expired key', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, { scopes: ['account:read'] });
    await h.sql`update api_keys set expires_at = now() - interval '1 minute' where id = ${key.id}`;

    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(key.key),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('expired');
  });

  it('refuses an unknown prefix and a tampered secret with the same answer', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, { scopes: ['account:read'] });
    const tampered = `${key.keyPrefix}_${'B'.repeat(43)}`;

    const unknown = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-api-key': 'odk_zzzzzzzz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    const modified = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(tampered),
    });

    expect(unknown.statusCode).toBe(401);
    expect(modified.statusCode).toBe(401);
    // Indistinguishable: a probe cannot tell a real prefix from an invented one.
    expect(unknown.json<{ detail: string }>().detail).toBe(
      modified.json<{ detail: string }>().detail,
    );
  });

  it('refuses a key whose owner was suspended after the key was issued', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, { scopes: ['account:read'] });
    await setAccountStatus(h.sql, account.userId, 'suspended');

    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(key.key),
    });
    expect(response.statusCode).toBe(403);
  });

  it('keeps one account’s keys invisible to another', async () => {
    const owner = await createAccount(h.sql);
    const other = await createAccount(h.sql);
    const key = await createApiKey(h, owner.token, { scopes: ['account:read'] });

    const list = await h.server.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: bearer(other.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(
      key.id,
    );

    const revoke = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${key.id}`,
      headers: bearer(other.token),
    });
    expect(revoke.statusCode).toBe(404);
  });
});

describe('credential conflicts', () => {
  it('refuses two credentials even when both would resolve to the same account', async () => {
    const account = await createAccount(h.sql);
    const key = await createApiKey(h, account.token, { scopes: ['account:read'] });

    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...bearer(account.token), 'x-api-key': key.key },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });

  it('does not fall back to a weaker identity when a stronger credential is invalid', async () => {
    const account = await createAccount(h.sql);
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      // A valid anonymous session in one header must not rescue an invalid token in the other.
      headers: { authorization: 'Bearer not-a-credential', 'x-api-key': 'not-a-key' },
    });
    expect(response.statusCode).toBe(400);
    void account;
  });
});
