import { Redis } from 'ioredis';
import type { CacheClient } from './cache/user-cache.js';

/**
 * The optional Redis connection.
 *
 * Redis makes the two rate-limit ceilings cluster-wide instead of per-process: the limiter keeps
 * a counter per principal in Redis, so a caller cannot multiply their allowance by hitting a
 * second instance. It is deliberately optional — with `REDIS_URL` absent the API still runs and
 * limits hold in memory (see docs/DECISIONS.md, D33), and with it configured but unreachable the
 * limiter fails open rather than failing every request.
 *
 * The same connection is what a readiness probe PINGs, so `ok` means the server actually answered.
 */
export interface RedisConnection {
  /** The ioredis client, handed to `@fastify/rate-limit` as its shared store. */
  readonly client: Redis;
  /** Round-trips PING so readiness can prove the server answers, not merely that a URL was set. */
  ping: () => Promise<string>;
  close: () => Promise<void>;
}

export function createRedisConnection(url: string | null): RedisConnection | null {
  if (url === null || url.trim() === '') return null;

  const client = new Redis(url, {
    // A request must never wait on Redis: a slow server would become an API-wide stall. The
    // limiter is told to *skip* (fail open) whenever a command errors, so the two settings are a
    // pair — bounded retries here, `skipOnError` where the plugin is registered.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  // ioredis emits `error` on every failed (re)connect. Without a listener Node treats one as an
  // unhandled exception and the process dies; the readiness probe reports the state instead.
  client.on('error', () => {});

  return {
    client,
    ping: () => client.ping(),
    close: async () => {
      try {
        await client.quit();
      } catch {
        // A connection that never came up cannot be quit gracefully; sever it so the process can exit.
        client.disconnect();
      }
    },
  };
}

/**
 * Adapts the shared ioredis client to the narrow {@link CacheClient} the per-user cache needs.
 *
 * The cache is allowed exactly four commands, and this adapter is the only place they are named.
 * `SET key value EX seconds` is the sole write: every entry carries its own expiry, so a key can
 * never outlive the reason it was written — not even if an explicit invalidation is missed.
 */
export function redisCacheClient(client: Redis): CacheClient {
  return {
    get: (key) => client.get(key),
    set: (key, value, mode, ttlSeconds) => client.set(key, value, mode, ttlSeconds),
    incr: (key) => client.incr(key),
    del: (...keys) => client.del(...keys),
  };
}
