import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256HexOfBytes } from '@opendrive/shared';
import type { FileRecord } from '@opendrive/shared';
import {
  bearer,
  createAccount,
  createAnonymousSession,
  createHarness,
  memoryStorage,
  setAccountLimits,
} from './harness.js';
import type { Harness } from './harness.js';

/**
 * The upload engine, end to end.
 *
 * These tests drive the real workflow — initiate, parts, complete — through the HTTP layer against
 * the real file and quota tables, with an in-memory provider standing in for the bytes. Everything
 * that decides *what is allowed* is real: ownership, the quota hold, the lifecycle transitions and
 * the deletion token. Only the network round trip to a storage backend is replaced, because that is
 * the one part already covered by the provider contract suite.
 *
 * Scanning is disabled here: with it on, a completed file stops at `scanning` and is not servable,
 * which would make the download assertions test the scanner rather than the upload engine.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ MALWARE_SCAN_ENABLED: 'false' }, { storage: memoryStorage() });
});

afterAll(async () => {
  await h.close();
});

interface Initiated {
  uploadId: string;
  fileId: string;
  chunkSizeBytes: number;
  deletionToken?: string;
}

async function initiate(
  token: string,
  body: { filename: string; sizeBytes: number; mimeType?: string; checksumSha256?: string },
): Promise<Initiated> {
  const response = await h.server.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: {
      filename: body.filename,
      sizeBytes: body.sizeBytes,
      mimeType: body.mimeType ?? 'application/octet-stream',
      ...(body.checksumSha256 === undefined ? {} : { checksumSha256: body.checksumSha256 }),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Initiated>();
}

async function putPart(
  token: string,
  uploadId: string,
  partNumber: number,
  content: Buffer,
): Promise<ReturnType<Harness['server']['inject']>> {
  const checksum = await sha256HexOfBytes(content);
  return h.server.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/parts/${partNumber}`,
    headers: {
      ...bearer(token),
      'content-type': 'application/octet-stream',
      'content-length': String(content.byteLength),
      'x-part-checksum-sha256': checksum,
    },
    payload: content,
  });
}

async function complete(token: string, uploadId: string) {
  return h.server.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/complete`,
    headers: bearer(token),
  });
}

/**
 * Completion is the step that can fail server-side for a reason the client is deliberately not told
 * about. When it does, attach the captured server error so the failure names the real cause rather
 * than leaving the reader with "expected 200, received 500".
 */
async function completeOrFail(token: string, uploadId: string) {
  const response = await complete(token, uploadId);
  if (response.statusCode !== 200) {
    throw new Error(
      `complete returned ${response.statusCode}: ${response.payload}\n` +
        `server error log:\n${h.logs.join('')}`,
    );
  }
  return response;
}

/** A registered user who can upload, plus the id of one file uploaded in a single part. */
async function uploadOnePart(token: string, filename: string, content: Buffer) {
  const initiated = await initiate(token, { filename, sizeBytes: content.byteLength });
  const part = await putPart(token, initiated.uploadId, 1, content);
  expect(part.statusCode).toBe(200);
  const completed = await completeOrFail(token, initiated.uploadId);
  return { ...initiated, file: completed.json<{ file: FileRecord }>().file };
}

describe('upload workflow', () => {
  it('uploads a file, persists its object, and streams the exact bytes back', async () => {
    const account = await createAccount(h.sql);
    const content = Buffer.from('the quick brown fox jumps over the lazy dog');

    const { fileId, file } = await uploadOnePart(account.token, 'notes.txt', content);

    expect(file.id).toBe(fileId);
    expect(file.status).toBe('ready');
    expect(file.sizeBytes).toBe(content.byteLength);

    // The locator is persisted, is active, and never appears in the metadata response.
    const objects = await h.sql<{ state: string; sizeBytes: number }[]>`
      select state, size_bytes as "sizeBytes" from storage_objects where file_id = ${fileId}
    `;
    expect(objects).toHaveLength(1);
    expect(objects[0]?.state).toBe('active');
    expect(objects[0]?.sizeBytes).toBe(content.byteLength);
    expect(JSON.stringify(file)).not.toContain('locator');

    const download = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}/content`,
      headers: bearer(account.token),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-length']).toBe(String(content.byteLength));
    expect(download.rawPayload.equals(content)).toBe(true);
  });

  it('assembles a multi-part object in order', async () => {
    const account = await createAccount(h.sql);
    const chunkSize = 1024 * 1024; // the effective part size the provider advertises
    const first = Buffer.alloc(chunkSize, 0x41); // 'A'
    const second = Buffer.alloc(chunkSize, 0x42); // 'B'
    const content = Buffer.concat([first, second]);

    const initiated = await initiate(account.token, {
      filename: 'two-parts.bin',
      sizeBytes: content.byteLength,
    });
    expect(initiated.chunkSizeBytes).toBe(chunkSize);

    // Sent out of order: the provider reassembles by part number, not arrival order.
    expect((await putPart(account.token, initiated.uploadId, 2, second)).statusCode).toBe(200);
    expect((await putPart(account.token, initiated.uploadId, 1, first)).statusCode).toBe(200);

    const completed = await completeOrFail(account.token, initiated.uploadId);
    expect(completed.json<{ file: FileRecord }>().file.sizeBytes).toBe(content.byteLength);

    const download = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${initiated.fileId}/content`,
      headers: bearer(account.token),
    });
    expect(download.rawPayload.equals(content)).toBe(true);
  });

  it('reports progress and completes only once a whole object is present', async () => {
    const account = await createAccount(h.sql);
    const content = Buffer.alloc(2048, 0x7a);
    const initiated = await initiate(account.token, {
      filename: 'progress.bin',
      sizeBytes: content.byteLength,
    });

    const empty = await h.server.inject({
      method: 'GET',
      url: `/api/v1/uploads/${initiated.uploadId}`,
      headers: bearer(account.token),
    });
    expect(empty.json<{ state: string; partsReceived: number }>().state).toBe('initiated');
    expect(empty.json<{ partsReceived: number }>().partsReceived).toBe(0);

    // A completion before the bytes are present is refused, and the file does not become servable.
    const premature = await complete(account.token, initiated.uploadId);
    expect([409, 422]).toContain(premature.statusCode);

    expect((await putPart(account.token, initiated.uploadId, 1, content)).statusCode).toBe(200);
    const progress = await h.server.inject({
      method: 'GET',
      url: `/api/v1/uploads/${initiated.uploadId}`,
      headers: bearer(account.token),
    });
    expect(progress.json<{ state: string; partsReceived: number }>().state).toBe('in_progress');
    expect(progress.json<{ partsReceived: number }>().partsReceived).toBe(1);

    await completeOrFail(account.token, initiated.uploadId);
  });

  it('refuses to serve a file that is not yet ready', async () => {
    const account = await createAccount(h.sql);
    const content = Buffer.from('not finished');
    const initiated = await initiate(account.token, {
      filename: 'unfinished.bin',
      sizeBytes: content.byteLength,
    });

    const download = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${initiated.fileId}/content`,
      headers: bearer(account.token),
    });
    expect(download.statusCode).toBe(409);
  });
});

describe('upload isolation', () => {
  it('answers another account’s upload exactly like an unknown one', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const initiated = await initiate(owner.token, {
      filename: 'private.bin',
      sizeBytes: 16,
    });

    const foreign = await h.server.inject({
      method: 'GET',
      url: `/api/v1/uploads/${initiated.uploadId}`,
      headers: bearer(intruder.token),
    });
    const missing = await h.server.inject({
      method: 'GET',
      url: '/api/v1/uploads/upl_0123456789012345678901234a',
      headers: bearer(intruder.token),
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);

    const complete = await h.server.inject({
      method: 'POST',
      url: `/api/v1/uploads/${initiated.uploadId}/complete`,
      headers: bearer(intruder.token),
    });
    expect(complete.statusCode).toBe(404);
  });

  it('never serves another account’s file content', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const { fileId } = await uploadOnePart(owner.token, 'mine.bin', Buffer.from('secret'));

    const download = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}/content`,
      headers: bearer(intruder.token),
    });
    expect(download.statusCode).toBe(404);
  });
});

describe('abort', () => {
  it('releases the quota hold and fails the file', async () => {
    const account = await createAccount(h.sql);
    const initiated = await initiate(account.token, {
      filename: 'abandoned.bin',
      sizeBytes: 4096,
    });
    expect(
      (await putPart(account.token, initiated.uploadId, 1, Buffer.alloc(4096))).statusCode,
    ).toBe(200);

    const aborted = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/uploads/${initiated.uploadId}`,
      headers: bearer(account.token),
    });
    expect(aborted.statusCode).toBe(204);

    const rows = await h.sql<{ status: string }[]>`
      select status from files where id = ${initiated.fileId}
    `;
    expect(rows[0]?.status).toBe('failed');

    // No object was ever committed, and the hold was released rather than left held.
    const objects = await h.sql`select 1 from storage_objects where file_id = ${initiated.fileId}`;
    expect(objects).toHaveLength(0);
    const reservations = await h.sql<{ state: string }[]>`
      select state from quota_reservations where file_id = ${initiated.fileId}
    `;
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.state).toBe('released');
  });
});

describe('deletion', () => {
  it('lets the owner delete a file, and stops serving it', async () => {
    const account = await createAccount(h.sql);
    const { fileId } = await uploadOnePart(account.token, 'delete-me.bin', Buffer.from('bye'));

    const deleted = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/files/${fileId}`,
      headers: bearer(account.token),
    });
    expect(deleted.statusCode).toBe(204);

    const rows = await h.sql<{ status: string; deletedAt: Date | null }[]>`
      select status, deleted_at as "deletedAt" from files where id = ${fileId}
    `;
    expect(rows[0]?.status).toBe('deleted');
    expect(rows[0]?.deletedAt).not.toBeNull();

    const objects = await h.sql<{ state: string }[]>`
      select state from storage_objects where file_id = ${fileId}
    `;
    expect(objects[0]?.state).toBe('deleted');

    const download = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}/content`,
      headers: bearer(account.token),
    });
    expect(download.statusCode).toBe(404);
  });

  it('lets an anonymous uploader delete with the token, and nobody else', async () => {
    const session = await createAnonymousSession(h);
    const content = Buffer.from('anonymous bytes');
    const initiated = await initiate(session.credential, {
      filename: 'anon.bin',
      sizeBytes: content.byteLength,
    });
    expect(initiated.deletionToken).toBeDefined();
    const deletionToken = initiated.deletionToken ?? '';

    expect((await putPart(session.credential, initiated.uploadId, 1, content)).statusCode).toBe(
      200,
    );
    expect((await complete(session.credential, initiated.uploadId)).statusCode).toBe(200);

    // A wrong token is indistinguishable from a missing file.
    const wrong = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/files/${initiated.fileId}`,
      headers: { 'x-deletion-token': 'not-the-token-but-long-enough' },
    });
    expect(wrong.statusCode).toBe(404);

    // Without any credential or token, the caller is not authenticated at all.
    const none = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/files/${initiated.fileId}`,
    });
    expect(none.statusCode).toBe(401);

    const deleted = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/files/${initiated.fileId}`,
      headers: { 'x-deletion-token': deletionToken },
    });
    expect(deleted.statusCode).toBe(204);
  });
});

describe('enforcement', () => {
  it('refuses a file larger than the account limit, before any bytes move', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { maxFileSizeBytes: 100 });

    const response = await h.server.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { ...bearer(account.token), 'content-type': 'application/json' },
      payload: { filename: 'too-big.bin', sizeBytes: 200, mimeType: 'application/octet-stream' },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe('PAYLOAD_TOO_LARGE');

    // The refused attempt leaves no live metadata row behind.
    const rows = await h.sql<{ status: string }[]>`
      select status from files where owner_user_id = ${account.userId}
    `;
    expect(rows.every((row) => row.status === 'deleted')).toBe(true);
  });

  it('bounds how many uploads one principal may hold open at once', async () => {
    const account = await createAccount(h.sql);
    // The default cap is three; open four and the fourth must be refused with a 429.
    for (let index = 0; index < 3; index += 1) {
      await initiate(account.token, { filename: `open-${index}.bin`, sizeBytes: 8 });
    }
    const response = await h.server.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { ...bearer(account.token), 'content-type': 'application/json' },
      payload: { filename: 'one-too-many.bin', sizeBytes: 8, mimeType: 'application/octet-stream' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json<{ code: string }>().code).toBe('RATE_LIMITED');
  });

  it('refuses a part bigger than the advertised chunk size', async () => {
    const account = await createAccount(h.sql);
    const initiated = await initiate(account.token, { filename: 'big-part.bin', sizeBytes: 4096 });
    const oversize = Buffer.alloc(initiated.chunkSizeBytes + 1);
    const response = await h.server.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${initiated.uploadId}/parts/1`,
      headers: {
        ...bearer(account.token),
        'content-type': 'application/octet-stream',
        'content-length': String(oversize.byteLength),
      },
      payload: oversize,
    });
    expect(response.statusCode).toBe(413);
  });
});
