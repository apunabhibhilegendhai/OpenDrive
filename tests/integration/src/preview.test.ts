import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemDetailsSchema, previewGrantSchema } from '@opendrive/shared';
import type { FileRecord } from '@opendrive/shared';
import { bearer, createAccount, createHarness, memoryStorage } from './harness.js';
import type { Harness } from './harness.js';

/**
 * Inline preview grants, end to end.
 *
 * A preview grant exists for one reason: a `<img>`/`<video>`/`<audio>` element cannot attach an
 * `Authorization` header, so the token travels in the URL instead. These tests drive the real mint
 * route and the real content route against the real file rows, and assert the properties that make
 * the token safe to put in a URL at all — it is scoped to one file, it is not a master key for a
 * sibling type, it cannot be forged, and it changes nothing about how a credentialed download is
 * served.
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
}

async function initiate(
  harness: Harness,
  token: string,
  body: { filename: string; sizeBytes: number; mimeType?: string },
): Promise<Initiated> {
  const response = await harness.server.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: {
      filename: body.filename,
      sizeBytes: body.sizeBytes,
      mimeType: body.mimeType ?? 'application/octet-stream',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Initiated>();
}

async function uploadOnePart(
  harness: Harness,
  token: string,
  filename: string,
  content: Buffer,
  mimeType: string,
): Promise<{ fileId: string; file: FileRecord }> {
  const initiated = await initiate(harness, token, {
    filename,
    sizeBytes: content.byteLength,
    mimeType,
  });
  const part = await harness.server.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${initiated.uploadId}/parts/1`,
    headers: {
      ...bearer(token),
      'content-type': 'application/octet-stream',
      'content-length': String(content.byteLength),
    },
    payload: content,
  });
  expect(part.statusCode).toBe(200);
  const completed = await harness.server.inject({
    method: 'POST',
    url: `/api/v1/uploads/${initiated.uploadId}/complete`,
    headers: bearer(token),
  });
  expect(completed.statusCode).toBe(200);
  return {
    fileId: initiated.fileId,
    file: completed.json<{ file: FileRecord }>().file,
  };
}

function mintPreview(harness: Harness, token: string, fileId: string) {
  return harness.server.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/preview`,
    headers: bearer(token),
  });
}

/** Pulls the signed token out of a minted grant path, the way a browser would carry it. */
function tokenOf(path: string): string {
  const value = new URL(path, 'https://api.test').searchParams.get('preview');
  if (value === null) throw new Error(`no preview token in ${path}`);
  return value;
}

describe('inline preview grants', () => {
  it('mints a relative path that streams the file without a credential', async () => {
    const account = await createAccount(h.sql);
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const { fileId } = await uploadOnePart(h, account.token, 'photo.png', bytes, 'image/png');

    const minted = await mintPreview(h, account.token, fileId);
    expect(minted.statusCode).toBe(200);
    const grant = previewGrantSchema.parse(minted.json());

    // Relative to the API origin, so no public-origin configuration is needed, and it names the
    // file it was minted for.
    expect(grant.path.startsWith(`/api/v1/files/${fileId}/content?preview=`)).toBe(true);
    expect(grant.path).not.toContain('://');
    expect(new Date(grant.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The whole point: no Authorization header, the exact bytes, and embeddable from another
    // origin — which is what lets the web app (a different host) show it.
    const embedded = await h.server.inject({ method: 'GET', url: grant.path });
    expect(embedded.statusCode).toBe(200);
    expect(embedded.headers['content-disposition']).toMatch(/^inline;/);
    expect(embedded.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(embedded.rawPayload.equals(bytes)).toBe(true);
  });

  it('leaves a credentialed download on the default same-origin policy', async () => {
    const account = await createAccount(h.sql);
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'photo.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );

    const response = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}/content`,
      headers: bearer(account.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('scopes a token to the one file it was minted for', async () => {
    const account = await createAccount(h.sql);
    const first = await uploadOnePart(
      h,
      account.token,
      'one.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );
    const second = await uploadOnePart(
      h,
      account.token,
      'two.png',
      Buffer.from('8951', 'hex'),
      'image/png',
    );

    const grant = previewGrantSchema.parse(
      (await mintPreview(h, account.token, first.fileId)).json(),
    );
    const token = tokenOf(grant.path);

    // Replaying the token on a sibling file is refused exactly like a missing credential.
    const replayed = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${second.fileId}/content?preview=${encodeURIComponent(token)}`,
    });
    expect(replayed.statusCode).toBe(401);
    expect(problemDetailsSchema.parse(replayed.json()).code).toBe('UNAUTHENTICATED');
  });

  it('refuses to preview a type it will not render inline', async () => {
    const account = await createAccount(h.sql);
    const svg = await uploadOnePart(
      h,
      account.token,
      'logo.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/svg+xml',
    );

    const minted = await mintPreview(h, account.token, svg.fileId);
    expect(minted.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(minted.json()).code).toBe('CONFLICT');

    // A token for a previewable file is still not a key to a non-previewable sibling.
    const image = await uploadOnePart(
      h,
      account.token,
      'x.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );
    const token = tokenOf(
      previewGrantSchema.parse((await mintPreview(h, account.token, image.fileId)).json()).path,
    );
    const crossType = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/${svg.fileId}/content?preview=${encodeURIComponent(token)}`,
    });
    expect(crossType.statusCode).toBe(401);
  });

  it('answers a forged or malformed token with 401, never bytes', async () => {
    const account = await createAccount(h.sql);
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'y.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );

    for (const bad of ['not-a-token', 'aaaa.bbbb', 'a.b.c']) {
      const response = await h.server.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}/content?preview=${encodeURIComponent(bad)}`,
      });
      expect(response.statusCode, bad).toBe(401);
    }
  });

  it('never lets one account mint a preview for another account’s file', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    const { fileId } = await uploadOnePart(
      h,
      owner.token,
      'mine.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );

    const response = await mintPreview(h, intruder.token, fileId);
    // Owning the id is not owning the file: an intruder sees the same 404 an unknown id gives.
    expect(response.statusCode).toBe(404);
  });
});

describe('preview grants without a signing secret', () => {
  let unconfigured: Harness;

  beforeAll(async () => {
    unconfigured = await createHarness(
      // Both the dedicated secret and the fallback are absent, so previews must fail closed.
      {
        MALWARE_SCAN_ENABLED: 'false',
        IP_HASH_SECRET: undefined,
        PREVIEW_SIGNING_SECRET: undefined,
      },
      { storage: memoryStorage() },
    );
  });

  afterAll(async () => {
    await unconfigured.close();
  });

  it('answers 503 rather than signing under a default key', async () => {
    const account = await createAccount(unconfigured.sql);
    const { fileId } = await uploadOnePart(
      unconfigured,
      account.token,
      'photo.png',
      Buffer.from('8950', 'hex'),
      'image/png',
    );

    const minted = await mintPreview(unconfigured, account.token, fileId);
    expect(minted.statusCode).toBe(503);
    expect(problemDetailsSchema.parse(minted.json()).code).toBe('SERVICE_UNAVAILABLE');
  });
});
