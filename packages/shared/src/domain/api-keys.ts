import { z } from 'zod';

/**
 * API-key scopes.
 *
 * An API key is a *machine* identity for one user: it carries an explicit capability list and can
 * never do more than its owner could do interactively. There is deliberately no wildcard and no
 * administrative scope — an "everything" scope on a key that leaks is indistinguishable from a
 * compromised account, and a key that can mint other keys can escalate itself past its own
 * revocation.
 *
 * The list mirrors the `api_keys_scopes_known` check constraint in
 * supabase/migrations/20261010000001_initial_schema.sql. Adding a scope is a migration plus a
 * change here; the database rejects an unknown scope even if this file is edited alone.
 */

export const API_KEY_SCOPES = [
  'files:read',
  'files:write',
  'shares:write',
  'account:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

/**
 * Capabilities that only a human session may exercise, on any credential type.
 *
 * Key administration and account changes are excluded from every API key: `files:write` must not
 * be able to create a `shares:write` key, revoke its own revocation, or read another key's
 * metadata.
 */
export const SESSION_ONLY_CAPABILITIES = ['api-keys:manage', 'account:manage'] as const;
export type SessionOnlyCapability = (typeof SESSION_ONLY_CAPABILITIES)[number];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** True only when `granted` contains `required`. An empty list grants nothing. */
export function hasScope(granted: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  return granted.includes(required);
}

/** Every required scope that is missing. Empty means the caller is authorised. */
export function missingScopes(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): ApiKeyScope[] {
  return required.filter((scope) => !hasScope(granted, scope));
}

/**
 * Drops scopes the database would refuse anyway, so a bad request is a validation error at the
 * boundary instead of a constraint violation from inside a transaction.
 */
export function normalizeScopes(values: readonly string[]): {
  readonly accepted: ApiKeyScope[];
  readonly rejected: string[];
} {
  const accepted: ApiKeyScope[] = [];
  const rejected: string[] = [];
  for (const value of values) {
    if (!isApiKeyScope(value)) {
      rejected.push(value);
      continue;
    }
    if (!accepted.includes(value)) accepted.push(value);
  }
  return { accepted, rejected };
}
