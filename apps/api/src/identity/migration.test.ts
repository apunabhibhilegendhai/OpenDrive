import { describe, expect, it } from 'vitest';
import { ANONYMOUS_CREDENTIAL_HEADER, isAppError } from '@opendrive/shared';
import type { AppError } from '@opendrive/shared';
import type { AuthenticatedUser, RequestIdentity, ResolvedIdentity } from '../auth/identity.js';
import type { AnonymousSessionEntity } from '../db/entities.js';
import {
  assessQuota,
  decideMigration,
  planMigrationRequest,
  planRootRenames,
  type MigrationFolder,
  type MigrationResources,
} from './migration.js';
import { migrationRefusalProblem } from './migrate.js';

/**
 * The migration decisions.
 *
 * These tests are the API-side guard rails for the two rules that matter: a session's resources
 * move to exactly one account, and a caller is never told which account holds a session it does not
 * own. Both are pure functions, so nothing here needs a database — which is the point of keeping the
 * decisions out of the transaction.
 */

const TARGET = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-14T12:00:00.000Z');

function session(overrides: Partial<AnonymousSessionEntity> = {}): AnonymousSessionEntity {
  return {
    id: `sess_${'1'.repeat(26)}`,
    credentialHash: 'a'.repeat(64),
    status: 'active',
    createdAt: new Date('2026-10-14T10:00:00.000Z'),
    expiresAt: new Date('2026-10-21T10:00:00.000Z'),
    lastUsedAt: null,
    revokedAt: null,
    migratedAt: null,
    migratedToUserId: null,
    migratedFileCount: null,
    migratedBytes: null,
    migratedFolders: null,
    migratedSkippedFiles: null,
    ...overrides,
  };
}

const SOME_RESOURCES: MigrationResources = {
  files: 3,
  bytes: 1024,
  folders: 2,
  incompleteFiles: 0,
};

function decide(
  overrides: Partial<AnonymousSessionEntity>,
  resources: MigrationResources = SOME_RESOURCES,
) {
  return decideMigration({
    session: session(overrides),
    targetUserId: TARGET,
    resources,
    now: NOW,
  });
}

describe('decideMigration', () => {
  it('proceeds for a live session that holds something', () => {
    expect(decide({})).toEqual({ kind: 'proceed' });
  });

  it('refuses a revoked session', () => {
    expect(decide({ status: 'revoked', revokedAt: NOW })).toMatchObject({
      kind: 'refused',
      reason: 'session_inactive',
    });
  });

  it('refuses an expired session', () => {
    expect(decide({ expiresAt: new Date('2026-10-14T11:59:59.000Z') })).toMatchObject({
      kind: 'refused',
      reason: 'session_expired',
    });
  });

  it('refuses a session with nothing to bring over', () => {
    expect(decide({}, { files: 0, bytes: 0, folders: 0, incompleteFiles: 0 })).toMatchObject({
      kind: 'refused',
      reason: 'nothing_to_migrate',
    });
  });

  it('proceeds when the only thing left is closing abandoned records', () => {
    expect(decide({}, { files: 0, bytes: 0, folders: 0, incompleteFiles: 2 })).toEqual({
      kind: 'proceed',
    });
  });

  it('replays the recorded counts when the same account asks again', () => {
    const decision = decide({
      status: 'revoked',
      revokedAt: NOW,
      migratedAt: NOW,
      migratedToUserId: TARGET,
      migratedFileCount: 3,
      migratedBytes: 1024,
      migratedFolders: 2,
      migratedSkippedFiles: 1,
    });

    expect(decision).toEqual({
      kind: 'replay',
      summary: {
        files: { count: 3, bytes: 1024 },
        folders: { count: 2 },
        skippedIncompleteFiles: 1,
        // Nothing was renamed a second time; the totals are the history.
        folderRenames: [],
      },
    });
  });

  it('refuses any other account, and never names the one that holds it', () => {
    const decision = decide({
      status: 'revoked',
      revokedAt: NOW,
      migratedAt: NOW,
      migratedToUserId: OTHER_ACCOUNT,
      migratedFileCount: 3,
      migratedBytes: 1024,
      migratedFolders: 2,
      migratedSkippedFiles: 0,
    });

    expect(decision).toMatchObject({ kind: 'refused', reason: 'migrated_elsewhere' });
    // The decisive assertion: the refusal describes the caller's own situation and leaks nothing
    // about the account that received the resources.
    expect(JSON.stringify(decision)).not.toContain(OTHER_ACCOUNT);
  });

  it('treats a half-written record as a server fault rather than guessing counts', () => {
    expect(
      decide({
        status: 'revoked',
        revokedAt: NOW,
        migratedAt: NOW,
        migratedToUserId: TARGET,
        migratedFileCount: null,
        migratedBytes: null,
        migratedFolders: null,
      }),
    ).toMatchObject({ kind: 'refused', reason: 'record_inconsistent' });
  });

  it('prefers the migration record over the session status, so a replay is not read as a revocation', () => {
    // A migrated session is necessarily revoked. If the status were consulted first, every repeat
    // of a legitimate migration would answer 401 instead of the recorded summary.
    expect(
      decide({
        status: 'revoked',
        revokedAt: NOW,
        migratedAt: NOW,
        migratedToUserId: TARGET,
        migratedFileCount: 1,
        migratedBytes: 10,
        migratedFolders: 0,
        migratedSkippedFiles: 0,
      }),
    ).toMatchObject({ kind: 'replay' });
  });
});

describe('migrationRefusalProblem', () => {
  it('answers a dead session credential as an authentication failure', () => {
    expect(
      migrationRefusalProblem({ kind: 'refused', reason: 'session_inactive', detail: 'revoked' })
        .status,
    ).toBe(401);
    expect(
      migrationRefusalProblem({ kind: 'refused', reason: 'session_expired', detail: 'expired' })
        .code,
    ).toBe('UNAUTHENTICATED');
  });

  it('answers a conflict as a conflict', () => {
    for (const reason of ['migrated_elsewhere', 'nothing_to_migrate'] as const) {
      const problem = migrationRefusalProblem({ kind: 'refused', reason, detail: 'no' });
      expect(problem.code).toBe('CONFLICT');
      expect(problem.status).toBe(409);
    }
  });

  it('never exposes an inconsistent record', () => {
    const problem = migrationRefusalProblem({
      kind: 'refused',
      reason: 'record_inconsistent',
      detail: 'internal detail',
    });
    expect(problem.status).toBe(500);
    expect(problem.expose).toBe(false);
  });
});

describe('planRootRenames', () => {
  const root = (id: string, name: string): MigrationFolder => ({ id, name, parentId: null });

  it('renames nothing when the account has no folder with that name', () => {
    expect(planRootRenames([root('fold_a', 'Photos')], ['Documents'])).toEqual([]);
  });

  it('renames a colliding root and reports the change', () => {
    expect(planRootRenames([root('fold_a', 'Photos')], ['photos'])).toEqual([
      { folderId: 'fold_a', from: 'Photos', to: 'Photos (migrated)' },
    ]);
  });

  it('escalates past the first replacement when the account already has that name too', () => {
    expect(
      planRootRenames(
        [root('fold_a', 'Photos'), root('fold_b', 'Trips')],
        ['Photos (migrated)', 'PHOTOS'],
      ),
    ).toEqual([
      { folderId: 'fold_a', from: 'Photos', to: 'Photos (migrated 2)' },
      // `Trips` collides with nothing, so it keeps its name.
    ]);
  });

  it('never hands two colliding roots the same replacement name', () => {
    const renames = planRootRenames(
      [root('fold_a', 'Photos'), root('fold_b', 'Photos')],
      ['Photos'],
    );
    expect(renames.map((rename) => rename.to)).toEqual([
      'Photos (migrated)',
      'Photos (migrated 2)',
    ]);
  });

  it('leaves inner folders alone: their siblings move with them', () => {
    const folders: MigrationFolder[] = [
      { id: 'fold_a', name: 'Photos', parentId: null },
      { id: 'fold_b', name: 'Photos', parentId: 'fold_a' },
    ];
    expect(planRootRenames(folders, ['Photos'])).toEqual([
      { folderId: 'fold_a', from: 'Photos', to: 'Photos (migrated)' },
    ]);
  });

  it('fits a replacement inside the column limit', () => {
    const long = 'x'.repeat(255);
    const [rename] = planRootRenames([root('fold_a', long)], [long]);
    expect(rename?.to.length).toBeLessThanOrEqual(255);
    expect(rename?.to.endsWith('(migrated)')).toBe(true);
  });

  it('produces the same plan for the same input', () => {
    const folders = [root('fold_b', 'B'), root('fold_a', 'B')];
    const first = planRootRenames(folders, ['b']);
    const second = planRootRenames([...folders].reverse(), ['b']);
    expect(first).toEqual(second);
  });
});

/**
 * The request guard.
 *
 * `planMigrationRequest` is the only place a migration request is authorized, and the route calls it
 * before touching the database. Each refusal below fails if the corresponding rule is dropped:
 * remove the `account:manage` requirement and an API key starts absorbing sessions; drop the
 * identity-derived target and there is nothing left to derive the destination account from, because
 * the route has no body at all.
 */

const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const SESSION_CREDENTIAL = `ods_${'b'.repeat(43)}`;

const sessionCredentialIdentity = (
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser => ({
  kind: 'user',
  principal: { kind: 'user', userId: ACCOUNT },
  credential: 'supabase_access_token',
  scopes: ['files:read', 'files:write', 'shares:write', 'account:read'],
  displayName: null,
  accountStatus: 'active',
  apiKeyId: null,
  apiKeyPrefix: null,
  credentialExpiresAt: null,
  ...overrides,
});

const apiKeyIdentity = (): ResolvedIdentity =>
  sessionCredentialIdentity({
    credential: 'api_key',
    scopes: ['files:write', 'files:read'],
    apiKeyId: 'key_0123456789012345678901234a',
    apiKeyPrefix: 'odk_4zrp37hg',
  });

const anonymousIdentity = (): ResolvedIdentity => ({
  kind: 'anonymous',
  principal: { kind: 'anonymous', sessionId: 'sess_0123456789abcdefghjkmnpqrs' },
  credential: 'anonymous_session',
  scopes: ['files:read', 'files:write', 'shares:write'],
  sessionExpiresAt: new Date('2026-10-21T10:00:00.000Z'),
});

function planRefusal(identity: RequestIdentity, presentedCredential: string | undefined): AppError {
  try {
    planMigrationRequest({ identity, presentedCredential });
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the request to be refused');
}

describe('planMigrationRequest', () => {
  it('takes the destination account from the verified identity', () => {
    const plan = planMigrationRequest({
      identity: sessionCredentialIdentity(),
      presentedCredential: SESSION_CREDENTIAL,
    });
    expect(plan).toEqual({
      targetUserId: ACCOUNT,
      anonymousCredential: SESSION_CREDENTIAL,
    });
  });

  it('refuses an API key with 403: absorbing a session is an account change, not a file operation', () => {
    const refusal = planRefusal(apiKeyIdentity(), SESSION_CREDENTIAL);
    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.status).toBe(403);
    expect(refusal.detail).toContain('account:manage');
  });

  it('refuses an anonymous session with 403: it has no account to migrate into', () => {
    const refusal = planRefusal(anonymousIdentity(), SESSION_CREDENTIAL);
    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.status).toBe(403);
    expect(refusal.detail).toContain('registered account');
  });

  it('refuses a request with no credential at all with 401', () => {
    const refusal = planRefusal({ kind: 'none' }, SESSION_CREDENTIAL);
    expect(refusal.code).toBe('UNAUTHENTICATED');
    expect(refusal.status).toBe(401);
  });

  it('requires the session credential and names the header it wants', () => {
    for (const presented of [undefined, '', '   ']) {
      const refusal = planRefusal(sessionCredentialIdentity(), presented);
      expect(refusal.code).toBe('VALIDATION_FAILED');
      expect(refusal.status).toBe(400);
      expect(refusal.errors?.[0]?.path).toBe(ANONYMOUS_CREDENTIAL_HEADER);
    }
  });

  it('refuses a credential that is not an anonymous session credential, before any lookup', () => {
    for (const presented of [
      'not-a-credential',
      'ods_short',
      // A Supabase token in the session header is not a session credential either.
      'eyJhbGciOiJIUzI1NiJ9.e30.signature',
      // An API key is deliberately not accepted here: the session credential is the proof of
      // ownership, and a key is a different kind of thing entirely.
      'odk_4zrp37hg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      const refusal = planRefusal(sessionCredentialIdentity(), presented);
      expect(refusal.code).toBe('UNAUTHENTICATED');
      expect(refusal.status).toBe(401);
    }
  });

  it('accepts a credential padded with whitespace and passes on the trimmed value', () => {
    const plan = planMigrationRequest({
      identity: sessionCredentialIdentity(),
      presentedCredential: `  ${SESSION_CREDENTIAL}  `,
    });
    expect(plan.anonymousCredential).toBe(SESSION_CREDENTIAL);
  });

  it('never returns a field a caller could have supplied', () => {
    const plan = planMigrationRequest({
      identity: sessionCredentialIdentity(),
      presentedCredential: SESSION_CREDENTIAL,
    });
    // Exactly two fields, both derived: no account, session id or owner key can come from a request.
    expect(Object.keys(plan).sort()).toEqual(['anonymousCredential', 'targetUserId']);
  });
});

describe('assessQuota', () => {
  it('allows a migration that fits', () => {
    expect(
      assessQuota({ remainingBytes: 2048, remainingFiles: 10, needed: SOME_RESOURCES }),
    ).toEqual({ ok: true });
  });

  it('refuses when the files would not fit', () => {
    expect(
      assessQuota({ remainingBytes: 2048, remainingFiles: 2, needed: SOME_RESOURCES }),
    ).toEqual({
      ok: false,
      reason: 'file_count_exceeded',
    });
  });

  it('refuses when the bytes would not fit', () => {
    expect(
      assessQuota({ remainingBytes: 1023, remainingFiles: 10, needed: SOME_RESOURCES }),
    ).toEqual({
      ok: false,
      reason: 'storage_quota_exceeded',
    });
  });

  it('treats an exact fit as fitting', () => {
    expect(
      assessQuota({ remainingBytes: 1024, remainingFiles: 3, needed: SOME_RESOURCES }),
    ).toEqual({ ok: true });
  });
});
