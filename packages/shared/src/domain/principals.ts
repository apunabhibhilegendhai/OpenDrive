import { z } from 'zod';

/**
 * Ownership principals.
 *
 * Every file and folder belongs to exactly one principal: a registered user or an anonymous
 * session. The database enforces the same invariant with `num_nonnulls(owner_user_id,
 * owner_session_id) = 1`, and derives a single comparable `owner_key` from it
 * (`coalesce(owner_user_id::text, owner_session_id)`).
 *
 * `principalOwnerKey` below MUST stay byte-identical to that generated column: it is the value
 * used in composite foreign keys and in the quota functions, so a difference in case or
 * formatting would compare two owners as different people — or, worse, as the same person.
 */

export const PRINCIPAL_KINDS = ['user', 'anonymous'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export const principalKindSchema = z.enum(PRINCIPAL_KINDS);

/** Prefixed id of an anonymous session row (see the `anonymous_sessions` table). */
export const ANONYMOUS_SESSION_ID_PREFIX = 'sess_';

export type Principal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'anonymous'; readonly sessionId: string };

export function userPrincipal(userId: string): Principal {
  return { kind: 'user', userId };
}

export function anonymousPrincipal(sessionId: string): Principal {
  return { kind: 'anonymous', sessionId };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID_PATTERN = /^sess_[0-9a-hjkmnp-tv-z]{26}$/;

export function isAnonymousSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function isUserPrincipalId(value: string): boolean {
  return UUID_PATTERN.test(value.toLowerCase());
}

/**
 * The database's `owner_key` for a principal: the lower-cased user id, or the session id.
 * Returns null for an identity that cannot be an owner, so callers cannot accidentally
 * build a key that would match nobody (or, with an empty string, everybody).
 */
export function principalOwnerKey(principal: Principal): string | null {
  if (principal.kind === 'user') {
    const normalized = principal.userId.trim().toLowerCase();
    return isUserPrincipalId(normalized) ? normalized : null;
  }
  return isAnonymousSessionId(principal.sessionId) ? principal.sessionId : null;
}

/** Inverse of {@link principalOwnerKey}. Null when the key is neither shape. */
export function parseOwnerKey(ownerKey: string): Principal | null {
  const value = ownerKey.trim();
  if (isAnonymousSessionId(value)) return anonymousPrincipal(value);
  const normalized = value.toLowerCase();
  return isUserPrincipalId(normalized) ? userPrincipal(normalized) : null;
}

export function samePrincipal(left: Principal, right: Principal): boolean {
  const leftKey = principalOwnerKey(left);
  const rightKey = principalOwnerKey(right);
  return leftKey !== null && leftKey === rightKey;
}

/** Non-null form of {@link principalOwnerKey}, for code that has already validated the identity. */
export function requireOwnerKey(principal: Principal): string {
  const key = principalOwnerKey(principal);
  if (key === null) {
    throw new TypeError('principal is not a valid owner: an owner key cannot be derived from it');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Account and session status
// ---------------------------------------------------------------------------

export const ACCOUNT_STATUSES = ['active', 'suspended', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);

export const SESSION_STATUSES = ['active', 'revoked'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const sessionStatusSchema = z.enum(SESSION_STATUSES);

/**
 * Only an `active` account may act. `suspended` and `closed` are refused at the authorization
 * layer, never at the query that happens to read the row: a suspended user with a valid access
 * token must be refused *before* any resource decision is made.
 */
export function isAccountUsable(status: AccountStatus): boolean {
  return status === 'active';
}

export interface SessionValidity {
  readonly status: SessionStatus;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * A session is usable only while active AND unexpired. Expiry is evaluated on every use, so an
 * expired session cannot regain access by being read one more time — and revoking a session
 * that has already expired is not what makes it stop working.
 */
export function isSessionValid(session: SessionValidity): boolean {
  if (session.status !== 'active') return false;
  return session.expiresAt.getTime() > session.now.getTime();
}
