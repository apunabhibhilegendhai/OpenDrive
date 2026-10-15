import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, assertCapability } from '@opendrive/shared';
import type {
  AbortReason,
  ByteRange,
  DeleteOutcome,
  DownloadUrl,
  InitiateUploadInput,
  ObjectMetadata,
  ReadResult,
  StorageHealth,
  StorageProvider,
  StorageUsage,
  StoreObjectRef,
  StoredObject,
  UploadPartInput,
  UploadPartResult,
  UploadSession,
  UploadWholeObjectInput,
} from '@opendrive/shared';
import { readCached } from './disk-byte-cache.js';
import type { DiskByteCache } from './disk-byte-cache.js';

/**
 * A `StorageProvider` decorator that fronts another provider with the edge cache.
 *
 * It changes exactly one thing about a read: bytes that are already cached are served from local
 * disk instead of the (slow, remote) provider, and a miss is answered by the provider *and* kicks
 * off a background copy into the cache so the next read of that object is local. Every other
 * operation is delegated unchanged, and the declared capabilities are the wrapped provider's own —
 * the cache adds speed, never a capability the provider does not have.
 *
 * Why background-fill rather than a synchronous read-through: a video is fetched as many byte
 * ranges, and a range read cannot populate a whole-object cache entry. Filling on the first
 * request — while that first request streams through — is what makes the *second* range (and every
 * one after it) a local read, without making the first one wait for a full download.
 *
 * The cache is non-authoritative and single-node by design: it is derived state on the API host's
 * disk, never in Postgres or Redis, and losing it loses only performance. See docs/EDGE-CACHE.md
 * and docs/DECISIONS.md (D45).
 */

export interface CachingProviderOptions {
  /** The cache to fill and read from. `null` disables caching entirely (pure delegation). */
  readonly cache: DiskByteCache | null;
  /** When false, a miss is pure pass-through and nothing is cached (used by the contract suite). */
  readonly backgroundFill: boolean;
  /**
   * Objects larger than this are never cached (they would evict everything else). `null` means no
   * per-object limit — the whole-cache byte budget still bounds the cache. Defaults to `null`,
   * honouring an operator who chose to cache every size.
   */
  readonly maxObjectCacheBytes?: number | null;
}

export class CachingStorageProvider implements StorageProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly experimental: boolean;
  readonly durabilityNotes: string;
  readonly capabilities: StorageProvider['capabilities'];

  private readonly fills = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly inner: StorageProvider,
    private readonly options: CachingProviderOptions,
  ) {
    this.providerId = inner.providerId;
    this.displayName = `${inner.displayName} (+ edge cache)`;
    this.experimental = inner.experimental;
    this.durabilityNotes =
      `${inner.durabilityNotes} Reads may additionally be served from a local, non-authoritative ` +
      `edge cache; the provider remains the only authoritative store.`;
    // The cache never claims a capability the provider does not have.
    this.capabilities = inner.capabilities;
  }

  private assertRange(range: ByteRange, size: number): void {
    if (range.start < 0 || range.endInclusive < range.start || range.endInclusive >= size) {
      throw new AppError('INVALID_REQUEST', {
        detail: `Range ${range.start}-${range.endInclusive} is outside the object (0-${size - 1}).`,
      });
    }
  }

  private scheduleFill(ref: StoreObjectRef): void {
    const cache = this.options.cache;
    if (cache === null || this.closed) return;
    const maxObject = this.options.maxObjectCacheBytes ?? null;
    // Nothing smaller than the whole budget can ever be retained, so a fill would be pure waste.
    if (ref.sizeBytes > cache.budgetBytes()) return;
    if (maxObject !== null && ref.sizeBytes > maxObject) return;

    const key = cache.keyFor(ref);
    if (this.fills.has(key)) return; // De-duplicate: many concurrent range reads share one fill.

    const task = this.runFill(ref, key)
      .catch(() => undefined) // A failed fill is a cache miss, never a request failure.
      .finally(() => this.fills.delete(key));
    this.fills.set(key, task);
  }

  private async runFill(ref: StoreObjectRef, key: string): Promise<void> {
    const cache = this.options.cache;
    if (cache === null) return;
    const temp = await cache.createTempPath(key);
    try {
      const read = await this.inner.openReadStream(ref); // whole object, no range
      await pipeline(Readable.from(read.stream), createWriteStream(temp));
      await cache.commit(key, temp, read.length);
    } catch (error) {
      await cache.discardTemp(temp);
      throw error;
    }
  }

  async openReadStream(ref: StoreObjectRef, range?: ByteRange): Promise<ReadResult> {
    const cache = this.options.cache;
    if (cache !== null) {
      const key = cache.keyFor(ref);
      const hit = await cache.lookup(key, ref.sizeBytes);
      if (hit !== null) {
        if (range !== undefined) this.assertRange(range, ref.sizeBytes);
        return readCached(hit, range);
      }
      // A miss: start (or join) a whole-object fill and stream this request through the provider.
      if (this.options.backgroundFill) this.scheduleFill(ref);
    }
    return this.inner.openReadStream(ref, range);
  }

  /** Resolves once every in-flight fill has settled. Intended for tests and graceful shutdown. */
  async pendingFills(): Promise<void> {
    while (this.fills.size > 0) {
      await Promise.allSettled([...this.fills.values()]);
    }
  }

  /** Stops accepting new fills. In-flight fills are allowed to finish or are abandoned. */
  close(): void {
    this.closed = true;
  }

  async initiateUpload(input: InitiateUploadInput): Promise<UploadSession> {
    return this.inner.initiateUpload(input);
  }

  async uploadPart(session: UploadSession, part: UploadPartInput): Promise<UploadPartResult> {
    return this.inner.uploadPart(session, part);
  }

  async uploadWholeObject(input: UploadWholeObjectInput): Promise<StoredObject> {
    return this.inner.uploadWholeObject(input);
  }

  async finalizeUpload(session: UploadSession): Promise<StoredObject> {
    return this.inner.finalizeUpload(session);
  }

  async abortUpload(session: UploadSession, reason: AbortReason): Promise<void> {
    return this.inner.abortUpload(session, reason);
  }

  async getMetadata(ref: StoreObjectRef): Promise<ObjectMetadata> {
    return this.inner.getMetadata(ref);
  }

  async getDownloadUrl(ref: StoreObjectRef, ttlSeconds: number): Promise<DownloadUrl> {
    assertCapability(this, 'directDownloadUrl', 'getDownloadUrl');
    if (this.inner.getDownloadUrl === undefined) {
      throw new AppError('STORAGE_CAPABILITY_UNSUPPORTED', {
        detail: `Storage provider "${this.inner.providerId}" does not implement getDownloadUrl.`,
      });
    }
    return this.inner.getDownloadUrl(ref, ttlSeconds);
  }

  async deleteObject(ref: StoreObjectRef): Promise<DeleteOutcome> {
    // Purge the cached copy so a deleted object cannot be served from disk afterwards.
    if (this.options.cache !== null) {
      await this.options.cache.purge(this.options.cache.keyFor(ref));
    }
    return this.inner.deleteObject(ref);
  }

  async describeUsage(): Promise<StorageUsage> {
    if (this.inner.describeUsage === undefined) {
      return { usedBytes: null, objectCount: 0 };
    }
    return this.inner.describeUsage();
  }

  async health(): Promise<StorageHealth> {
    const inner = await this.inner.health();
    if (this.options.cache === null) return inner;
    return { ...inner, detail: `${inner.detail} | ${this.options.cache.describe()}` };
  }
}
