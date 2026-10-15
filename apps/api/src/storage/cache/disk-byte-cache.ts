import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ByteRange, ReadResult, StoreObjectRef } from '@opendrive/shared';

/**
 * A content-addressed byte cache on local disk — the storage half of the OpenDrive edge cache.
 *
 * Bytes are cached as whole, immutable blobs keyed by a hash of the object's *identity* (provider,
 * locator, size and checksum), never by its provider locator directly: the locator may be a
 * credential-bearing Telegram path, and it must not become a filename or appear in a directory
 * listing. The index (size, timestamps) is a small JSON file beside the blobs; it is derived state
 * and may be discarded at any time without losing anything authoritative.
 *
 * This is deliberately **not** Redis and **not** Postgres: the architecture's rule is that file
 * bytes live only on the storage provider (plus, here, a non-authoritative local copy). Losing this
 * directory loses performance, never data. See docs/EDGE-CACHE.md and docs/DECISIONS.md (D45).
 *
 * Every write goes to a temp file first and is then atomically renamed into place, so a reader can
 * never observe a partially written blob: an entry is only in the index once its bytes are whole.
 */

export interface DiskByteCacheOptions {
  readonly dir: string;
  /** Total bytes of cached blobs to retain; the least-recently-used entries are evicted above it. */
  readonly maxBytes: number;
  /** How long an entry may be served before it is treated as stale and re-fetched. */
  readonly ttlSeconds: number;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

export interface CacheEntry {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface CacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly fills: number;
  readonly evictions: number;
}

interface IndexEntry {
  sizeBytes: number;
  storedAtMs: number;
  lastAccessMs: number;
}

const INDEX_VERSION = 1;

export class DiskByteCache {
  private readonly blobsDir: string;
  private readonly tmpDir: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  private readonly index = new Map<string, IndexEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private fills = 0;
  private evictions = 0;
  private ready: Promise<void> | null = null;

  constructor(options: DiskByteCacheOptions) {
    this.blobsDir = join(options.dir, 'blobs');
    this.tmpDir = join(options.dir, 'tmp');
    this.indexPath = join(options.dir, 'index.json');
    this.maxBytes = options.maxBytes;
    this.ttlMs = options.ttlSeconds * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** The total byte budget this cache will not exceed (LRU eviction keeps it under this). */
  budgetBytes(): number {
    return this.maxBytes;
  }

  /** The opaque, stable key for an object. Never the locator itself. */
  keyFor(ref: StoreObjectRef): string {
    return createHash('sha256')
      .update(
        `${ref.providerId}\u0000${ref.locator}\u0000${ref.sizeBytes}\u0000${ref.checksumSha256 ?? ''}`,
        'utf8',
      )
      .digest('hex');
  }

  private blobPath(key: string): string {
    return join(this.blobsDir, key.slice(0, 2), key);
  }

  /** Creates the directories and loads the index from disk. Idempotent; never throws twice. */
  async init(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.load();
    }
    return this.ready;
  }

  private async load(): Promise<void> {
    await mkdir(join(this.blobsDir), { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf8');
    } catch {
      return; // No index yet: an empty cache.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // A corrupt index is discarded, not trusted: it is derived state.
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== INDEX_VERSION
    ) {
      return;
    }
    const entries = (parsed as { entries?: unknown }).entries;
    if (typeof entries !== 'object' || entries === null) return;

    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      const entry = value as Partial<IndexEntry>;
      if (
        typeof entry.sizeBytes !== 'number' ||
        typeof entry.storedAtMs !== 'number' ||
        typeof entry.lastAccessMs !== 'number'
      ) {
        continue;
      }
      // Drop an entry whose blob is gone (an interrupted write, a manual delete): the index is a
      // hint, the filesystem is the truth.
      try {
        const info = await stat(this.blobPath(key));
        if (!info.isFile() || info.size !== entry.sizeBytes) continue;
      } catch {
        continue;
      }
      this.index.set(key, {
        sizeBytes: entry.sizeBytes,
        storedAtMs: entry.storedAtMs,
        lastAccessMs: entry.lastAccessMs,
      });
      this.bytes += entry.sizeBytes;
    }
  }

  private async persist(): Promise<void> {
    const entries: Record<string, IndexEntry> = {};
    for (const [key, entry] of this.index) entries[key] = entry;
    const payload = JSON.stringify({ version: INDEX_VERSION, entries });
    // Write then rename so a crash mid-write cannot leave a truncated index behind.
    const temp = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temp, payload, 'utf8');
    await rename(temp, this.indexPath);
  }

  /**
   * A cache hit, or `null`. An entry is refused when it is missing, stale, the wrong size for the
   * requested object, or its blob has disappeared — in every case it is dropped and re-filled.
   */
  async lookup(key: string, expectedSize: number): Promise<CacheEntry | null> {
    await this.init();
    const entry = this.index.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return null;
    }
    const blob = this.blobPath(key);
    const stale = this.now().getTime() - entry.storedAtMs > this.ttlMs;
    if (stale || entry.sizeBytes !== expectedSize) {
      await this.purge(key);
      this.misses += 1;
      return null;
    }
    try {
      const info = await stat(blob);
      if (!info.isFile() || info.size !== entry.sizeBytes) throw new Error('mismatch');
    } catch {
      await this.purge(key);
      this.misses += 1;
      return null;
    }
    entry.lastAccessMs = this.now().getTime();
    this.hits += 1;
    return { path: blob, sizeBytes: entry.sizeBytes };
  }

  /** A write-only temp path for a fill. The caller streams into it, then calls {@link commit}. */
  async createTempPath(key: string): Promise<string> {
    await this.init();
    await mkdir(join(this.tmpDir), { recursive: true });
    return join(this.tmpDir, `${key}.${randomUUID()}.tmp`);
  }

  /** Atomically publishes a filled blob and records it in the index. */
  async commit(key: string, tempPath: string, sizeBytes: number): Promise<void> {
    await this.init();
    const destination = this.blobPath(key);
    await mkdir(dirname(destination), { recursive: true });
    await rename(tempPath, destination);

    const existing = this.index.get(key);
    if (existing !== undefined) this.bytes -= existing.sizeBytes;
    const at = this.now().getTime();
    this.index.set(key, { sizeBytes, storedAtMs: at, lastAccessMs: at });
    this.bytes += sizeBytes;
    this.fills += 1;

    await this.evict();
    await this.persist();
  }

  /** A discarded fill (failure or shutdown); removing a missing temp file is not an error. */
  async discardTemp(tempPath: string): Promise<void> {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }

  async purge(key: string): Promise<void> {
    await this.init();
    const entry = this.index.get(key);
    if (entry === undefined) {
      await rm(this.blobPath(key), { force: true }).catch(() => undefined);
      return;
    }
    this.index.delete(key);
    this.bytes -= entry.sizeBytes;
    await rm(this.blobPath(key), { force: true }).catch(() => undefined);
    await this.persist();
  }

  /** Drops least-recently-used entries until the cache is within its byte budget. */
  private async evict(): Promise<void> {
    if (this.bytes <= this.maxBytes) return;
    const ordered = [...this.index.entries()].sort(
      ([, left], [, right]) => left.lastAccessMs - right.lastAccessMs,
    );
    for (const [key, entry] of ordered) {
      if (this.bytes <= this.maxBytes) break;
      this.index.delete(key);
      this.bytes -= entry.sizeBytes;
      this.evictions += 1;
      await rm(this.blobPath(key), { force: true }).catch(() => undefined);
    }
  }

  stats(): CacheStats {
    return {
      entries: this.index.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      fills: this.fills,
      evictions: this.evictions,
    };
  }

  /** A short, operator-facing line. Contains no locators and no secret. */
  describe(): string {
    const stats = this.stats();
    const total = stats.hits + stats.misses;
    const ratio = total === 0 ? 'n/a' : `${Math.round((stats.hits / total) * 100)}%`;
    return (
      `edge cache: ${stats.entries} entries, ${stats.bytes} bytes (budget ${this.maxBytes}), ` +
      `hit ratio ${ratio}, fills ${stats.fills}, evictions ${stats.evictions}`
    );
  }

  /** Flushes the index. The cache is derived state, so this is best-effort. */
  async close(): Promise<void> {
    if (this.ready === null) return;
    await this.ready;
    await this.persist().catch(() => undefined);
  }
}

/** Reads one range (or the whole blob) of a cached file as a Node stream. */
export function readCached(entry: CacheEntry, range: ByteRange | undefined): ReadResult {
  if (range === undefined) {
    return { stream: createReadStream(entry.path), length: entry.sizeBytes, range: null };
  }
  return {
    stream: createReadStream(entry.path, { start: range.start, end: range.endInclusive }),
    length: range.endInclusive - range.start + 1,
    range,
  };
}
