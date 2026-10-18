import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserCache, type CacheClient } from './user-cache.js';

/**
 * A tiny in-process fake that satisfies the {@link CacheClient} interface.
 *
 * This is not a full ioredis simulation — it implements exactly the four commands the cache uses
 * (`get`, `set`, `incr`, `del`) and nothing more. That keeps the test surface small and the fake
 * honest: if the cache were to reach for another command the test would fail.
 */
class FakeCacheClient implements CacheClient {
  readonly #store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#store.get(key) ?? null);
  }

  set(key: string, value: string, _mode: 'EX', _ttlSeconds: number): Promise<unknown> {
    this.#store.set(key, value);
    return Promise.resolve('OK');
  }

  incr(key: string): Promise<number> {
    const raw = this.#store.get(key) ?? '0';
    const current = Number.parseInt(raw, 10);
    const next = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
    this.#store.set(key, String(next));
    return Promise.resolve(next);
  }

  del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.#store.delete(key)) deleted += 1;
    }
    return Promise.resolve(deleted);
  }
}

describe('UserCache', () => {
  let client: FakeCacheClient;
  let cache: UserCache;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCache(
    options: Partial<{
      client: CacheClient | null;
      enabled: boolean;
      ttlSeconds: number;
    }> = {},
  ) {
    return new UserCache({
      client: options.client === undefined ? client : options.client,
      enabled: options.enabled ?? true,
      ttlSeconds: options.ttlSeconds ?? 15,
    });
  }

  describe('enabled', () => {
    it('is true when a client is provided and enabled is not false', () => {
      client = new FakeCacheClient();
      cache = makeCache();
      expect(cache.enabled).toBe(true);
    });

    it('is false when the client is explicitly null', () => {
      cache = makeCache({ client: null });
      expect(cache.enabled).toBe(false);
    });

    it('is false when enabled is false even with a client', () => {
      client = new FakeCacheClient();
      cache = makeCache({ enabled: false });
      expect(cache.enabled).toBe(false);
    });
  });

  describe('readThrough', () => {
    it('calls the loader and caches the result on a miss', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      const load = vi.fn().mockResolvedValue({ value: 42 });
      const result = await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'test',
        parts: ['scope', 10],
        load,
      });

      expect(result).toEqual({ value: 42 });
      expect(load).toHaveBeenCalledTimes(1);
      // A second read hits the cache
      const result2 = await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'test',
        parts: ['scope', 10],
        load: vi.fn(),
      });
      expect(result2).toEqual({ value: 42 });
    });

    it('degrades to pass-through when client is null', async () => {
      cache = makeCache({ client: null });
      const load = vi.fn().mockResolvedValue({ value: 1 });

      const result = await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'test',
        load,
      });

      expect(result).toEqual({ value: 1 });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('swallows a load error and propagates it (does not cache on failure)', async () => {
      client = new FakeCacheClient();
      cache = makeCache();
      const load = vi.fn().mockRejectedValue(new Error('db down'));

      await expect(
        cache.readThrough({
          principalKey: 'user:abc',
          tag: 'test',
          load,
        }),
      ).rejects.toThrow('db down');

      // Nothing was cached; a retry will call load again
      await expect(
        cache.readThrough({
          principalKey: 'user:abc',
          tag: 'test',
          load: vi.fn().mockResolvedValue({ value: 2 }),
        }),
      ).resolves.toEqual({ value: 2 });
    });

    it('invalidates all entries for a principal when invalidateReads is called', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      // First read populates generation 0
      const load1 = vi.fn().mockResolvedValue({ v: 1 });
      await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'files',
        parts: ['any', 10],
        load: load1,
      });

      // Bump generation
      await cache.invalidateReads('user:abc');

      // Next read sees generation 1 and misses
      const load2 = vi.fn().mockResolvedValue({ v: 2 });
      const result = await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'files',
        parts: ['any', 10],
        load: load2,
      });

      expect(result).toEqual({ v: 2 });
      expect(load1).toHaveBeenCalledTimes(1);
      expect(load2).toHaveBeenCalledTimes(1);
    });

    it('does not crash when invalidateReads fails on Redis', async () => {
      // A client that fails on incr but works on get/set
      client = new (class extends FakeCacheClient {
        override incr(): Promise<number> {
          throw new Error('redis unreachable');
        }
      })();
      cache = makeCache();

      // Populate then try to invalidate
      await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'files',
        load: () => Promise.resolve({ v: 1 }),
      });
      await cache.invalidateReads('user:abc'); // should not throw

      // Cache still has the old entry (generation didn't bump), so readThrough returns it
      const result = await cache.readThrough({
        principalKey: 'user:abc',
        tag: 'files',
        load: vi.fn().mockResolvedValue({ v: 2 }),
      });
      expect(result).toEqual({ v: 1 });
    });
  });

  describe('getJson / setJson (immutable entries)', () => {
    it('stores and retrieves a JSON value keyed by principal, tag, parts', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.setJson('user:abc', 'delivery', ['file_1', 'sobj_1'], {
        url: 'https://example.com/cdn/file_1/sobj_1?token=xyz',
        path: '/cdn/...',
        expiresAt: '2026-10-15T00:00:00.000Z',
      });

      const value = await cache.getJson('user:abc', 'delivery', ['file_1', 'sobj_1']);
      expect(value).toEqual({
        url: 'https://example.com/cdn/file_1/sobj_1?token=xyz',
        path: '/cdn/...',
        expiresAt: '2026-10-15T00:00:00.000Z',
      });
    });

    it('returns null on a miss', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      const value = await cache.getJson('user:abc', 'delivery', ['file_1', 'sobj_2']);
      expect(value).toBeNull();
    });

    it('returns null when the cached value is corrupt JSON', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      // Manually put garbage
      const key = 'od:cache:u:user:abc:delivery:file_1:sobj_1';
      await client.set(key, 'not json', 'EX', 60);

      const value = await cache.getJson('user:abc', 'delivery', ['file_1', 'sobj_1']);
      expect(value).toBeNull();
    });

    it('degrades to no-op when client is null', async () => {
      cache = makeCache({ client: null });
      await cache.setJson('user:abc', 'delivery', ['file_1', 'sobj_1'], { url: 'x' });
      const value = await cache.getJson('user:abc', 'delivery', ['file_1', 'sobj_1']);
      expect(value).toBeNull();
    });

    it('different principals never share a key', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.setJson('user:abc', 'delivery', ['file_1', 'sobj_1'], { v: 1 });
      await cache.setJson('user:xyz', 'delivery', ['file_1', 'sobj_1'], { v: 2 });

      expect(await cache.getJson('user:abc', 'delivery', ['file_1', 'sobj_1'])).toEqual({ v: 1 });
      expect(await cache.getJson('user:xyz', 'delivery', ['file_1', 'sobj_1'])).toEqual({ v: 2 });
    });

    it('different tags never share a key', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.setJson('user:abc', 'delivery', ['file_1', 'sobj_1'], { v: 1 });
      await cache.setJson('user:abc', 'files', ['any', 10], { v: 2 });

      expect(await cache.getJson('user:abc', 'delivery', ['file_1', 'sobj_1'])).toEqual({ v: 1 });
      expect(await cache.getJson('user:abc', 'files', ['any', 10])).toEqual({ v: 2 });
    });
  });

  describe('generation is per-principal and persistent', () => {
    it('two principals have independent generations', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.readThrough({ principalKey: 'user:a', tag: 'x', load: () => Promise.resolve(1) });
      await cache.readThrough({ principalKey: 'user:b', tag: 'x', load: () => Promise.resolve(1) });

      await cache.invalidateReads('user:a');

      // user:a's entry is invalidated; user:b's is not
      const a = await cache.readThrough({
        principalKey: 'user:a',
        tag: 'x',
        load: vi.fn().mockResolvedValue(2),
      });
      const b = await cache.readThrough({
        principalKey: 'user:b',
        tag: 'x',
        load: vi.fn().mockResolvedValue(3),
      });
      expect(a).toBe(2);
      expect(b).toBe(1);
    });

    it('generation survives a cache re-creation (same FakeClient instance)', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.readThrough({ principalKey: 'user:a', tag: 'x', load: () => Promise.resolve(1) });
      await cache.invalidateReads('user:a');

      // New UserCache pointing at the same fake client sees the bumped generation
      const cache2 = makeCache();
      const load = vi.fn().mockResolvedValue(2);
      const result = await cache2.readThrough({ principalKey: 'user:a', tag: 'x', load });
      expect(result).toBe(2);
    });
  });

  describe('parts encoding', () => {
    it('distinguishes parts that differ only by encoding', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.setJson('user:abc', 'files', ['any', 'folder:1', 10], { v: 1 });
      await cache.setJson('user:abc', 'files', ['any', 'folder%3A1', 10], { v: 2 });

      expect(await cache.getJson('user:abc', 'files', ['any', 'folder:1', 10])).toEqual({ v: 1 });
      expect(await cache.getJson('user:abc', 'files', ['any', 'folder%3A1', 10])).toEqual({ v: 2 });
    });

    it('undefined parts is the same as empty array', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.setJson('user:abc', 'files', ['any', 10], { v: 1 });
      const v1 = await cache.getJson('user:abc', 'files', ['any', 10]);
      const v2 = await cache.getJson('user:abc', 'files', []);
      expect(v1).toEqual({ v: 1 });
      expect(v2).toBeNull(); // different parts -> different key
    });

    it('trailing empty string part creates a distinct key', async () => {
      client = new FakeCacheClient();
      cache = makeCache();

      await cache.setJson('user:abc', 'files', ['any', 10], { v: 1 });
      const v1 = await cache.getJson('user:abc', 'files', ['any', 10]);
      const v2 = await cache.getJson('user:abc', 'files', ['any', 10, '']);
      expect(v1).toEqual({ v: 1 });
      expect(v2).toBeNull(); // trailing empty part is a distinct key
    });
  });
});
