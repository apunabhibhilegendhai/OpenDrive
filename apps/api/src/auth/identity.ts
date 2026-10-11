import {
  ANONYMOUS_SESSION_CREDENTIAL_PREFIX,
  AppError,
  API_KEY_HEADER,
  AUTHORIZATION_HEADER,
  API_KEY_SCOPES,
  classifyCredential,
  credentialDigest,
  isAccountUsable,
  isSessionValid,
  parseApiKey,
  tokensEqual,
} from '@opendrive/shared';
import type { ApiKeyScope } from '@opendrive/shared';
import type { AccessTokenVerifier } from './tokens.js';
import type { Sql } from '../db/client.js';
import {
  ensureProfile,
  findAnonymousSessionByCredentialHash,
  findProfile,
  touchAnonymousSession,
} from '../db/repositories/identity.js';
import { findApiKeyByPrefix, touchApiKey } from '../db/repositories/api-keys.js';

/**
 * Resolving who is making a request.
 *
 * Three credential types identify a caller, and they are kept apart on purpose:
 *
 *   1. **Supabase access token** — a registered user, verified against the issuer.
 *   2. **Anonymous session credential** — `ods_…`, matched against a stored digest and checked for
 *      revocation and expiry on every request.
 *   3. **API key** — `odk_…`, matched against a stored digest, then checked for revocation, expiry,
 *      owner status and the scopes the route requires.
 *
 * Three rules hold for all of them:
 *
 *   * **A presented credential is never ignored.** If it does not resolve, the request fails. There
 *     is no "fall back to anonymous" path, because a client with a broken credential must find out
 *     rather than silently act as someone else.
 *   * **Two credentials are a conflict, not a preference.** Sending both an `Authorization` header
 *     and an `X-Api-Key` header is a 400, even if they would resolve to the same owner. Guessing
 *     which one the client meant is how a scope restriction gets bypassed.
 *   * **A user id in a request body is data, never identity.** Nothing here reads one.
 */

export type CredentialSource = 'supabase_access_token' | 'anonymous_session' | 'api_key';

/**
 * A registered user, as an owner. The principal is narrowed to the user shape so that callers get
 * a `userId` without re-checking what they already proved — and so that a session id can never be
 * read as a user id.
 */
export type UserPrincipal = { readonly kind: 'user'; readonly userId: string };
export type SessionPrincipal = { readonly kind: 'anonymous'; readonly sessionId: string };

export interface AuthenticatedUser {
  readonly kind: 'user';
  readonly principal: UserPrincipal;
  readonly credential: CredentialSource;
  readonly scopes: readonly ApiKeyScope[];
  readonly displayName: string | null;
  readonly accountStatus: 'active' | 'suspended' | 'closed';
  /** Session credentials carry every scope their owner has; a key carries only its own. */
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly credentialExpiresAt: Date | null;
}

export interface AuthenticatedSession {
  readonly kind: 'anonymous';
  readonly principal: SessionPrincipal;
  readonly credential: 'anonymous_session';
  readonly scopes: readonly ApiKeyScope[];
  readonly sessionExpiresAt: Date;
}

export type ResolvedIdentity = AuthenticatedUser | AuthenticatedSession;

/** A request with no credential at all. Distinct from "credential refused". */
export interface AnonymousRequest {
  readonly kind: 'none';
}

export type RequestIdentity = ResolvedIdentity | AnonymousRequest;

/** The scopes a full session credential implies: everything an interactive client may do. */
const SESSION_SCOPES: readonly ApiKeyScope[] = [...API_KEY_SCOPES];

/** Scopes an anonymous session may use: it can manage its own files and shares, nothing else. */
const ANONYMOUS_SESSION_SCOPES: readonly ApiKeyScope[] = [
  'files:read',
  'files:write',
  'shares:write',
];

export interface IdentityResolutionDeps {
  readonly sql: Sql | null;
  readonly verifier: AccessTokenVerifier;
  /** When false, no credential was presented or none could be read. */
  readonly now?: () => Date;
}

export interface PresentedCredentials {
  readonly authorization: string | null;
  readonly apiKey: string | null;
}

/**
 * Reads the credential headers, refusing the combinations that are ambiguous.
 *
 * Header names are lower-case because Fastify normalises them. An `Authorization` header that is
 * not a `Bearer` token is refused rather than ignored: `Basic` (or a homemade scheme) is a client
 * bug that would otherwise look like an anonymous request.
 */
export function readPresentedCredentials(headers: Record<string, unknown>): PresentedCredentials {
  const authorizationValue = headers[AUTHORIZATION_HEADER];
  const apiKeyValue = headers[API_KEY_HEADER];

  const authorization =
    typeof authorizationValue === 'string' && authorizationValue.trim() !== ''
      ? authorizationValue.trim()
      : null;
  const apiKey =
    typeof apiKeyValue === 'string' && apiKeyValue.trim() !== '' ? apiKeyValue.trim() : null;

  if (authorization !== null && apiKey !== null) {
    throw new AppError('INVALID_REQUEST', {
      detail:
        'Provide exactly one credential. An Authorization header and an X-Api-Key header were ' +
        'both sent, and they are never combined or preferred over one another.',
    });
  }

  return { authorization, apiKey };
}

/** Extracts the bearer token, or reports why the header cannot be used. */
export function parseBearerToken(authorization: string): string {
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  if (token === undefined || token === '') {
    throw new AppError('UNAUTHENTICATED', {
      detail: 'The Authorization header must use the "Bearer" scheme.',
    });
  }
  if (token === '') throw new AppError('UNAUTHENTICATED', { detail: 'The bearer token is empty.' });
  return token;
}

function requireSql(sql: Sql | null): Sql {
  if (sql === null) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: 'The metadata database is not configured for this deployment.',
    });
  }
  return sql;
}

/**
 * Resolves an access token to a user identity.
 *
 * The profile row is created on first use if it is missing, because a verified token for a user
 * with no profile is a normal state right after sign-up, and refusing it would leave the account
 * unusable until an operator intervened. Everything the row starts with is a server-side default.
 */
async function resolveUserFromToken(
  sql: Sql,
  verifier: AccessTokenVerifier,
  token: string,
  now: Date,
): Promise<AuthenticatedUser> {
  const verified = await verifier.verify(token);

  const existing = await findProfile(sql, verified.userId);
  const profile = existing ?? (await ensureProfile(sql, verified.userId));

  if (!isAccountUsable(profile.status)) {
    throw new AppError('FORBIDDEN', {
      detail: `This account is ${profile.status} and cannot be used.`,
      context: { accountStatus: profile.status },
    });
  }
  if (profile.disabledAt !== null) {
    throw new AppError('FORBIDDEN', { detail: 'This account has been disabled.' });
  }
  if (verified.expiresAt.getTime() <= now.getTime()) {
    // The verifier checks `exp`; this is the same check against the injected clock, so a test
    // clock cannot accidentally accept an expired token.
    throw new AppError('UNAUTHENTICATED', { detail: 'The access token has expired.' });
  }

  return {
    kind: 'user',
    principal: { kind: 'user', userId: verified.userId },
    credential: 'supabase_access_token',
    scopes: SESSION_SCOPES,
    displayName: profile.displayName,
    accountStatus: profile.status,
    apiKeyId: null,
    apiKeyPrefix: null,
    credentialExpiresAt: verified.expiresAt,
  };
}

/**
 * Resolves an anonymous session credential.
 *
 * Expiry and revocation are evaluated here on every request, so a session that lapses stops working
 * immediately — there is no cached "this credential was valid" state anywhere in the process.
 */
async function resolveAnonymousSession(
  sql: Sql | null,
  credential: string,
  now: Date,
): Promise<AuthenticatedSession> {
  const digest = await credentialDigest(credential);
  const session = await findAnonymousSessionByCredentialHash(requireSql(sql), digest);
  if (session === null) {
    throw new AppError('UNAUTHENTICATED', { detail: 'The session credential is not valid.' });
  }
  if (session.status === 'revoked') {
    throw new AppError('UNAUTHENTICATED', { detail: 'This anonymous session was revoked.' });
  }
  if (!isSessionValid({ status: session.status, expiresAt: session.expiresAt, now })) {
    throw new AppError('UNAUTHENTICATED', { detail: 'This anonymous session has expired.' });
  }

  // Best-effort bookkeeping: recording use must not be able to fail an authenticated request.
  await touchAnonymousSession(requireSql(sql), session.id).catch(() => {});

  return {
    kind: 'anonymous',
    principal: { kind: 'anonymous', sessionId: session.id },
    credential: 'anonymous_session',
    scopes: ANONYMOUS_SESSION_SCOPES,
    sessionExpiresAt: session.expiresAt,
  };
}

/**
 * Resolves an API key.
 *
 * Lookup is by the public prefix; the digest is then compared in constant time. An unknown prefix,
 * a mismatched digest and a revoked key all produce the same refusal, so a probe cannot tell a
 * valid prefix from an invalid one. The owner's account status is checked as well: revoking a key
 * is not the only way to stop it, and suspending an account must stop its keys too.
 */
async function resolveApiKey(sql: Sql | null, key: string, now: Date): Promise<AuthenticatedUser> {
  // The shape is checked before the database is consulted, so a malformed key is a 401 whatever
  // the deployment's configuration — the shape of a credential is not the database's business.
  const parsed = parseApiKey(key);
  if (parsed === null) {
    throw new AppError('UNAUTHENTICATED', { detail: 'The API key is not valid.' });
  }

  const database = requireSql(sql);
  const stored = await findApiKeyByPrefix(database, parsed.keyPrefix);
  if (stored === null) {
    throw new AppError('UNAUTHENTICATED', { detail: 'The API key is not valid.' });
  }

  const digest = await credentialDigest(key);
  if (!tokensEqual(digest, stored.keyHash)) {
    throw new AppError('UNAUTHENTICATED', { detail: 'The API key is not valid.' });
  }
  if (stored.revokedAt !== null) {
    throw new AppError('UNAUTHENTICATED', { detail: 'This API key was revoked.' });
  }
  if (stored.expiresAt !== null && stored.expiresAt.getTime() <= now.getTime()) {
    throw new AppError('UNAUTHENTICATED', { detail: 'This API key has expired.' });
  }

  const profile = await findProfile(database, stored.ownerUserId);
  if (profile === null || !isAccountUsable(profile.status)) {
    throw new AppError('FORBIDDEN', { detail: 'The account owning this API key is not usable.' });
  }

  await touchApiKey(database, stored.id).catch(() => {});

  return {
    kind: 'user',
    principal: { kind: 'user', userId: stored.ownerUserId },
    credential: 'api_key',
    scopes: stored.scopes,
    displayName: profile.displayName,
    accountStatus: profile.status,
    apiKeyId: stored.id,
    apiKeyPrefix: stored.keyPrefix,
    credentialExpiresAt: stored.expiresAt,
  };
}

/**
 * The single entry point: turns the request's headers into an identity, or throws.
 *
 * `now` is injectable so that expiry behaviour can be tested without waiting.
 */
export async function resolveRequestIdentity(
  headers: Record<string, unknown>,
  deps: IdentityResolutionDeps,
): Promise<RequestIdentity> {
  const now = (deps.now ?? (() => new Date()))();
  const presented = readPresentedCredentials(headers);

  if (presented.apiKey !== null) {
    return resolveApiKey(deps.sql, presented.apiKey, now);
  }
  if (presented.authorization === null) return { kind: 'none' };

  const token = parseBearerToken(presented.authorization);
  const kind = classifyCredential(token);

  switch (kind) {
    case 'supabase_access_token':
      return resolveUserFromToken(requireSql(deps.sql), deps.verifier, token, now);
    case 'anonymous_session':
      return resolveAnonymousSession(deps.sql, token, now);
    case 'api_key':
      return resolveApiKey(deps.sql, token, now);
    default:
      throw new AppError('UNAUTHENTICATED', {
        detail:
          `The bearer token is not a recognised credential. OpenDrive accepts a Supabase access ` +
          `token, an anonymous session credential ("${ANONYMOUS_SESSION_CREDENTIAL_PREFIX}…") or ` +
          `an API key.`,
      });
  }
}
