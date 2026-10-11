import { describe, expect, it } from 'vitest';
import { isAppError } from '@opendrive/shared';
import type { AppError } from '@opendrive/shared';
import {
  REQUIRED_SCOPES,
  assertFileOwnership,
  assertFolderOwnership,
  carriesScope,
  isOwner,
  ownerKeyOf,
  requireIdentity,
  requireScope,
  requireSessionCredential,
  requireUser,
} from './authz.js';
import type { AuthenticatedSession, AuthenticatedUser, RequestIdentity } from './auth/identity.js';
import type { FileEntity, FolderEntity } from './db/entities.js';

/**
 * The authorization matrix.
 *
 * Every helper is asserted twice where it matters: allowed for the right caller, and refused — with
 * the *specific* error the contract promises — for everyone else. The refusal cases are the point;
 * an authorization helper that fails open is worse than no helper, because it looks like a control.
 */

const USER_ID = 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33';
const OTHER_USER_ID = 'c2e1a6b5-7e5e-4a1b-8f5b-2e1b3a8d0f44';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  kind: 'user',
  principal: { kind: 'user', userId: USER_ID },
  credential: 'supabase_access_token',
  scopes: [],
  displayName: null,
  accountStatus: 'active',
  apiKeyId: null,
  apiKeyPrefix: null,
  credentialExpiresAt: null,
  ...overrides,
});

const session = (): AuthenticatedSession => ({
  kind: 'anonymous',
  principal: { kind: 'anonymous', sessionId: 'sess_0123456789abcdefghjkmnpqrs' },
  credential: 'anonymous_session',
  scopes: ['files:read', 'files:write', 'shares:write'],
  sessionExpiresAt: new Date(Date.now() + 60_000),
});

const noIdentity: RequestIdentity = { kind: 'none' };

function refusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the helper to refuse');
}

const file = (ownerKey: string): FileEntity => ({
  id: 'file_0123456789012345678901234a',
  ownerKind: 'user',
  ownerKey,
  ownerUserId: ownerKey,
  ownerSessionId: null,
  folderId: null,
  originalFilename: 'report.pdf',
  sizeBytes: 1024,
  mimeType: 'application/pdf',
  detectedMimeType: null,
  visibility: 'private',
  state: 'ready',
  scanState: 'clean',
  checksumSha256: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: null,
  deletedAt: null,
  scannedAt: null,
});

const folder = (ownerKey: string): FolderEntity => ({
  id: 'fold_0123456789012345678901234a',
  ownerKind: 'user',
  ownerKey,
  ownerUserId: ownerKey,
  ownerSessionId: null,
  parentId: null,
  name: 'Documents',
  depth: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
});

describe('requireIdentity', () => {
  it('refuses a request with no credential', () => {
    const error = refusal(() => requireIdentity(noIdentity));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.status).toBe(401);
  });

  it('passes a resolved identity through', () => {
    expect(requireIdentity(user()).kind).toBe('user');
    expect(requireIdentity(session()).kind).toBe('anonymous');
  });
});

describe('requireUser', () => {
  it('refuses an anonymous session', () => {
    const error = refusal(() => requireUser(session()));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.status).toBe(403);
  });
});

describe('requireSessionCredential', () => {
  it('refuses an API key, so a key can never widen its own access', () => {
    const key = user({
      credential: 'api_key',
      scopes: ['files:write'],
      apiKeyId: 'key_0123456789012345678901234a',
      apiKeyPrefix: 'odk_4zrp37hg',
    });
    const error = refusal(() => requireSessionCredential(key, 'api-keys:manage'));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.detail).toContain('api-keys:manage');
  });

  it('refuses an anonymous session, which has no account to administer', () => {
    expect(refusal(() => requireSessionCredential(session(), 'account:manage')).code).toBe(
      'FORBIDDEN',
    );
  });

  it('accepts a session credential', () => {
    expect(requireSessionCredential(user(), 'api-keys:manage').principal.userId).toBe(USER_ID);
  });
});

describe('requireScope', () => {
  it('refuses a credential missing a scope and names it', () => {
    const key = user({ credential: 'api_key', scopes: ['files:read'] });
    const error = refusal(() => requireScope(key, REQUIRED_SCOPES.sharesWrite));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.detail).toContain('shares:write');
  });

  it('accepts a credential that carries every required scope', () => {
    const key = user({ credential: 'api_key', scopes: ['files:read', 'files:write'] });
    expect(requireScope(key, REQUIRED_SCOPES.filesWrite).kind).toBe('user');
    expect(carriesScope(key, 'files:write')).toBe(true);
    expect(carriesScope(key, 'shares:write')).toBe(false);
  });

  it('refuses an unauthenticated request before checking scopes', () => {
    expect(refusal(() => requireScope(noIdentity, REQUIRED_SCOPES.filesRead)).code).toBe(
      'UNAUTHENTICATED',
    );
  });
});

describe('ownership', () => {
  it('derives the owner key the database itself would derive', () => {
    expect(ownerKeyOf(user())).toBe(USER_ID);
    expect(ownerKeyOf(session())).toBe('sess_0123456789abcdefghjkmnpqrs');
  });

  it('matches only the owner, and treats a malformed identity as owning nothing', () => {
    expect(isOwner(user(), USER_ID)).toBe(true);
    expect(isOwner(user(), OTHER_USER_ID)).toBe(false);
    expect(isOwner(noIdentity, USER_ID)).toBe(false);
    expect(isOwner(session(), USER_ID)).toBe(false);
    // An identity whose principal cannot produce a key owns nothing, rather than matching "".
    expect(isOwner(user({ principal: { kind: 'user', userId: 'not-a-uuid' } }), '')).toBe(false);
  });

  it('answers a foreign or missing file exactly like an unknown id', () => {
    const mine = file(USER_ID);
    expect(assertFileOwnership(user(), mine).id).toBe(mine.id);

    const foreign = refusal(() => assertFileOwnership(user(), file(OTHER_USER_ID)));
    expect(foreign.code).toBe('NOT_FOUND');
    expect(foreign.status).toBe(404);
    expect(foreign.detail).toBe('The resource does not exist.');

    const missing = refusal(() => assertFileOwnership(user(), null));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.detail).toBe(foreign.detail);
  });

  it('applies the same rule to folders', () => {
    expect(assertFolderOwnership(user(), folder(USER_ID)).name).toBe('Documents');
    const foreign = refusal(() => assertFolderOwnership(session(), folder(USER_ID)));
    expect(foreign.code).toBe('NOT_FOUND');
  });

  it('refuses an unauthenticated caller even for a resource with no owner match', () => {
    expect(refusal(() => assertFileOwnership(noIdentity, file(USER_ID))).code).toBe(
      'UNAUTHENTICATED',
    );
  });
});
