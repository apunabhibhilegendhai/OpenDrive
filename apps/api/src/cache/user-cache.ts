/**
 * A per-principal Redis cache.
 *
 * Redis is used elsewhere in this service for a single purpose (the shared rate-limit counters, see
 * `redis.ts`). This module adds a second, equally narrow one: a **derived** cache of what a
 * principal has already been told. It is not a store of record — every entry can be thrown away
 * without losing a byte of metadata, exactly the property `docs/ARCHITECTURE.md` demands of Redis
 * ("rate-limit counters, short-lived job state … must be reconstructible"). A cache miss is always
 * answered from PostgreSQL, so a wrong key can cost speed and nothing else.
 *
 * Two shapes of entry live here, and they are kept apart because they invalidate differently:
 *
 *   * **Read-through entries** (`readThrough`) — a rendering of something a principal reads, keyed
 *     by a per-principal *generation* counter. A write bumps the counter, which makes every entry
 *     written under the old counter unreachable at once. That is what lets an upload, a delete or a
 *     folder rename take effect immediately rather than after a TTL: the writer and reader are the
 *     same principal, and the invalidation is one `INCR` rather than a scan for keys to delete.
 *   * **Immutable entries** (`getJson`/`setJson`) — a value that is correct for as long as the
 *     thing it names exists, such as the delivery URL bound to one object *version*. Those need no
 *     invalidation at all: new bytes are a new version and therefore a new key.
 *
 * Degradation is deliberate and total. With no Redis client the cache is simply disabled and every
 * call becomes a pass-through; with Redis configured but unreachable, every operation is caught and
 * treated as a miss, so a slow or broken Redis can never fail a request. This mirrors the rate
 * limiter's fail-open stance (docs/DECISIONS.md, D33).
 */

/**
 * The slice of the Redis client this module uses. Kept as an interface rather than a concrete
 * `ioredis` type so the cache can be unit-tested against an in-memory fake, with no server.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

export interface UserCacheOptions {
  /** The Redis client, or null to disable caching entirely. */
  readonly client: CacheClient | null;
  /** Deployment switch; `false` disables the cache even when a client is present. */
  readonly enabled: boolean;
  /** Default lifetime of a read-through entry, in seconds. */
  readonly ttlSeconds: number;
  /** Key namespace, so this cache cannot collide with the rate-limit keys on a shared Redis. */
  readonly namespace?: string;
}

export interface ReadThroughInput<T> {
  /** The owner key this read belongs to; every key for one principal shares this prefix. */
  readonly principalKey: string;
  /** A short label for the kind of read (`files`, `folders`, `quota`). */
  readonly tag: string;
  /** The parts that make two reads of the same tag distinct (scope, cursor, limit). */
  readonly parts?: readonly (string | number)[];
  /** Override the default TTL for this entry. */
  readonly ttlSeconds?: number;
  /** How to produce the value on a miss. A throw here propagates and caches nothing. */
  readonly load: () => Promise<T>;
}

export const DEFAULT_USER_CACHE_NAMESPACE = 'od:cache';

export class UserCache {
  readonly #client: CacheClient | null;
  readonly #ttlSeconds: number;
  readonly #namespace: string;

  constructor(options: UserCacheOptions) {
    this.#client = options.enabled ? options.client : null;
    this.#ttlSeconds = options.ttlSeconds;
    this.#namespace = options.namespace ?? DEFAULT_USER_CACHE_NAMESPACE;
  }

  /** Whether this cache can serve or store anything. Exposed for tests and readiness reasoning. */
  get enabled(): boolean {
    return this.#client !== null;
  }

  /**
   * Read through the cache, or compute and remember on a miss.
   *
   * The per-principal generation is read first and folded into the entry key, so
   * {@link UserCache.invalidateReads} can make every entry for a principal unreachable with a single
   * write instead of enumerating keys. A failure at any point — the generation read, the entry read,
   * a corrupt value — degrades to "compute it" rather than to an error.
   */
  async readThrough<T>(input: ReadThroughInput<T>): Promise<T> {
    const client = this.#client;
    if (client === null) return input.load();

    let key: string;
    try {
      const generation = await this.#generation(client, input.principalKey);
      key = this.#entryKey(input.principalKey, input.tag, generation, input.parts);
      const cached = await client.get(key);
      if (cached !== null) {
        const parsed = parseJson<T>(cached);
        if (parsed !== undefined) return parsed;
      }
    } catch {
      return input.load();
    }

    const value = await input.load();
    await this.#store(client, key, value, input.ttlSeconds);
    return value;
  }

  /**
   * Read a JSON entry that is not tied to a generation — a value that is immutable for as long as it
   * names something (see the module doc). Returns null on any miss or failure.
   */
  async getJson<T>(
    principalKey: string,
    tag: string,
    parts: readonly (string | number)[],
  ): Promise<T | null> {
    const client = this.#client;
    if (client === null) return null;
    try {
      const raw = await client.get(this.#rawKey(principalKey, tag, parts));
      if (raw === null) return null;
      const parsed = parseJson<T>(raw);
      return parsed === undefined ? null : parsed;
    } catch {
      return null;
    }
  }

  /** Store a JSON entry that needs no invalidation. Failures are swallowed: it is derived state. */
  async setJson(
    principalKey: string,
    tag: string,
    parts: readonly (string | number)[],
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    const client = this.#client;
    if (client === null) return;
    await this.#store(client, this.#rawKey(principalKey, tag, parts), value, ttlSeconds);
  }

  /**
   * Make every read-through entry for one principal unreachable by advancing its generation.
   *
   * Called after a write, before the response is sent, so a client that lists immediately after an
   * upload or a delete is guaranteed to see the new state rather than a cached rendering of the old
   * one. Best-effort: if it fails, the entries age out on their (short) TTL, and a miss is always
   * answered correctly from PostgreSQL.
   */
  async invalidateReads(principalKey: string): Promise<void> {
    const client = this.#client;
    if (client === null) return;
    try {
      await client.incr(this.#generationKey(principalKey));
    } catch {
      // Derived state; a failed invalidation costs staleness until the TTL, never correctness.
    }
  }

  async #generation(client: CacheClient, principalKey: string): Promise<number> {
    const raw = await client.get(this.#generationKey(principalKey));
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  async #store(
    client: CacheClient,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    const ttl = ttlSeconds ?? this.#ttlSeconds;
    try {
      await client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttl)));
    } catch {
      // A missed write only costs a recompute on the next read.
    }
  }

  #base(principalKey: string): string {
    return `${this.#namespace}:u:${principalKey}`;
  }

  #generationKey(principalKey: string): string {
    return `${this.#base(principalKey)}:gen`;
  }

  #rawKey(principalKey: string, tag: string, parts: readonly (string | number)[]): string {
    return `${this.#base(principalKey)}:${tag}${suffix(parts)}`;
  }

  #entryKey(
    principalKey: string,
    tag: string,
    generation: number,
    parts: readonly (string | number)[] | undefined,
  ): string {
    return `${this.#base(principalKey)}:g${generation}:${tag}${suffix(parts)}`;
  }
}

/**
 * A `:part:part` suffix whose pieces cannot alias each other.
 *
 * Each part is percent-encoded before joining, so a value that happens to contain the separator
 * still yields a distinct key. Two different reads for one principal must never share a key, or a
 * listing would be served under another listing's cursor.
 */
function suffix(parts: readonly (string | number)[] | undefined): string {
  if (parts === undefined || parts.length === 0) return '';
  return `:${parts.map((part) => encodeURIComponent(String(part))).join(':')}`;
}

/** Parses a cached value, returning undefined for the impossible case of a corrupt entry. */
function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function createUserCache(options: UserCacheOptions): UserCache {
  return new UserCache(options);
}
