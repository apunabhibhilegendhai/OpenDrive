import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createAccount, createFileFixture, createHarness, digest } from './harness.js';
import type { Harness } from './harness.js';

/**
 * Share links.
 *
 * A share token is a bearer credential, so the assertions split in two: what the API answers
 * (resolution, revocation, expiry, file state), and what the database holds (a digest, never the
 * token). Revocation and expiry are tested through the HTTP surface because that is where the
 * "takes effect on the next request" claim has to be true.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

interface ShareBody {
  id: string;
  fileId: string;
  kind: string;
  status: string;
  token: string;
  url: string;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
}

async function createShare(
  token: string,
  fileId: string,
  body: Record<string, unknown> = {},
): Promise<ShareBody> {
  const response = await h.server.inject({
    method: 'POST',
    url: '/api/v1/shares',
    headers: bearer(token),
    payload: { fileId, kind: 'unlisted', ...body },
  });
  if (response.statusCode !== 201) {
    throw new Error(`share creation failed with ${response.statusCode}: ${response.body}`);
  }
  return response.json<ShareBody>();
}

interface ProblemBody {
  code: string;
  detail: string;
  status: number;
  requestId: string;
}

/**
 * Resolves a share token through exactly one channel — the header by default, the body on request.
 * Sending it through both is a documented refusal, so a helper that did that by accident would
 * test the wrong thing.
 */
/** The parts of a light-my-request response these tests read. */
interface Response {
  statusCode: number;
  body: string;
  json: <T>() => T;
}

function resolve(
  token: string | null,
  options: { via?: 'header' | 'body'; omitBody?: boolean } = {},
): Promise<Response> {
  const via = options.via ?? 'header';
  const headers: Record<string, string> = {};
  if (via === 'header' && token !== null) headers['x-share-token'] = token;

  const request = { method: 'POST' as const, url: '/api/v1/shares/resolve', headers };
  if (options.omitBody === true) return h.server.inject(request);
  return h.server.inject({ ...request, payload: via === 'body' ? { token } : {} });
}

/**
 * A refusal, with everything except the request id.
 *
 * Request ids are per-request by nature and appear in every response, so two refusals that must be
 * indistinguishable are compared after removing it. The field is still checked for shape: dropping
 * it from the comparison would otherwise hide a response that had stopped emitting one at all.
 */
function problem(response: Response): Omit<ProblemBody, 'requestId'> {
  const body = response.json<ProblemBody>();
  expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const { requestId: _requestId, ...rest } = body;
  return rest;
}

describe('share creation', () => {
  it('returns the token once and stores only its digest', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);

    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.url).toContain(share.token);

    const rows = await h.sql<{ tokenHash: string; status: string }[]>`
      select token_hash as "tokenHash", status from shares where id = ${share.id}
    `;
    expect(rows[0]?.tokenHash).toBe(await digest(share.token));
    expect(rows[0]?.tokenHash).not.toContain(share.token);

    // No column of the row may contain the plaintext token.
    const raw = await h.sql`select * from shares where id = ${share.id}`;
    expect(JSON.stringify(raw)).not.toContain(share.token);
  });

  it('refuses a share for a file that is not servable yet', async () => {
    const account = await createAccount(h.sql);
    const pending = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
      state: 'pending_upload',
    });
    const response = await h.server.inject({
      method: 'POST',
      url: '/api/v1/shares',
      headers: bearer(account.token),
      payload: { fileId: pending, kind: 'public' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses a share for somebody else’s file', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: owner.userId },
    });

    const response = await h.server.inject({
      method: 'POST',
      url: '/api/v1/shares',
      headers: bearer(intruder.token),
      payload: { fileId, kind: 'public' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('share resolution', () => {
  it('resolves a valid link to the file it points at, without echoing the token', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);

    const response = await resolve(share.token);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      share: Record<string, unknown>;
      file: { id: string };
    };
    expect(body.file.id).toBe(fileId);
    expect(body.share.id).toBe(share.id);
    expect(Object.keys(body.share)).not.toContain('token');
    expect(response.body).not.toContain(share.token);
  });

  it('accepts the token from the header as well as the body, and with no body at all', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId, { kind: 'public' });

    // Header only, with an empty body.
    expect((await resolve(share.token)).statusCode).toBe(200);
    // Body only.
    expect((await resolve(share.token, { via: 'body' })).statusCode).toBe(200);
    // Header only, with no body at all: a missing body is null, and the schema accepts that.
    expect((await resolve(share.token, { omitBody: true })).statusCode).toBe(200);
  });

  it('refuses a token supplied in both places rather than choosing one', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);

    const response = await h.server.inject({
      method: 'POST',
      url: '/api/v1/shares/resolve',
      headers: { 'x-share-token': share.token },
      payload: { token: share.token },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers an unknown, tampered or malformed token as not found', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);
    const tampered = `${share.token.slice(0, -1)}${share.token.endsWith('A') ? 'B' : 'A'}`;

    const unknown = await resolve(`A${'b'.repeat(42)}`);
    const modified = await resolve(tampered);
    const short = await resolve('too-short');

    expect(unknown.statusCode).toBe(404);
    expect(modified.statusCode).toBe(404);
    expect(short.statusCode).toBe(400);
    // The same answer for a real-but-wrong token and an invented one.
    expect(problem(unknown)).toEqual(problem(modified));
  });

  it('refuses an expired link', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect((await resolve(share.token)).statusCode).toBe(200);
    await h.sql`update shares set expires_at = now() - interval '1 minute' where id = ${share.id}`;
    expect((await resolve(share.token)).statusCode).toBe(404);
  });

  it('refuses a link whose download allowance is used up', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId, { maxDownloads: 1 });

    expect((await resolve(share.token)).statusCode).toBe(200);
    await h.sql`update shares set download_count = 1 where id = ${share.id}`;
    expect((await resolve(share.token)).statusCode).toBe(404);
  });

  it('refuses a link to a file that is not (or is no longer) servable', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);
    expect((await resolve(share.token)).statusCode).toBe(200);

    // Quarantined after the link was handed out: the link must stop working.
    await h.sql`
      update files set status = 'quarantined', scan_state = 'infected' where id = ${fileId}
    `;
    expect((await resolve(share.token)).statusCode).toBe(404);
  });

  it('refuses a link whose file was soft-deleted', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);

    // `files_deleted_consistency` ties status and deleted_at together: a soft-deleted row is
    // `deleted` with a timestamp, never `deleting`.
    await h.sql`update files set status = 'deleted', deleted_at = now() where id = ${fileId}`;
    expect((await resolve(share.token)).statusCode).toBe(404);
  });
});

describe('share revocation', () => {
  it('takes effect on the very next resolution', async () => {
    const account = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
    });
    const share = await createShare(account.token, fileId);
    expect((await resolve(share.token)).statusCode).toBe(200);

    const revoked = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${share.id}`,
      headers: bearer(account.token),
    });
    expect(revoked.statusCode).toBe(204);

    const after = await resolve(share.token);
    expect(after.statusCode).toBe(404);
    // Indistinguishable from a token that never existed.
    expect(problem(after)).toEqual(problem(await resolve(`A${'b'.repeat(42)}`)));

    const rows = await h.sql<{ status: string; revokedAt: Date | null }[]>`
      select status, revoked_at as "revokedAt" from shares where id = ${share.id}
    `;
    expect(rows[0]?.status).toBe('revoked');
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it('refuses to revoke another owner’s link, and does not create one by guessing', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: owner.userId },
    });
    const share = await createShare(owner.token, fileId);

    const response = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${share.id}`,
      headers: bearer(intruder.token),
    });
    expect(response.statusCode).toBe(404);
    expect((await resolve(share.token)).statusCode).toBe(200);
  });
});
