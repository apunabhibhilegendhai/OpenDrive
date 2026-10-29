import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryGrantSchema, problemDetailsSchema } from '@opendrive/shared';
import type {
  AbortReason,
  ByteRange,
  DeleteOutcome,
  FileRecord,
  InitiateUploadInput,
  ObjectMetadata,
  ReadResult,
  StorageHealth,
  StorageProvider,
  StoreObjectRef,
  StoredObject,
  UploadPartInput,
  UploadPartResult,
  UploadSession,
  UploadWholeObjectInput,
} from '@opendrive/shared';
import { MemoryStorageProvider } from '@opendrive/shared/storage/testing';
import { CachingStorageProvider } from '../../../apps/api/src/storage/cache/caching-provider.js';
import { DiskByteCache } from '../../../apps/api/src/storage/cache/disk-byte-cache.js';
import type { StorageResolution } from '../../../apps/api/src/storage/registry.js';
import { bearer, createAccount, createHarness } from './harness.js';
import type { Harness } from './harness.js';

/**
 * Cacheable delivery, end to end.
 *
 * These tests drive the real mint route, the real `/cdn` byte route, the real file rows and the real
 * edge-cache decorator over an in-memory provider. They assert the two properties that make a
 * cacheable URL safe and worthwhile: the credential is the URL itself (no bearer header), and the
 * second read is served from local disk without touching the provider. The provider is wrapped in a
 * counter here so "did not touch the provider" is a number, not a hope.
 */

/** A provider that counts how often its (slow, remote) read path is entered. */
function countingMemoryStorage(): { provider: StorageProvider; reads: () => number } {
  const inner = new MemoryStorageProvider();
  let reads = 0;
  const provider: StorageProvider = {
    providerId: inner.providerId,
    displayName: inner.displayName,
    experimental: inner.experimental,
    durabilityNotes: inner.durabilityNotes,
    capabilities: inner.capabilities,
    initiateUpload: (input: InitiateUploadInput): Promise<UploadSession> =>
      inner.initiateUpload(input),
    uploadPart: (session: UploadSession, part: UploadPartInput): Promise<UploadPartResult> =>
      inner.uploadPart(session, part),
    uploadWholeObject: (input: UploadWholeObjectInput): Promise<StoredObject> =>
      inner.uploadWholeObject(input),
    finalizeUpload: (session: UploadSession): Promise<StoredObject> =>
      inner.finalizeUpload(session),
    abortUpload: (session: UploadSession, reason: AbortReason): Promise<void> =>
      inner.abortUpload(session, reason),
    getMetadata: (ref: StoreObjectRef): Promise<ObjectMetadata> => inner.getMetadata(ref),
    openReadStream: (ref: StoreObjectRef, range?: ByteRange): Promise<ReadResult> => {
      reads += 1;
      return inner.openReadStream(ref, range);
    },
    deleteObject: (ref: StoreObjectRef): Promise<DeleteOutcome> => inner.deleteObject(ref),
    health: (): Promise<StorageHealth> => inner.health(),
  };
  return { provider, reads: () => reads };
}

let h: Harness;
let cacheDir: string;
let cache: DiskByteCache;
let provider: CachingStorageProvider;
let reads: () => number;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'opendrive-delivery-'));
  cache = new DiskByteCache({ dir: cacheDir, maxBytes: 8 * 1024 * 1024, ttlSeconds: 3600 });
  const counting = countingMemoryStorage();
  provider = new CachingStorageProvider(counting.provider, { cache, backgroundFill: true });
  const storage: StorageResolution = {
    provider,
    configuredName: 'memory-test',
    detail: 'In-memory provider wrapped in the edge cache by the delivery integration test.',
    productionSafe: false,
  };
  h = await createHarness({ MALWARE_SCAN_ENABLED: 'false' }, { storage });
  reads = counting.reads;
});

afterAll(async () => {
  await h.close();
  await cache.close();
  await rm(cacheDir, { recursive: true, force: true });
});

interface Initiated {
  uploadId: string;
  fileId: string;
  chunkSizeBytes: number;
}

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
  expect(initiated.statusCode).toBe(201);
  const { uploadId, fileId } = initiated.json<Initiated>();

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
  expect(part.statusCode).toBe(200);

  const completed = await harness.server.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/complete`,
    headers: bearer(token),
  });
  expect(completed.statusCode).toBe(200);
  return { fileId, file: completed.json<{ file: FileRecord }>().file };
}

function mintDelivery(harness: Harness, token: string, fileId: string) {
  return harness.server.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/delivery-url`,
    headers: bearer(token),
  });
}

/** Pulls the signed token out of a delivery path, the way a browser or cache would carry it. */
function tokenOf(deliveryPath: string): string {
  const value = new URL(deliveryPath, 'https://api.test').searchParams.get('token');
  if (value === null) throw new Error(`no delivery token in ${deliveryPath}`);
  return value;
}

describe('cacheable delivery URLs', () => {
  it('streams a cacheable delivery URL without a bearer credential', async () => {
    const account = await createAccount(h.sql);
    const bytes = Buffer.from('cacheable-delivery-bytes-0123456789');
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'clip.bin',
      bytes,
      'application/octet-stream',
    );

    const minted = await mintDelivery(h, account.token, fileId);
    expect(minted.statusCode).toBe(200);
    const grant = deliveryGrantSchema.parse(minted.json());
    expect(grant.path.startsWith(`/cdn/${fileId}/sobj_`)).toBe(true);
    expect(grant.url).toContain(grant.path);
    expect(new Date(grant.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // No Authorization header: the URL is the credential.
    const response = await h.server.inject({ method: 'GET', url: grant.path });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(response.headers['cache-control']).toContain('public');
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers.etag).toBeTruthy();
  });

  it('lets a browser open a video directly and can force a real download', async () => {
    const account = await createAccount(h.sql);
    const bytes = Buffer.from('not-really-an-mp4-but-the-type-is-what-matters');
    const { fileId } = await uploadOnePart(h, account.token, 'clip.mp4', bytes, 'video/mp4');
    const grant = deliveryGrantSchema.parse((await mintDelivery(h, account.token, fileId)).json());

    const inline = await h.server.inject({ method: 'GET', url: grant.path });
    expect(inline.statusCode).toBe(200);
    // Chrome synthesizes a media document for a top-level video URL; without media-src it blocks
    // its own <video> load and reports "Unable to play media".
    expect(inline.headers['content-security-policy']).toContain("media-src 'self'");
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);

    const download = await h.server.inject({ method: 'GET', url: `${grant.path}&download=1` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('serves the second read from the cache without touching the provider', async () => {
    const account = await createAccount(h.sql);
    const bytes = Buffer.from('the-second-read-is-cheap');
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'twice.bin',
      bytes,
      'application/octet-stream',
    );
    const grant = deliveryGrantSchema.parse((await mintDelivery(h, account.token, fileId)).json());

    const first = await h.server.inject({ method: 'GET', url: grant.path });
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload.equals(bytes)).toBe(true);

    // Let the background fill finish (the read-through copy of the whole object).
    await provider.pendingFills();
    const readsAfterFill = reads();
    expect(cache.stats().entries).toBeGreaterThan(0);

    const second = await h.server.inject({ method: 'GET', url: grant.path });
    expect(second.statusCode).toBe(200);
    expect(second.rawPayload.equals(bytes)).toBe(true);
    // Zero provider reads on the second request: it came from disk.
    expect(reads()).toBe(readsAfterFill);
  });

  it('answers a byte range with 206 and marks a bad range 416', async () => {
    const account = await createAccount(h.sql);
    const bytes = Buffer.from('0123456789abcdefghij');
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'range.bin',
      bytes,
      'application/octet-stream',
    );
    const grant = deliveryGrantSchema.parse((await mintDelivery(h, account.token, fileId)).json());

    const ranged = await h.server.inject({
      method: 'GET',
      url: grant.path,
      headers: { range: 'bytes=2-5' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect(ranged.rawPayload.equals(bytes.subarray(2, 6))).toBe(true);

    const unsatisfiable = await h.server.inject({
      method: 'GET',
      url: grant.path,
      headers: { range: `bytes=${bytes.byteLength}-` },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(problemDetailsSchema.parse(unsatisfiable.json()).code).toBe('RANGE_NOT_SATISFIABLE');
    // A 416 is an error, not a cacheable body: it must not inherit the public, immutable policy.
    expect(unsatisfiable.headers['cache-control']).toBe('no-store');
  });

  it('revalidates with an ETag and answers 304', async () => {
    const account = await createAccount(h.sql);
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'etag.bin',
      Buffer.from('etag-me'),
      'application/octet-stream',
    );
    const grant = deliveryGrantSchema.parse((await mintDelivery(h, account.token, fileId)).json());

    const first = await h.server.inject({ method: 'GET', url: grant.path });
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const revalidated = await h.server.inject({
      method: 'GET',
      url: grant.path,
      headers: { 'if-none-match': etag as string },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload.byteLength).toBe(0);
  });

  it('refuses a tampered token, another file, and another version', async () => {
    const account = await createAccount(h.sql);
    const first = await uploadOnePart(
      h,
      account.token,
      'one.bin',
      Buffer.from('one'),
      'application/octet-stream',
    );
    const second = await uploadOnePart(
      h,
      account.token,
      'two.bin',
      Buffer.from('two'),
      'application/octet-stream',
    );
    const grant = deliveryGrantSchema.parse(
      (await mintDelivery(h, account.token, first.fileId)).json(),
    );
    const token = tokenOf(grant.path);
    const version = grant.path.split('/')[3]?.split('?')[0] ?? '';

    // A tampered signature is refused exactly like a missing credential.
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    const badSignature = await h.server.inject({
      method: 'GET',
      url: `/cdn/${first.fileId}/${version}?token=${encodeURIComponent(tampered)}`,
    });
    expect(badSignature.statusCode).toBe(401);
    expect(problemDetailsSchema.parse(badSignature.json()).code).toBe('UNAUTHENTICATED');

    // The token names a file; presenting it for a sibling is refused.
    const crossFile = await h.server.inject({
      method: 'GET',
      url: `/cdn/${second.fileId}/${version}?token=${encodeURIComponent(token)}`,
    });
    expect(crossFile.statusCode).toBe(401);

    // The token names a version; a different version in the path is refused before any lookup.
    const crossVersion = await h.server.inject({
      method: 'GET',
      url: `/cdn/${first.fileId}/sobj_00000000000000000000000000?token=${encodeURIComponent(token)}`,
    });
    expect(crossVersion.statusCode).toBe(401);
  });

  it('purges the cached bytes when the file is deleted', async () => {
    const account = await createAccount(h.sql);
    const bytes = Buffer.from('delete-me-after-caching');
    const { fileId } = await uploadOnePart(
      h,
      account.token,
      'gone.bin',
      bytes,
      'application/octet-stream',
    );
    const grant = deliveryGrantSchema.parse((await mintDelivery(h, account.token, fileId)).json());

    // Warm the cache for this object.
    const warm = await h.server.inject({ method: 'GET', url: grant.path });
    expect(warm.statusCode).toBe(200);
    await provider.pendingFills();
    // The cache is shared across this file's tests, so assert this object's entry disappears
    // rather than that the whole cache is empty.
    const entriesBefore = cache.stats().entries;
    expect(entriesBefore).toBeGreaterThan(0);

    const deleted = await h.server.inject({
      method: 'DELETE',
      url: `/api/v1/files/${fileId}`,
      headers: bearer(account.token),
    });
    expect(deleted.statusCode).toBe(204);

    // The cached copy is gone with the object, and the URL now names nothing that exists.
    expect(cache.stats().entries).toBe(entriesBefore - 1);
    const after = await h.server.inject({ method: 'GET', url: grant.path });
    expect(after.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(after.json()).code).toBe('CONFLICT');
  });
});
