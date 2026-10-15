import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migrateAnonymousSessionResponseSchema,
  newId,
  problemDetailsSchema,
} from '@opendrive/shared';
import {
  bearer,
  createAccount,
  createApiKey,
  createAnonymousSession,
  createFileFixture,
  createHarness,
  setAccountLimits,
} from './harness.js';
import type { Harness } from './harness.js';

/**
 * Bringing an anonymous session's resources into an account, end to end.
 *
 * These are the claims that only a real database can settle: that ownership actually moves, that the
 * credential that owned it stops working, that a second account is refused without being told which
 * account holds the data, and that a refusal leaves nothing half-transferred. Everything below goes
 * through the HTTP route, so the authorization the route performs is what is being tested — the
 * pure decision logic has its own unit tests in apps/api/src/identity/migration.test.ts.
 *
 * Requires a scratch PostgreSQL (run with `pnpm db:test:integration`); see harness.ts.
 */

const MIGRATIONS_URL = '/api/v1/identity/migrations';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

interface SeededSession {
  sessionId: string;
  credential: string;
  folderId: string;
  readyFileId: string;
  pendingFileId: string;
}

/** A session holding one durable file inside a folder and one unfinished upload. */
async function seedSession(): Promise<SeededSession> {
  const session = await createAnonymousSession(h);
  const folderId = newId('folder');
  await h.sql`
    insert into folders (id, owner_session_id, name, depth)
    values (${folderId}, ${session.sessionId}, 'Charts', 0)
  `;
  const readyFileId = await createFileFixture(h.sql, {
    owner: { kind: 'anonymous', sessionId: session.sessionId },
    folderId,
    state: 'ready',
    sizeBytes: 4096,
    filename: 'chart.png',
  });
  const pendingFileId = await createFileFixture(h.sql, {
    owner: { kind: 'anonymous', sessionId: session.sessionId },
    state: 'pending_upload',
    sizeBytes: 512,
    filename: 'unfinished.bin',
  });
  return {
    sessionId: session.sessionId,
    credential: session.credential,
    folderId,
    readyFileId,
    pendingFileId,
  };
}

function migrate(credential: string, sessionCredential: string) {
  return h.server.inject({
    method: 'POST',
    url: MIGRATIONS_URL,
    headers: { ...bearer(credential), 'x-anonymous-credential': sessionCredential },
  });
}

describe('migration into an account', () => {
  it('moves ownership, revokes the session, and closes what could not move', async () => {
    const account = await createAccount(h.sql);
    const seeded = await seedSession();

    const response = await migrate(account.token, seeded.credential);
    expect(response.statusCode).toBe(201);
    const body = migrateAnonymousSessionResponseSchema.parse(response.json());
    expect(body.alreadyMigrated).toBe(false);
    expect(body.targetUserId).toBe(account.userId);
    expect(body.files).toEqual({ count: 1, bytes: 4096 });
    expect(body.folders).toEqual({ count: 1 });
    expect(body.skippedIncompleteFiles).toBe(1);

    // The durable file is the account's, with its owner key rewritten by the database itself and
    // the anonymous deletion token cleared: a credential that no longer exists must not be able to
    // delete an account's file.
    const file = await h.sql`
      select owner_user_id, owner_session_id, owner_key, deletion_token_hash, folder_id
        from files where id = ${seeded.readyFileId}
    `;
    expect(file[0]?.owner_user_id).toBe(account.userId);
    expect(file[0]?.owner_session_id).toBeNull();
    expect(file[0]?.owner_key).toBe(account.userId);
    expect(file[0]?.deletion_token_hash).toBeNull();
    expect(file[0]?.folder_id).toBe(seeded.folderId);

    // The unfinished upload has no bytes to hand over, so it is closed — detached from the folder
    // that is now the account's, and still nobody's file.
    const pending = await h.sql`
      select owner_user_id, owner_session_id, status, deleted_at, folder_id
        from files where id = ${seeded.pendingFileId}
    `;
    expect(pending[0]?.status).toBe('deleted');
    expect(pending[0]?.deleted_at).not.toBeNull();
    expect(pending[0]?.owner_user_id).toBeNull();
    expect(pending[0]?.folder_id).toBeNull();

    // The session is revoked the moment its data has an owner, and the record says where it went.
    const session = await h.sql`
      select status, migrated_at, migrated_to_user_id, migrated_file_count, migrated_bytes
        from anonymous_sessions where id = ${seeded.sessionId}
    `;
    expect(session[0]?.status).toBe('revoked');
    expect(session[0]?.migrated_at).not.toBeNull();
    expect(session[0]?.migrated_to_user_id).toBe(account.userId);
    expect(Number(session[0]?.migrated_file_count)).toBe(1);
    expect(Number(session[0]?.migrated_bytes)).toBe(4096);

    // The credential that authenticated the session stops working: the same rows cannot be reached
    // by two principals.
    const sessionRead = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(seeded.credential),
    });
    expect(sessionRead.statusCode).toBe(401);

    // The account sees the file; an unrelated account sees nothing of it.
    const asOwner = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(account.token),
    });
    expect(asOwner.statusCode).toBe(200);
    const ownerItems = asOwner.json<{ items: { id: string }[] }>().items;
    expect(ownerItems.map((item) => item.id)).toEqual([seeded.readyFileId]);

    const other = await createAccount(h.sql);
    const asOther = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(other.token),
    });
    expect(asOther.json<{ items: unknown[] }>().items).toEqual([]);

    // The transfer is an auditable account change.
    const audit = await h.sql`
      select count(*)::int as count from audit_events
       where action = 'anonymous_session.migrated' and actor_user_id = ${account.userId}
    `;
    expect(audit[0]?.count).toBe(1);
  });

  it('answers a repeat from the record instead of moving anything twice', async () => {
    const account = await createAccount(h.sql);
    const seeded = await seedSession();

    const first = migrate(account.token, seeded.credential);
    const second = migrate(account.token, seeded.credential);
    const [a, b] = await Promise.all([first, second]);
    // The row lock serialises them; whichever lands second reports the replay.
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toContain(201);
    const replay = a.statusCode === 200 ? a : b;
    expect(replay.statusCode).toBe(200);
    const body = migrateAnonymousSessionResponseSchema.parse(replay.json());
    expect(body.alreadyMigrated).toBe(true);
    // The recorded counts are repeated, not recomputed from rows that are no longer the session's.
    expect(body.files).toEqual({ count: 1, bytes: 4096 });

    const file = await h.sql`
      select owner_user_id from files where id = ${seeded.readyFileId}
    `;
    expect(file[0]?.owner_user_id).toBe(account.userId);
  });

  it('refuses a second account with 409 and never names the first', async () => {
    const first = await createAccount(h.sql);
    const second = await createAccount(h.sql);
    const seeded = await seedSession();

    await migrate(first.token, seeded.credential);

    const response = await migrate(second.token, seeded.credential);
    expect(response.statusCode).toBe(409);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('CONFLICT');
    expect(problem.detail).toContain('already been brought into an account');
    // Which account received it is a fact about that account, so it is not disclosed.
    expect(JSON.stringify(problem)).not.toContain(first.userId);
    expect(JSON.stringify(problem)).not.toContain(first.email);

    // Nothing moved: the first account still owns the file and the second still sees nothing.
    const file = await h.sql`select owner_user_id from files where id = ${seeded.readyFileId}`;
    expect(file[0]?.owner_user_id).toBe(first.userId);
    const asSecond = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(second.token),
    });
    expect(asSecond.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('refuses credentials that may not move data between principals', async () => {
    const account = await createAccount(h.sql);
    const seeded = await seedSession();

    // An anonymous session has no account to migrate into: it would be migrating into itself.
    const asSession = await h.server.inject({
      method: 'POST',
      url: MIGRATIONS_URL,
      headers: {
        ...bearer(seeded.credential),
        'x-anonymous-credential': seeded.credential,
      },
    });
    expect(asSession.statusCode).toBe(403);
    expect(problemDetailsSchema.parse(asSession.json()).code).toBe('FORBIDDEN');

    // An API key manages files; it must not absorb another principal's resources.
    const key = await createApiKey(h, account.token, { scopes: ['files:write'] });
    const asKey = await h.server.inject({
      method: 'POST',
      url: MIGRATIONS_URL,
      headers: {
        'x-api-key': key.key,
        'x-anonymous-credential': seeded.credential,
      },
    });
    expect(asKey.statusCode).toBe(403);
    expect(problemDetailsSchema.parse(asKey.json()).detail).toContain('account:manage');

    // No credential at all is a 401, like every other identity-dependent route.
    const noCredential = await h.server.inject({
      method: 'POST',
      url: MIGRATIONS_URL,
      headers: { 'x-anonymous-credential': seeded.credential },
    });
    expect(noCredential.statusCode).toBe(401);

    // A missing session credential is a validation failure that names the header.
    const missingHeader = await h.server.inject({
      method: 'POST',
      url: MIGRATIONS_URL,
      headers: bearer(account.token),
    });
    expect(missingHeader.statusCode).toBe(400);
    const missingProblem = problemDetailsSchema.parse(missingHeader.json());
    expect(missingProblem.code).toBe('VALIDATION_FAILED');
    expect(missingProblem.errors?.[0]?.path).toBe('x-anonymous-credential');

    // A malformed credential is refused as unauthenticated before any lookup.
    const malformed = await migrate(account.token, 'not-a-session-credential');
    expect(malformed.statusCode).toBe(401);

    // None of those attempts changed anything.
    const session = await h.sql`
      select status, migrated_at from anonymous_sessions where id = ${seeded.sessionId}
    `;
    expect(session[0]?.status).toBe('active');
    expect(session[0]?.migrated_at).toBeNull();
    const file = await h.sql`
      select owner_session_id from files where id = ${seeded.readyFileId}
    `;
    expect(file[0]?.owner_session_id).toBe(seeded.sessionId);
  });

  it('refuses a migration the account has no room for, and moves nothing', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 1000 });
    const seeded = await seedSession();

    const response = await migrate(account.token, seeded.credential);
    expect(response.statusCode).toBe(429);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('QUOTA_EXCEEDED');

    // A refused migration is a no-op: the session is still active and still holds its file, so the
    // person can free space and try again rather than losing the transfer.
    const session = await h.sql`
      select status, migrated_at from anonymous_sessions where id = ${seeded.sessionId}
    `;
    expect(session[0]?.status).toBe('active');
    expect(session[0]?.migrated_at).toBeNull();

    const file = await h.sql`
      select owner_session_id, deleted_at from files where id = ${seeded.readyFileId}
    `;
    expect(file[0]?.owner_session_id).toBe(seeded.sessionId);
    expect(file[0]?.deleted_at).toBeNull();
  });

  it('keeps a name clash as a rename rather than a refusal', async () => {
    const account = await createAccount(h.sql);
    // The account already has a root folder with the name the session is bringing over.
    await h.sql`
      insert into folders (id, owner_user_id, name, depth)
      values (${newId('folder')}, ${account.userId}, 'Charts', 0)
    `;
    const seeded = await seedSession();

    const response = await migrate(account.token, seeded.credential);
    expect(response.statusCode).toBe(201);
    const body = migrateAnonymousSessionResponseSchema.parse(response.json());
    expect(body.folderRenames).toHaveLength(1);
    expect(body.folderRenames[0]?.from).toBe('Charts');
    expect(body.folderRenames[0]?.to).toBe('Charts (migrated)');

    // Two roots, two distinct names, one owner.
    const root = await h.sql`
      select count(*)::int as count from folders
       where owner_user_id = ${account.userId} and parent_id is null and deleted_at is null
    `;
    expect(root[0]?.count).toBe(2);
    const renamed = await h.sql`
      select name from folders where id = ${body.folderRenames[0]?.folderId ?? ''}
    `;
    expect(renamed[0]?.name).toBe('Charts (migrated)');
  });
});
