import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageProvider,
  describeStorageProviderContract,
} from '@opendrive/shared/storage/testing';
import { sha256HexOfBytes } from '@opendrive/shared';
import type {
  ByteRange,
  ByteStream,
  ReadResult,
  StorageProvider,
  StoreObjectRef,
  StoredObject,
} from '@opendrive/shared';
import { CachingStorageProvider } from './caching-provider.js';
import { DiskByteCache } from './disk-byte-cache.js';

/**
 * The wrapper must be a faithful `StorageProvider` first (it passes the same contract suite every
 * provider passes) and a cache second. The contract run uses a pass-through configuration so it
 * asserts delegation; the tests below assert the caching behaviour itself.
 */
describeStorageProviderContract(
  'caching wrapper (pass-through)',
  () =>
    new CachingStorageProvider(new MemoryStorageProvider(), { cache: null, backgroundFill: false }),
);

function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 256;
  return bytes;
}

function streamOf(bytes: Uint8Array): ByteStream {
  return (async function* generate() {
    yield bytes;
  })();
}

async function drain(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * A full `StorageProvider` that delegates every method to `inner` except `openReadStream`, which the
 * caller supplies. A plain object spread would lose the prototype methods at the type level, so the
 * delegation is spelled out once here and reused by the counting, slow and failing fakes below.
 */
function delegate(
  inner: StorageProvider,
  openReadStream: (ref: StoreObjectRef, range?: ByteRange) => Promise<ReadResult>,
): StorageProvider {
  return {
    providerId: inner.providerId,
    displayName: inner.displayName,
    experimental: inner.experimental,
    durabilityNotes: inner.durabilityNotes,
    capabilities: inner.capabilities,
    initiateUpload: (input) => inner.initiateUpload(input),
    uploadPart: (session, part) => inner.uploadPart(session, part),
    uploadWholeObject: (input) => inner.uploadWholeObject(input),
    finalizeUpload: (session) => inner.finalizeUpload(session),
    abortUpload: (session, reason) => inner.abortUpload(session, reason),
    getMetadata: (ref) => inner.getMetadata(ref),
    openReadStream,
    deleteObject: (ref) => inner.deleteObject(ref),
    describeUsage: () =>
      inner.describeUsage?.() ?? Promise.resolve({ usedBytes: null, objectCount: 0 }),
    health: () => inner.health(),
  };
}

/** Wraps a provider and counts how many times its (slow, remote) read path is entered. */
function counting(inner: StorageProvider) {
  let reads = 0;
  const proxy = delegate(inner, (ref, range) => {
    reads += 1;
    return inner.openReadStream(ref, range);
  });
  return { proxy, reads: () => reads };
}

async function seed(inner: StorageProvider, bytes: Uint8Array): Promise<StoredObject> {
  const checksum = await sha256HexOfBytes(bytes);
  const session = await inner.initiateUpload({
    uploadId: 'upl_00000000000000000000000001',
    fileId: 'file_00000000000000000000000001',
    filename: 'fixture.bin',
    sizeBytes: bytes.byteLength,
    mimeType: 'application/octet-stream',
    chunkSizeBytes: bytes.byteLength,
    checksumSha256: checksum,
  });
  return inner.uploadWholeObject({
    session,
    source: streamOf(bytes),
    sizeBytes: bytes.byteLength,
    checksumSha256: checksum,
  });
}

/** A promise whose resolution the test controls, to force overlapping fills deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('CachingStorageProvider', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opendrive-provider-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function newCache() {
    return new DiskByteCache({ dir, maxBytes: 1024 * 1024, ttlSeconds: 3600 });
  }

  it('fills on the first read and serves the next read from disk without touching the provider', async () => {
    const inner = new MemoryStorageProvider();
    const bytes = payload(4096);
    const stored = await seed(inner, bytes);
    const counted = counting(inner);
    const cache = newCache();
    const provider = new CachingStorageProvider(counted.proxy, {
      cache,
      backgroundFill: true,
    });

    const first = await provider.openReadStream(stored.ref);
    expect(await drain(first.stream)).toEqual(bytes);
    await provider.pendingFills();
    const readsAfterFill = counted.reads();
    expect(readsAfterFill).toBeGreaterThan(0);

    const second = await provider.openReadStream(stored.ref);
    expect(await drain(second.stream)).toEqual(bytes);
    expect(counted.reads()).toBe(readsAfterFill); // served from disk, provider untouched
    expect(cache.stats().hits).toBe(1);
  });

  it('serves a byte range from the cached copy', async () => {
    const inner = new MemoryStorageProvider();
    const bytes = payload(5000);
    const stored = await seed(inner, bytes);
    const counted = counting(inner);
    const cache = newCache();
    const provider = new CachingStorageProvider(counted.proxy, { cache, backgroundFill: true });

    // Prime the cache with a whole-object read.
    await drain((await provider.openReadStream(stored.ref)).stream);
    await provider.pendingFills();
    const readsAfterFill = counted.reads();

    const range: ByteRange = { start: 100, endInclusive: 199 };
    const read = await provider.openReadStream(stored.ref, range);
    expect(read.length).toBe(100);
    expect(read.range).toEqual(range);
    expect(await drain(read.stream)).toEqual(bytes.subarray(100, 200));
    expect(counted.reads()).toBe(readsAfterFill); // range served from disk

    await expect(
      provider.openReadStream(stored.ref, { start: 0, endInclusive: 5000 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('de-duplicates concurrent fills so a burst of range reads downloads once', async () => {
    const inner = new MemoryStorageProvider();
    const bytes = payload(8192);
    const stored = await seed(inner, bytes);
    const cache = newCache();

    // Gate the *whole-object* read (what a fill performs) so the three range reads below are still
    // in flight when each one schedules a fill. Range pass-throughs are not gated.
    const gate = deferred();
    const slow = delegate(inner, async (ref, range) => {
      if (range === undefined) await gate.promise;
      return inner.openReadStream(ref, range);
    });
    const provider = new CachingStorageProvider(slow, { cache, backgroundFill: true });

    // Fire the three reads before awaiting any of them, so all three miss and race to schedule.
    const reads = await Promise.all([
      provider.openReadStream(stored.ref, { start: 0, endInclusive: 99 }),
      provider.openReadStream(stored.ref, { start: 100, endInclusive: 199 }),
      provider.openReadStream(stored.ref, { start: 200, endInclusive: 299 }),
    ]);
    for (const read of reads) await drain(read.stream);

    expect(cache.stats().fills).toBe(0); // the single fill is still gated, not yet committed
    gate.resolve();
    await provider.pendingFills();
    expect(cache.stats().fills).toBe(1);
  });

  it('never caches an object larger than the per-object limit', async () => {
    const inner = new MemoryStorageProvider();
    const stored = await seed(inner, payload(4096));
    const cache = newCache();
    const provider = new CachingStorageProvider(counting(inner).proxy, {
      cache,
      backgroundFill: true,
      maxObjectCacheBytes: 1024,
    });

    await drain((await provider.openReadStream(stored.ref)).stream);
    await provider.pendingFills();
    expect(cache.stats().fills).toBe(0);
    expect(cache.stats().entries).toBe(0);
  });

  it('purges the cached copy when the object is deleted', async () => {
    const inner = new MemoryStorageProvider();
    const stored = await seed(inner, payload(2048));
    const cache = newCache();
    const provider = new CachingStorageProvider(inner, { cache, backgroundFill: true });

    await drain((await provider.openReadStream(stored.ref)).stream);
    await provider.pendingFills();
    expect(cache.stats().entries).toBe(1);

    await provider.deleteObject(stored.ref);
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().bytes).toBe(0);
  });

  it('treats a failed fill as a miss rather than a request failure', async () => {
    const inner = new MemoryStorageProvider();
    const stored = await seed(inner, payload(1024));
    // A provider whose read half always fails: the pass-through fails too, but the fill must not
    // leave an entry behind, and must not surface an unhandled rejection.
    const failing = delegate(inner, () => Promise.reject(new Error('provider read failed')));
    const cache = newCache();
    const provider = new CachingStorageProvider(failing, { cache, backgroundFill: true });

    await expect(provider.openReadStream(stored.ref)).rejects.toThrow('provider read failed');
    await provider.pendingFills();
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().fills).toBe(0);
  });

  it('reports cache state in its health detail', async () => {
    const inner = new MemoryStorageProvider();
    const provider = new CachingStorageProvider(inner, { cache: newCache(), backgroundFill: true });
    const health = await provider.health();
    expect(health.status).toBe('ok');
    expect(health.detail).toContain('edge cache');
  });
});
