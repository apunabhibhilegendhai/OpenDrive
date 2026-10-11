import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createAccount,
  createAnonymousSession,
  createFileFixture,
  createHarness,
} from './harness.js';
import type { Harness } from './harness.js';

/**
 * Ownership.
 *
 * Every case here is a direct-object-reference attempt: the caller knows or guesses an identifier
 * that belongs to somebody else and asks for it anyway. The expected outcome is not "403 Forbidden"
 * but "404 Not Found" — a file id that exists and one that does not must be indistinguishable, or
 * the API becomes an existence oracle for other people's data.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('file metadata isolation', () => {
  it('lets the owner read their own file', async () => {
    const owner = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: owner.userId },
    });

    const response = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}`,
      headers: bearer(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ id: string; owner: { kind: string }; visibility: string }>();
    expect(body.id).toBe(fileId);
    expect(body.owner.kind).toBe('user');
    expect(body.visibility).toBe('private');
  });

  it('answers another user’s file exactly like a file that does not exist', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: owner.userId },
    });

    const foreign = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}`,
      headers: bearer(intruder.token),
    });
    const missing = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files/file_0123456789012345678901234a',
      headers: bearer(intruder.token),
    });

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Identical except for the request id and the instance URL, which are per-request by design.
    const projection = (response: { json: <T>() => T }) => {
      const problem = response.json<{ code: string; detail: string; status: number }>();
      return { code: problem.code, detail: problem.detail, status: problem.status };
    };
    expect(projection(foreign)).toEqual(projection(missing));
  });

  it('never lists another owner’s files', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const mine = await createFileFixture(h.sql, { owner: { kind: 'user', userId: owner.userId } });
    const theirs = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: intruder.userId },
    });

    const ownerList = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(owner.token),
    });
    const ids = ownerList.json<{ items: { id: string }[] }>().items.map((item) => item.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);

    const intruderList = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: bearer(intruder.token),
    });
    const intruderIds = intruderList
      .json<{ items: { id: string }[] }>()
      .items.map((item) => item.id);
    expect(intruderIds).toContain(theirs);
    expect(intruderIds).not.toContain(mine);
  });

  it('keeps two anonymous sessions apart', async () => {
    const first = await createAnonymousSession(h);
    const second = await createAnonymousSession(h);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'anonymous', sessionId: first.sessionId },
    });

    const own = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}`,
      headers: bearer(first.credential),
    });
    expect(own.statusCode).toBe(200);

    const other = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}`,
      headers: bearer(second.credential),
    });
    expect(other.statusCode).toBe(404);
  });

  it('does not let an anonymous session see a registered user’s file, or the reverse', async () => {
    const account = await createAccount(h.sql);
    const session = await createAnonymousSession(h);
    const userFile = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const sessionFile = await createFileFixture(h.sql, {
      owner: { kind: 'anonymous', sessionId: session.sessionId },
    });

    expect(
      (
        await h.server.inject({
          method: 'GET',
          url: `/api/v1/files/${userFile}`,
          headers: bearer(session.credential),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.server.inject({
          method: 'GET',
          url: `/api/v1/files/${sessionFile}`,
          headers: bearer(account.token),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('ignores ownership fields supplied in a request body', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);

    const created = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(owner.token),
      payload: {
        name: 'Documents',
        // Fields the contract does not define, including one that would transfer ownership.
        ownerUserId: intruder.userId,
        owner_session_id: 'sess_0123456789abcdefghjkmnpqrs',
        owner: { kind: 'user', userId: intruder.userId },
      },
    });
    expect(created.statusCode).toBe(201);
    const folderId = created.json<{ id: string }>().id;

    const rows = await h.sql<{ ownerUserId: string | null; ownerSessionId: string | null }[]>`
      select owner_user_id as "ownerUserId", owner_session_id as "ownerSessionId"
        from folders where id = ${folderId}
    `;
    expect(rows[0]?.ownerUserId).toBe(owner.userId);
    expect(rows[0]?.ownerSessionId).toBeNull();
  });
});

describe('folder tree invariants', () => {
  it('creates nested folders and reports depth, then refuses a cycle', async () => {
    const account = await createAccount(h.sql);
    const root = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Root' },
    });
    const rootId = root.json<{ id: string; depth: number }>().id;
    expect(root.json<{ depth: number }>().depth).toBe(0);

    const child = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Child', parentId: rootId },
    });
    expect(child.statusCode).toBe(201);
    const childId = child.json<{ id: string; depth: number }>().id;
    expect(child.json<{ depth: number }>().depth).toBe(1);

    const cycle = await h.server.inject({
      method: 'PATCH',
      url: `/api/v1/folders/${rootId}`,
      headers: bearer(account.token),
      payload: { parentId: childId },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json<{ detail: string }>().detail).toMatch(/ancestor|descendant|parent/i);
  });

  it('refuses a parent that belongs to another owner, as not found', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const foreign = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(owner.token),
      payload: { name: 'Private' },
    });
    const foreignId = foreign.json<{ id: string }>().id;

    const attempt = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(intruder.token),
      payload: { name: 'Nested', parentId: foreignId },
    });
    expect(attempt.statusCode).toBe(404);

    // Moving into someone else's folder is refused the same way.
    const own = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(intruder.token),
      payload: { name: 'Mine' },
    });
    const ownId = own.json<{ id: string }>().id;
    const move = await h.server.inject({
      method: 'PATCH',
      url: `/api/v1/folders/${ownId}`,
      headers: bearer(intruder.token),
      payload: { parentId: foreignId },
    });
    expect(move.statusCode).toBe(404);
  });

  it('refuses a duplicate sibling name but allows the same name in another folder', async () => {
    const account = await createAccount(h.sql);
    const first = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Photos' },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'photos' },
    });
    expect(duplicate.statusCode).toBe(409);

    const nested = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Photos', parentId: first.json<{ id: string }>().id },
    });
    expect(nested.statusCode).toBe(201);
  });

  it('soft-deletes an empty folder and refuses a folder that still holds something', async () => {
    const account = await createAccount(h.sql);
    const parent = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Parent' },
    });
    const parentId = parent.json<{ id: string }>().id;

    const child = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Child', parentId },
    });
    const childId = child.json<{ id: string }>().id;

    const refuse = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/folders/${parentId}`,
      headers: bearer(account.token),
    });
    expect(refuse.statusCode).toBe(409);

    await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/folders/${childId}`,
      headers: bearer(account.token),
    });
    // A file in the folder counts as content too.
    await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
      folderId: parentId,
    });
    const stillRefused = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/folders/${parentId}`,
      headers: bearer(account.token),
    });
    expect(stillRefused.statusCode).toBe(409);

    const childRows = await h.sql<{ deletedAt: Date | null }[]>`
      select deleted_at as "deletedAt" from folders where id = ${childId}
    `;
    expect(childRows[0]?.deletedAt).not.toBeNull();

    const gone = await h.server.inject({
      method: 'GET',
      url: '/api/v1/folders',
      headers: bearer(account.token),
    });
    expect(gone.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(
      childId,
    );
  });

  it('lists only folders with the matching parent', async () => {
    const account = await createAccount(h.sql);
    const root = await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Alpha' },
    });
    const rootId = root.json<{ id: string }>().id;
    await h.server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: bearer(account.token),
      payload: { name: 'Beta', parentId: rootId },
    });

    const roots = await h.server.inject({
      method: 'GET',
      url: '/api/v1/folders?parent=root',
      headers: bearer(account.token),
    });
    expect(roots.json<{ items: { name: string }[] }>().items.map((item) => item.name)).toContain(
      'Alpha',
    );
    expect(
      roots.json<{ items: { name: string }[] }>().items.map((item) => item.name),
    ).not.toContain('Beta');

    const children = await h.server.inject({
      method: 'GET',
      url: `/api/v1/folders?parent=${rootId}`,
      headers: bearer(account.token),
    });
    expect(children.json<{ items: { name: string }[] }>().items.map((item) => item.name)).toEqual([
      'Beta',
    ]);
  });
});

describe('pagination', () => {
  it('walks every file exactly once with opaque cursors', async () => {
    const account = await createAccount(h.sql);
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(
        await createFileFixture(h.sql, {
          owner: { kind: 'user', userId: account.userId },
          filename: `page-${index}.bin`,
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url: string =
        cursor === null ? '/api/v1/files?limit=2' : `/api/v1/files?limit=2&cursor=${cursor}`;
      const response = await h.server.inject({
        method: 'GET',
        url,
        headers: bearer(account.token),
      });
      expect(response.statusCode).toBe(200);
      const body: { items: { id: string }[]; nextCursor: string | null } = response.json();
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
      // The cursor must not disclose the row id it came from.
      expect(cursor).not.toContain('file_');
    }

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of created) expect(seen).toContain(id);
    expect(cursor).toBeNull();
  });

  it('refuses a malformed cursor instead of silently restarting', async () => {
    const account = await createAccount(h.sql);
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/files?cursor=not-a-cursor',
      headers: bearer(account.token),
    });
    expect(response.statusCode).toBe(400);
  });
});
