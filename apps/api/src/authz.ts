import { AppError, hasScope, missingScopes, requireOwnerKey } from '@opendrive/shared';
import type { ApiKeyScope, Principal, SessionOnlyCapability } from '@opendrive/shared';
import type { AuthenticatedUser, RequestIdentity, ResolvedIdentity } from './auth/identity.js';
import type { FileEntity, FolderEntity } from './db/entities.js';

/**
 * Authorization.
 *
 * Authentication establishes *who* is calling; everything in this module decides *what they may
 * do*. The two are deliberately separate files with separate dependencies, because the classic
 * mistake is to let a successful parse of a credential double as a permission.
 *
 * Every helper here fails closed. There is no branch that returns "allowed" because a value was
 * missing, unparseable or unfamiliar: a resource that cannot be found, an owner that does not
 * match and a scope that is not carried all end in a raised AppError.
 *
 * Two conventions are worth stating once:
 *
 *   * **Cross-owner access answers 404, not 403.** Resource ids are global, and a client that can
 *     ask "does this file exist?" learns something it should not. A refusal is byte-identical to
 *     the answer for an id that was never issued.
 *   * **A missing scope answers 403.** Scopes are the caller's own key's configuration, so telling
 *     them which one is missing leaks nothing and saves a support ticket.
 */

/** The scopes each family of operations requires. Routes reference these, never string literals. */
export const REQUIRED_SCOPES = {
  filesRead: ['files:read'],
  filesWrite: ['files:write'],
  sharesWrite: ['shares:write'],
  accountRead: ['account:read'],
} as const satisfies Record<string, readonly ApiKeyScope[]>;

const NO_SUCH_RESOURCE = 'The resource does not exist.';

/** The identity, or a 401 when the request carried no usable credential. */
export function requireIdentity(identity: RequestIdentity): ResolvedIdentity {
  if (identity.kind === 'none') {
    throw new AppError('UNAUTHENTICATED', {
      detail: 'This endpoint requires a credential.',
    });
  }
  return identity;
}

/** A registered user. Anonymous sessions are refused: their resources are theirs alone. */
export function requireUser(identity: RequestIdentity): AuthenticatedUser {
  const resolved = requireIdentity(identity);
  if (resolved.kind !== 'user') {
    throw new AppError('FORBIDDEN', {
      detail: 'This endpoint is only available to a registered account.',
    });
  }
  return resolved;
}

/**
 * Requires a full session credential for an operation an API key may never perform.
 *
 * API keys manage files; they must not be able to mint other keys, widen their own scopes, or
 * change account settings. Without this rule a key with `files:write` would be one request away
 * from becoming a key with every scope, which is a privilege-escalation path that survives its own
 * revocation.
 */
export function requireSessionCredential(
  identity: RequestIdentity,
  capability: SessionOnlyCapability,
): AuthenticatedUser {
  const user = requireUser(identity);
  if (user.credential !== 'supabase_access_token') {
    throw new AppError('FORBIDDEN', {
      detail: `An API key cannot perform "${capability}". Use an access token from a signed-in session.`,
      context: { capability },
    });
  }
  return user;
}

/**
 * Requires every scope listed. Empty requirement means any authenticated identity qualifies.
 *
 * A session credential carries every scope, so this is only a restriction for API keys.
 */
export function requireScope(
  identity: RequestIdentity,
  required: ApiKeyScope | readonly ApiKeyScope[],
): ResolvedIdentity {
  const resolved = requireIdentity(identity);
  const needed = typeof required === 'string' ? [required] : required;
  const missing = missingScopes(resolved.scopes, needed);
  if (missing.length > 0) {
    throw new AppError('FORBIDDEN', {
      detail: `This credential is missing the required scope: ${missing.join(', ')}.`,
      context: { missingScopes: missing.join(',') },
    });
  }
  return resolved;
}

export function carriesScope(identity: ResolvedIdentity, scope: ApiKeyScope): boolean {
  return hasScope(identity.scopes, scope);
}

/** The principal that owns this request's resources. Throws when the identity cannot own rows. */
export function ownerKeyOf(identity: ResolvedIdentity): string {
  return requireOwnerKey(identity.principal);
}

export function principalOf(identity: ResolvedIdentity): Principal {
  return identity.principal;
}

/**
 * Whether the caller *is* the owner of a resource. Uses the same key the database derives, so the
 * comparison cannot drift from the one used in composite foreign keys and quota lookups.
 */
export function isOwner(identity: RequestIdentity, ownerKey: string): boolean {
  if (identity.kind === 'none') return false;
  try {
    return requireOwnerKey(identity.principal) === ownerKey;
  } catch {
    // An identity that cannot produce an owner key owns nothing. Failing here rather than throwing
    // keeps this usable as a predicate, and `false` is the safe answer.
    return false;
  }
}

/**
 * Returns the file only when the caller owns it. `null` (no such file) and a foreign file produce
 * the same 404, so the caller cannot use this endpoint to test for existence.
 */
export function assertFileOwnership(
  identity: RequestIdentity,
  file: FileEntity | null,
  notFoundDetail: string = NO_SUCH_RESOURCE,
): FileEntity {
  const resolved = requireIdentity(identity);
  if (file === null || !isOwner(resolved, file.ownerKey)) {
    throw new AppError('NOT_FOUND', { detail: notFoundDetail });
  }
  return file;
}

export function assertFolderOwnership(
  identity: RequestIdentity,
  folder: FolderEntity | null,
  notFoundDetail: string = NO_SUCH_RESOURCE,
): FolderEntity {
  const resolved = requireIdentity(identity);
  if (folder === null || !isOwner(resolved, folder.ownerKey)) {
    throw new AppError('NOT_FOUND', { detail: notFoundDetail });
  }
  return folder;
}

/**
 * Whether a caller may receive a file's *metadata*: only its owner, or a caller that resolved a
 * share link (which authorizes separately, from the token, and re-checks the file's state).
 *
 * This is not a download check. `isServable` decides whether bytes may be produced, and both answers
 * are needed: an owner may always see their own quarantine notice, and nobody may download it.
 */
export function mayReadFileMetadata(identity: RequestIdentity, file: FileEntity): boolean {
  return isOwner(identity, file.ownerKey);
}
