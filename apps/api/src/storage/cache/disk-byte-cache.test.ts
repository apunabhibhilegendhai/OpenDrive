import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreObjectRef } from '@opendrive/shared';
import { DiskByteCache } from './disk-byte-cache.js';

function ref(overrides: Partial<StoreObjectRef> = {}): StoreObjectRef {
  return {
    providerId: 'memory-test',
    locator: 'memory-test/opaque-locator-1',
    sizeBytes: 6,
    checksumSha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('DiskByteCache', () => {
  let dir: string;
  let clock: number;
  const now = () => new Date(clock);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opendrive-cache-'));
    clock = 1_000_000_000;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function cache(overrides: { maxBytes?: number; ttlSeconds?: number } = {}) {
    return new DiskByteCache({
      dir,
      maxBytes: overrides.maxBytes ?? 1024,
      ttlSeconds: overrides.ttlSeconds ?? 3600,
      now,
    });
  }

  it('keys on object identity, never on the raw locator', () => {
    const store = cache();
    const a = store.keyFor(ref());
    const b = store.keyFor(ref({ locator: 'memory-test/opaque-locator-2' }));
    expect(a).toBe(store.keyFor(ref()));
    expect(a).not.toBe(b);
    expect(a).not.toContain('locator');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores a committed blob and serves it back, then misses after a purge', async () => {
    const store = cache();
    const key = store.keyFor(ref());
    const temp = await store.createTempPath(key);
    await writeFile(temp, Buffer.from('abcdef'));
    await store.commit(key, temp, 6);

    const hit = await store.lookup(key, 6);
    expect(hit).not.toBeNull();
    expect(hit?.sizeBytes).toBe(6);
    expect(hit?.path).toMatch(/[0-9a-f]{64}$/);
    expect(store.stats()).toMatchObject({ entries: 1, bytes: 6, fills: 1, hits: 1 });

    await store.purge(key);
    expect(await store.lookup(key, 6)).toBeNull();
    expect(store.stats().bytes).toBe(0);
  });

  it('never serves a partial entry: a size mismatch is treated as a miss', async () => {
    const store = cache();
    const key = store.keyFor(ref({ sizeBytes: 6 }));
    const temp = await store.createTempPath(key);
    await writeFile(temp, Buffer.from('abc')); // only 3 bytes, but commit claims 6
    await store.commit(key, temp, 6);
    expect(await store.lookup(key, 6)).toBeNull();
    expect(store.stats().entries).toBe(0);
  });

  it('treats a stale entry as a miss and drops it', async () => {
    const store = cache({ ttlSeconds: 60 });
    const key = store.keyFor(ref());
    const temp = await store.createTempPath(key);
    await writeFile(temp, Buffer.from('abcdef'));
    await store.commit(key, temp, 6);
    expect(await store.lookup(key, 6)).not.toBeNull();

    clock += 61_000; // one second past the TTL
    expect(await store.lookup(key, 6)).toBeNull();
    expect(store.stats().entries).toBe(0);
  });

  it('evicts the least-recently-used entries once over budget', async () => {
    const store = cache({ maxBytes: 10 });
    const keyA = store.keyFor(ref({ locator: 'a' }));
    const keyB = store.keyFor(ref({ locator: 'b' }));

    const tempA = await store.createTempPath(keyA);
    await writeFile(tempA, Buffer.from('aaaaaa'));
    await store.commit(keyA, tempA, 6);
    clock += 1_000;

    const tempB = await store.createTempPath(keyB);
    await writeFile(tempB, Buffer.from('bbbbbb'));
    await store.commit(keyB, tempB, 6); // pushes total to 12 > 10, evicting A

    const stats = store.stats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(6);
    expect(stats.evictions).toBe(1);
    expect(await store.lookup(keyA, 6)).toBeNull(); // evicted
    expect(await store.lookup(keyB, 6)).not.toBeNull(); // retained
  });

  it('reloads its index from disk, dropping entries whose blob is gone', async () => {
    const store = cache();
    const key = store.keyFor(ref());
    const temp = await store.createTempPath(key);
    await writeFile(temp, Buffer.from('abcdef'));
    await store.commit(key, temp, 6);
    await store.close();

    const reopened = cache();
    await reopened.init();
    expect(await reopened.lookup(key, 6)).not.toBeNull();

    await rm(join(dir, 'blobs', key.slice(0, 2), key), { force: true });
    const reopenedAgain = cache();
    await reopenedAgain.init();
    expect(reopenedAgain.stats().entries).toBe(0);
  });
});
