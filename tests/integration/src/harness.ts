import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { newId, sha256Hex } from '@opendrive/shared';
import type { FileState, FileVisibility, ScanState } from '@opendrive/shared';
import { MemoryStorageProvider } from '@opendrive/shared/storage/testing';
import { loadConfig } from '../../../apps/api/src/config.js';
import type { ApiConfig } from '../../../apps/api/src/config.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createServices } from '../../../apps/api/src/services.js';
import type { AppServices } from '../../../apps/api/src/services.js';
import type { Sql } from '../../../apps/api/src/db/client.js';
import type { StorageResolution } from '../../../apps/api/src/storage/registry.js';

/**
 * Integration harness.
 *
 * These tests run the real schema, the real repositories and the real HTTP layer against a
 * throwaway PostgreSQL database. That is the only way to test the things this phase actually
 * claims: that ownership is enforced by queries rather than by comments, that a credential is
 * matched against a stored digest, and that a quota check survives two concurrent uploads.
 *
 * What is *stubbed*: nothing in the database. What is real: everything else. Access tokens are
 * signed locally with the same secret the server is configured with, so the verification path is
 * exercised for real — only the issuer (Supabase Auth itself) is replaced.
 *
 * The database is provisioned by `tests/integration/run-local.sh`; `DATABASE_URL` must point at it.
 */

export const TEST_JWT_SECRET = 'integration-test-secret-not-used-anywhere-else';
export const TEST_ISSUER = 'https://supabase.integration.test/auth/v1';
export const TEST_AUDIENCE = 'authenticated';
export const TEST_IP_HASH_SECRET = 'integration-ip-hash-secret';

export function databaseUrl(): string | null {
  const value = process.env.DATABASE_URL;
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** Fails loudly with the command to run, rather than letting every test fail one by one. */
export function requireDatabaseUrl(): string {
  const url = databaseUrl();
  if (url === null) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need a scratch database: run ' +
        '"pnpm db:test:integration", which provisions one and points the suite at it.',
    );
  }
  return url;
}

export function testConfig(env: Record<string, string | undefined> = {}): ApiConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: requireDatabaseUrl(),
    SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
    SUPABASE_JWT_ISSUER: TEST_ISSUER,
    SUPABASE_JWT_AUDIENCE: TEST_AUDIENCE,
    IP_HASH_SECRET: TEST_IP_HASH_SECRET,
    // Scanning on by default: the stricter configuration is the one worth testing.
    MALWARE_SCAN_ENABLED: 'true',
    RATE_LIMIT_ENABLED: 'false',
    ...env,
  });
}

export interface Harness {
  readonly config: ApiConfig;
  readonly services: AppServices;
  readonly server: FastifyInstance;
  /** Raw connection, for fixtures and for asserting what was actually stored. */
  readonly sql: Sql;
  close: () => Promise<void>;
}

export async function createHarness(
  env: Record<string, string | undefined> = {},
  options: { storage?: StorageResolution } = {},
): Promise<Harness> {
  const config = testConfig(env);
  const services = createServices(
    config,
    options.storage === undefined ? {} : { storage: options.storage },
  );
  const server = await buildServer({ config, services, logger: false });
  const sql = services.db.requireSql();
  return {
    config,
    services,
    server,
    sql,
    close: async () => {
      await server.close();
      await services.db.close();
    },
  };
}

/**
 * A storage resolution backed by the shared in-memory test double.
 *
 * The upload engine's bookkeeping is what these tests exercise; the provider contract suite already
 * proves the double behaves like a provider. Injecting it lets an upload run end to end without a
 * network backend, while the file rows, quota holds and ownership checks remain entirely real.
 */
export function memoryStorage(): StorageResolution {
  return {
    provider: new MemoryStorageProvider(),
    configuredName: 'memory-test',
    detail: 'In-memory storage injected by the integration tests.',
    productionSafe: false,
  };
}

/** A token that the server will actually accept: signed by the configured secret and issuer. */
export async function signUserToken(
  userId: string,
  options: { expiresIn?: number; role?: string; issuer?: string | null; audience?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({ role: options.role ?? 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 3600));
  if (options.issuer !== null) builder = builder.setIssuer(options.issuer ?? TEST_ISSUER);
  return builder.sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Creates an auth user plus the profile row the API expects.
 *
 * The `auth.users` row is created directly because Supabase Auth owns that table; the profile is
 * created by the API itself on first use, which is what the identity tests assert.
 */
export async function createAccount(
  sql: Sql,
  options: {
    email?: string;
    status?: 'active' | 'suspended' | 'closed';
    /**
     * Whether to create the profile row. Almost every fixture needs one, because files reference
     * `profiles(id)` and the quota functions read it. Pass `false` only to observe the API
     * provisioning the row itself.
     */
    provisionProfile?: boolean;
  } = {},
): Promise<{ userId: string; email: string; token: string }> {
  const userId = randomUUID();
  const email = options.email ?? `${userId}@integration.test`;
  await sql`insert into auth.users (id, email) values (${userId}, ${email})`;
  if (options.provisionProfile !== false) {
    await sql`
      insert into profiles (id, status) values (${userId}, ${options.status ?? 'active'})
      on conflict (id) do update set status = excluded.status
    `;
  }
  return { userId, email, token: await signUserToken(userId) };
}

export async function setAccountStatus(
  sql: Sql,
  userId: string,
  status: 'active' | 'suspended' | 'closed',
): Promise<void> {
  await sql`update profiles set status = ${status} where id = ${userId}`;
}

export async function setAccountLimits(
  sql: Sql,
  userId: string,
  limits: { storageQuotaBytes?: number; maxFileSizeBytes?: number; maxFiles?: number },
): Promise<void> {
  await sql`
    update profiles
       set storage_quota_bytes = coalesce(${limits.storageQuotaBytes ?? null}, storage_quota_bytes),
           max_file_size_bytes = coalesce(${limits.maxFileSizeBytes ?? null}, max_file_size_bytes),
           max_files = coalesce(${limits.maxFiles ?? null}, max_files)
     where id = ${userId}
  `;
}

/**
 * Inserts a file row directly.
 *
 * Uploads are Phase 2, so fixtures write the row the upload engine will write. Everything the API
 * reads — ownership, state, visibility, scan verdict — is real.
 */
export async function createFileFixture(
  sql: Sql,
  input: {
    owner: { kind: 'user'; userId: string } | { kind: 'anonymous'; sessionId: string };
    state?: FileState;
    visibility?: FileVisibility;
    sizeBytes?: number;
    folderId?: string | null;
    scanState?: ScanState;
    filename?: string;
    expiresAt?: Date | null;
  },
): Promise<string> {
  const id = newId('file');
  const sizeBytes = input.sizeBytes ?? 1024;
  const state = input.state ?? 'ready';
  const scanState = input.scanState ?? (state === 'ready' ? 'clean' : 'not_scanned');
  await sql`
    insert into files (id, owner_user_id, owner_session_id, folder_id, original_filename,
                       size_bytes, mime_type, visibility, status, scan_state, expires_at, deleted_at)
    values (${id},
            ${input.owner.kind === 'user' ? input.owner.userId : null},
            ${input.owner.kind === 'anonymous' ? input.owner.sessionId : null},
            ${input.folderId ?? null},
            ${input.filename ?? 'fixture.bin'},
            ${sizeBytes},
            'application/octet-stream',
            ${input.visibility ?? 'private'},
            ${state},
            ${scanState},
            ${input.expiresAt ?? null},
            ${state === 'deleted' ? new Date() : null})
  `;
  return id;
}

/** Creates an anonymous session the way the API does, returning the credential to present. */
export async function createAnonymousSession(
  h: Harness,
  options: { ttlSeconds?: number } = {},
): Promise<{ sessionId: string; credential: string }> {
  const response = await h.server.inject({
    method: 'POST',
    url: '/api/v1/anonymous-sessions',
  });
  if (response.statusCode !== 201) {
    throw new Error(`session creation failed with ${response.statusCode}: ${response.body}`);
  }
  const body = response.json<{ sessionId: string; credential: string }>();
  if (options.ttlSeconds !== undefined) {
    // `created_at` moves too: the table requires `expires_at > created_at`, so an already-expired
    // session is expressed by back-dating both, never by violating that check.
    await h.sql`
      update anonymous_sessions
         set created_at = now() - make_interval(secs => ${Math.max(options.ttlSeconds, 0) + 3600}),
             expires_at = now() + make_interval(secs => ${options.ttlSeconds})
       where id = ${body.sessionId}
    `;
  }
  return body;
}

/** Creates an API key the way an account holder would, returning the plaintext exactly once. */
export async function createApiKey(
  h: Harness,
  token: string,
  input: { name?: string; scopes?: string[]; expiresAt?: string | null } = {},
): Promise<{ id: string; key: string; keyPrefix: string }> {
  const response = await h.server.inject({
    method: 'POST',
    url: '/api/v1/api-keys',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: {
      name: input.name ?? 'integration key',
      scopes: input.scopes ?? ['files:read'],
      expiresAt: input.expiresAt ?? null,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`api key creation failed with ${response.statusCode}: ${response.body}`);
  }
  return response.json<{ id: string; key: string; keyPrefix: string }>();
}

/** Digest of a credential, for asserting what the database holds. */
export function digest(value: string): Promise<string> {
  return sha256Hex(value);
}
