import type { AccountStatus, SessionStatus } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';
import type { AnonymousSessionEntity, ProfileEntity } from '../entities.js';
import { parseByteCount, parseNullableTimestamp, parseTimestamp } from '../parse.js';

/**
 * Profiles and anonymous sessions — the two things a request can be authenticated *as*.
 *
 * Anonymous sessions are never Supabase users: they are rows here, with a hashed credential and
 * an expiry. Nothing in this module accepts a session id as proof of anything; the credential is
 * what is looked up, and the id is only ever a primary key.
 */

interface ProfileRow {
  id: string;
  displayName: string | null;
  status: AccountStatus;
  storageQuotaBytes: string | number;
  maxFileSizeBytes: string | number;
  maxFiles: number;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
}

interface AnonymousSessionRow {
  id: string;
  credentialHash: string;
  status: SessionStatus;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function toProfile(row: ProfileRow): ProfileEntity {
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status,
    storageQuotaBytes: parseByteCount(row.storageQuotaBytes, 'profiles.storage_quota_bytes'),
    maxFileSizeBytes: parseByteCount(row.maxFileSizeBytes, 'profiles.max_file_size_bytes'),
    maxFiles: row.maxFiles,
    createdAt: parseTimestamp(row.createdAt, 'profiles.created_at'),
    updatedAt: parseTimestamp(row.updatedAt, 'profiles.updated_at'),
    disabledAt: parseNullableTimestamp(row.disabledAt, 'profiles.disabled_at'),
  };
}

function toAnonymousSession(row: AnonymousSessionRow): AnonymousSessionEntity {
  return {
    id: row.id,
    credentialHash: row.credentialHash,
    status: row.status,
    createdAt: parseTimestamp(row.createdAt, 'anonymous_sessions.created_at'),
    expiresAt: parseTimestamp(row.expiresAt, 'anonymous_sessions.expires_at'),
    lastUsedAt: parseNullableTimestamp(row.lastUsedAt, 'anonymous_sessions.last_used_at'),
    revokedAt: parseNullableTimestamp(row.revokedAt, 'anonymous_sessions.revoked_at'),
  };
}

export async function findProfile(sql: SqlExecutor, userId: string): Promise<ProfileEntity | null> {
  const rows = await sql<ProfileRow[]>`
    select id, display_name as "displayName", status,
           storage_quota_bytes as "storageQuotaBytes",
           max_file_size_bytes as "maxFileSizeBytes",
           max_files as "maxFiles",
           created_at as "createdAt", updated_at as "updatedAt", disabled_at as "disabledAt"
      from profiles
     where id = ${userId}
  `;
  const row = rows[0];
  return row === undefined ? null : toProfile(row);
}

/**
 * Creates the profile row for a verified user if it is missing, and returns it.
 *
 * Called only after a token has been verified against the configured issuer, so the id is one the
 * authentication server signed. Everything the row starts with is a default: a new user gets the
 * standard quota and an `active` status, never a client-supplied value.
 *
 * `on conflict do nothing` (rather than an upsert) is deliberate: a concurrent request must never
 * be able to reset an existing profile's status or limits.
 */
export async function ensureProfile(sql: SqlExecutor, userId: string): Promise<ProfileEntity> {
  await sql`insert into profiles (id) values (${userId}) on conflict (id) do nothing`;
  const profile = await findProfile(sql, userId);
  if (profile === null) {
    // Unreachable in practice: the insert above either created the row or it already existed.
    throw new Error('profile row is missing immediately after being ensured');
  }
  return profile;
}

export async function insertAnonymousSession(
  sql: SqlExecutor,
  input: {
    id: string;
    credentialHash: string;
    expiresAt: Date;
    createdIpHash: string | null;
  },
): Promise<AnonymousSessionEntity> {
  const rows = await sql<AnonymousSessionRow[]>`
    insert into anonymous_sessions (id, credential_hash, expires_at, created_ip_hash)
    values (${input.id}, ${input.credentialHash}, ${input.expiresAt}, ${input.createdIpHash})
    returning id, credential_hash as "credentialHash", status, created_at as "createdAt",
              expires_at as "expiresAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('anonymous session insert returned no row');
  return toAnonymousSession(row);
}

/**
 * Looks up a session by the SHA-256 digest of its credential.
 *
 * Expiry is returned rather than filtered: the caller must distinguish "no such credential" from
 * "expired credential" for its audit trail, and only the caller knows whether it wants to be
 * strict. `isSessionValid` in the shared package makes the actual decision.
 */
export async function findAnonymousSessionByCredentialHash(
  sql: SqlExecutor,
  credentialHash: string,
): Promise<AnonymousSessionEntity | null> {
  const rows = await sql<AnonymousSessionRow[]>`
    select id, credential_hash as "credentialHash", status, created_at as "createdAt",
           expires_at as "expiresAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"
      from anonymous_sessions
     where credential_hash = ${credentialHash}
  `;
  const row = rows[0];
  return row === undefined ? null : toAnonymousSession(row);
}

export async function findAnonymousSessionById(
  sql: SqlExecutor,
  sessionId: string,
): Promise<AnonymousSessionEntity | null> {
  const rows = await sql<AnonymousSessionRow[]>`
    select id, credential_hash as "credentialHash", status, created_at as "createdAt",
           expires_at as "expiresAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"
      from anonymous_sessions
     where id = ${sessionId}
  `;
  const row = rows[0];
  return row === undefined ? null : toAnonymousSession(row);
}

/**
 * Records use of a session, at most once per `minIntervalSeconds`.
 *
 * The throttle is the point: `last_used_at` exists to triage abandoned sessions, and writing it
 * on every request would turn each read into a write. The condition is evaluated by the database,
 * so concurrent requests cannot both decide to update.
 */
export async function touchAnonymousSession(
  sql: SqlExecutor,
  sessionId: string,
  minIntervalSeconds = 300,
): Promise<void> {
  await sql`
    update anonymous_sessions
       set last_used_at = now()
     where id = ${sessionId}
       and status = 'active'
       and (last_used_at is null
            or last_used_at < now() - make_interval(secs => ${minIntervalSeconds}))
  `;
}

/**
 * Revokes a session. The row is kept so its files stay attributable, and `revoked_at` is written
 * with the status in one statement so the consistency check cannot observe a half-revocation.
 */
export async function revokeAnonymousSession(
  sql: SqlExecutor,
  sessionId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update anonymous_sessions
       set status = 'revoked', revoked_at = now()
     where id = ${sessionId} and status = 'active'
    returning id
  `;
  return rows.length > 0;
}
