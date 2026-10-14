import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileRecord } from '@opendrive/shared';
import {
  bearer,
  createAccount,
  createFileFixture,
  createHarness,
  digest,
  memoryStorage,
} from './harness.js';
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
/** The public routes are exercised with scanning off and real bytes, so an upload is servable. */
let pages: Harness;

beforeAll(async () => {
  h = await createHarness();
  pages = await createHarness({ MALWARE_SCAN_ENABLED: 'false' }, { storage: memoryStorage() });
});

afterAll(async () => {
  await h.close();
  await pages.close();
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

async function createShareOn(
  harness: Harness,
  token: string,
  fileId: string,
  body: Record<string, unknown> = {},
): Promise<ShareBody> {
  const response = await harness.server.inject({
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

function createShare(
  token: string,
  fileId: string,
  body: Record<string, unknown> = {},
): Promise<ShareBody> {
  return createShareOn(h, token, fileId, body);
}

/**
 * Uploads one small object through the real engine, so the share's byte route has a storage object
 * to stream. `createFileFixture` writes only the row, which is enough for a page but not a download.
 */
async function uploadOnePart(
  harness: Harness,
  token: string,
  filename: string,
  content: Buffer,
  mimeType: string,
): Promise<{ fileId: string; file: FileRecord }> {
  const initiated = await harness.server.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { filename, sizeBytes: content.byteLength, mimeType },
  });
  if (initiated.statusCode !== 201) {
    throw new Error(`initiate failed with ${initiated.statusCode}: ${initiated.body}`);
  }
  const { uploadId, fileId } = initiated.json<{ uploadId: string; fileId: string }>();

  const part = await harness.server.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/parts/1`,
    headers: {
      ...bearer(token),
      'content-type': 'application/octet-stream',
      'content-length': String(content.byteLength),
    },
    payload: content,
  });
  if (part.statusCode !== 200) {
    throw new Error(`part failed with ${part.statusCode}: ${part.body}`);
  }
  const completed = await harness.server.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/complete`,
    headers: bearer(token),
  });
  if (completed.statusCode !== 200) {
    throw new Error(`complete failed with ${completed.statusCode}: ${completed.body}`);
  }
  return { fileId, file: completed.json<{ file: FileRecord }>().file };
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

/**
 * The public face of a link, driven with no Authorization header — because that is exactly who
 * follows a share link. A second harness is used so the shared file is a real uploaded object with
 * bytes behind it, not only a row.
 */
describe('share landing page and download', () => {
  it('renders a landing page that embeds the file inline and links the download route', async () => {
    const account = await createAccount(pages.sql);
    const { fileId } = await uploadOnePart(
      pages,
      account.token,
      'photo.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );
    const share = await createShareOn(pages, account.token, fileId);

    const page = await pages.server.inject({ method: 'GET', url: `/s/${share.token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    // The page's own policy, not the stricter API default: proving the security hook leaves a
    // route-set CSP alone. `img-src`/`media-src` are unique to the page's policy.
    expect(page.headers['content-security-policy']).toContain("img-src 'self'");
    expect(page.headers['content-security-policy']).toContain("media-src 'self'");
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.body).toContain(`href="/s/${share.token}/download"`);
    expect(page.body).toContain('<img');
    expect(page.body).toContain('photo.png');

    // Opening the page is the counted event.
    const rows = await pages.sql<{ downloadCount: number }[]>`
      select download_count as "downloadCount" from shares where id = ${share.id}
    `;
    expect(rows[0]?.downloadCount).toBe(1);
  });

  it('streams the shared bytes byte-exactly, honours a range, and never counts itself', async () => {
    const account = await createAccount(pages.sql);
    const bytes = Buffer.from('0123456789abcdef', 'utf8');
    const { fileId } = await uploadOnePart(
      pages,
      account.token,
      'blob.bin',
      bytes,
      'application/octet-stream',
    );
    const share = await createShareOn(pages, account.token, fileId);

    const whole = await pages.server.inject({ method: 'GET', url: `/s/${share.token}/download` });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(bytes)).toBe(true);
    expect(whole.headers['content-disposition']).toMatch(/^attachment;/);
    expect(whole.headers['accept-ranges']).toBe('bytes');

    const ranged = await pages.server.inject({
      method: 'GET',
      url: `/s/${share.token}/download`,
      headers: { range: 'bytes=2-5' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect(ranged.rawPayload.equals(bytes.subarray(2, 6))).toBe(true);

    // The byte route cannot raise the counter: the page is what consumes the allowance.
    const rows = await pages.sql<{ downloadCount: number }[]>`
      select download_count as "downloadCount" from shares where id = ${share.id}
    `;
    expect(rows[0]?.downloadCount).toBe(0);
  });

  it('serves an image inline so the landing page can display it', async () => {
    const account = await createAccount(pages.sql);
    const { fileId } = await uploadOnePart(
      pages,
      account.token,
      'p.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );
    const share = await createShareOn(pages, account.token, fileId);

    const response = await pages.server.inject({
      method: 'GET',
      url: `/s/${share.token}/download`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('answers a revoked or unknown link with the same unavailable page at both routes', async () => {
    const account = await createAccount(pages.sql);
    const { fileId } = await uploadOnePart(
      pages,
      account.token,
      'x.bin',
      Buffer.from('x'),
      'application/octet-stream',
    );
    const share = await createShareOn(pages, account.token, fileId);

    const revoked = await pages.server.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${share.id}`,
      headers: bearer(account.token),
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await pages.server.inject({ method: 'GET', url: `/s/${share.token}` });
    const unknown = await pages.server.inject({ method: 'GET', url: `/s/${'A'.repeat(43)}` });
    expect(afterRevoke.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(afterRevoke.body).toBe(unknown.body);

    expect(
      (await pages.server.inject({ method: 'GET', url: `/s/${share.token}/download` })).statusCode,
    ).toBe(404);
  });

  it('counts one open per page load and refuses the next past the cap', async () => {
    const account = await createAccount(pages.sql);
    const { fileId } = await uploadOnePart(
      pages,
      account.token,
      'once.bin',
      Buffer.from('once'),
      'application/octet-stream',
    );
    const share = await createShareOn(pages, account.token, fileId, { maxDownloads: 1 });

    expect(
      (await pages.server.inject({ method: 'GET', url: `/s/${share.token}` })).statusCode,
    ).toBe(200);

    const second = await pages.server.inject({ method: 'GET', url: `/s/${share.token}` });
    expect(second.statusCode).toBe(410);
    expect(second.body).toContain('Download limit reached');
  });
});
