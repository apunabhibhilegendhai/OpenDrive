import type { AuthContext } from '@opendrive/shared';
import type { ResolvedIdentity } from './identity.js';

/**
 * The identity as a client sees it.
 *
 * This is intentionally a *rendering* of the resolved identity, not the identity itself: the
 * internal type carries the principal object, the credential source and the account status, and
 * clients need none of that in order to make sense of a response. Anything that should not be
 * published simply has no field here.
 */
export function toAuthContext(identity: ResolvedIdentity): AuthContext {
  if (identity.kind === 'user') {
    return {
      principalKind: 'user',
      userId: identity.principal.kind === 'user' ? identity.principal.userId : null,
      sessionId: null,
      displayName: identity.displayName,
      accountStatus: identity.accountStatus,
      credentialExpiresAt:
        identity.credentialExpiresAt === null ? null : identity.credentialExpiresAt.toISOString(),
      scopes: [...identity.scopes],
      apiKeyId: identity.apiKeyId,
      apiKeyPrefix: identity.apiKeyPrefix,
    };
  }

  return {
    principalKind: 'anonymous',
    userId: null,
    sessionId: identity.principal.kind === 'anonymous' ? identity.principal.sessionId : null,
    displayName: null,
    accountStatus: null,
    credentialExpiresAt: identity.sessionExpiresAt.toISOString(),
    scopes: [...identity.scopes],
    apiKeyId: null,
    apiKeyPrefix: null,
  };
}
