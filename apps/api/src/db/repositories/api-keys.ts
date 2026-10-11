import { z } from 'zod';
import { apiKeyScopeSchema } from '@opendrive/shared';
import type { ApiKeyScope } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';
import type { ApiKeyEntity } from '../entities.js';
import { translateWriteError } from '../errors.js';
import { parseNullableTimestamp, parseTimestamp } from '../parse.js';

/**
 * API keys.
 *
 * The secret half is never stored and never selected: `key_hash` is compared by the authentication
 * layer. `scopes` is a `text[]` column, and the driver hands a Postgres array back as a string, so
 * it is read as JSON (`to_jsonb`) and validated with the same schema the API publishes. A scope
 * list that fails validation is a server fault, not an empty list — an empty list would silently
 * grant nothing, but a *misread* list could grant something.
 */

interface ApiKeyRow {
  id: string;
  ownerUserId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: unknown;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

const scopesSchema = z.array(apiKeyScopeSchema);

function toApiKey(row: ApiKeyRow): ApiKeyEntity {
  const scopes = scopesSchema.safeParse(row.scopes);
  if (!scopes.success) throw new Error('api_keys.scopes holds a scope this build does not know');
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyHash: row.keyHash,
    scopes: scopes.data,
    createdAt: parseTimestamp(row.createdAt, 'api_keys.created_at'),
    lastUsedAt: parseNullableTimestamp(row.lastUsedAt, 'api_keys.last_used_at'),
    expiresAt: parseNullableTimestamp(row.expiresAt, 'api_keys.expires_at'),
    revokedAt: parseNullableTimestamp(row.revokedAt, 'api_keys.revoked_at'),
  };
}

export async function insertApiKey(
  sql: SqlExecutor,
  input: {
    id: string;
    ownerUserId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: readonly ApiKeyScope[];
    expiresAt: Date | null;
  },
): Promise<ApiKeyEntity> {
  try {
    const rows = await sql<ApiKeyRow[]>`
      insert into api_keys (id, owner_id, name, key_prefix, key_hash, scopes, expires_at)
      values (${input.id}, ${input.ownerUserId}, ${input.name}, ${input.keyPrefix},
              ${input.keyHash}, ${[...input.scopes]}, ${input.expiresAt})
      returning id, owner_id as "ownerUserId", name, key_prefix as "keyPrefix",
                key_hash as "keyHash", to_jsonb(scopes) as "scopes", created_at as "createdAt",
                last_used_at as "lastUsedAt", expires_at as "expiresAt", revoked_at as "revokedAt"
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('api key insert returned no row');
    return toApiKey(row);
  } catch (error) {
    throw translateWriteError(error, 'The API key could not be created.');
  }
}

/** Looks a key up by its public prefix. The caller compares the digest in constant time. */
export async function findApiKeyByPrefix(
  sql: SqlExecutor,
  keyPrefix: string,
): Promise<ApiKeyEntity | null> {
  const rows = await sql<ApiKeyRow[]>`
    select id, owner_id as "ownerUserId", name, key_prefix as "keyPrefix",
           key_hash as "keyHash", to_jsonb(scopes) as "scopes", created_at as "createdAt",
           last_used_at as "lastUsedAt", expires_at as "expiresAt", revoked_at as "revokedAt"
      from api_keys
     where key_prefix = ${keyPrefix}
  `;
  const row = rows[0];
  return row === undefined ? null : toApiKey(row);
}

export async function listApiKeys(sql: SqlExecutor, ownerUserId: string): Promise<ApiKeyEntity[]> {
  const rows = await sql<ApiKeyRow[]>`
    select id, owner_id as "ownerUserId", name, key_prefix as "keyPrefix",
           key_hash as "keyHash", to_jsonb(scopes) as "scopes", created_at as "createdAt",
           last_used_at as "lastUsedAt", expires_at as "expiresAt", revoked_at as "revokedAt"
      from api_keys
     where owner_id = ${ownerUserId}
     order by created_at desc
  `;
  return rows.map(toApiKey);
}

/**
 * Revokes a key. Scoped to its owner, so a key id is not a capability: guessing another user's
 * key id revokes nothing.
 */
export async function revokeApiKey(
  sql: SqlExecutor,
  input: { keyId: string; ownerUserId: string },
): Promise<ApiKeyEntity | null> {
  try {
    const rows = await sql<ApiKeyRow[]>`
      update api_keys
         set revoked_at = now()
       where id = ${input.keyId} and owner_id = ${input.ownerUserId} and revoked_at is null
      returning id, owner_id as "ownerUserId", name, key_prefix as "keyPrefix",
                key_hash as "keyHash", to_jsonb(scopes) as "scopes", created_at as "createdAt",
                last_used_at as "lastUsedAt", expires_at as "expiresAt", revoked_at as "revokedAt"
    `;
    const row = rows[0];
    return row === undefined ? null : toApiKey(row);
  } catch (error) {
    throw translateWriteError(error, 'The API key could not be revoked.');
  }
}

/** Records use of a key, at most once per `minIntervalSeconds` (see the session touch). */
export async function touchApiKey(
  sql: SqlExecutor,
  keyId: string,
  minIntervalSeconds = 300,
): Promise<void> {
  await sql`
    update api_keys
       set last_used_at = now()
     where id = ${keyId}
       and revoked_at is null
       and (last_used_at is null
            or last_used_at < now() - make_interval(secs => ${minIntervalSeconds}))
  `;
}
