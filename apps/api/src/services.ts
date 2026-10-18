import type { ApiConfig } from './config.js';
import { createAccessTokenVerifier } from './auth/tokens.js';
import type { AccessTokenVerifier } from './auth/tokens.js';
import { createDatabaseClient } from './db/client.js';
import type { DatabaseClient, DatabaseClientOptions } from './db/client.js';
import { createIpHasher } from './auth/ip-hash.js';
import type { IpHasher } from './auth/ip-hash.js';
import { createRedisConnection, redisCacheClient } from './redis.js';
import type { RedisConnection } from './redis.js';
import { createUserCache } from './cache/user-cache.js';
import type { UserCache } from './cache/user-cache.js';
import { resolveStorageProvider, applyEdgeCache } from './storage/registry.js';
import type { StorageResolution } from './storage/registry.js';
import { FinalizeJobStore } from './storage/finalize-jobs.js';
import { UploadSessionStore } from './storage/upload-sessions.js';
import type { DiskByteCache } from './storage/cache/disk-byte-cache.js';
import { createPreviewSigner } from './preview-tokens.js';
import type { PreviewSigner } from './preview-tokens.js';
import { createDeliverySigner } from './delivery-tokens.js';
import type { DeliverySigner } from './delivery-tokens.js';

/**
 * Everything the routes need, assembled once at startup.
 *
 * Passing a single container (rather than reaching for environment variables or module singletons
 * inside handlers) is what makes the routes testable: a test builds services with a scratch
 * database, a locally signed token verifier and a fake clock, and the handlers cannot tell the
 * difference.
 */

export interface AppServices {
  readonly config: ApiConfig;
  readonly db: DatabaseClient;
  readonly verifier: AccessTokenVerifier;
  readonly hashIp: IpHasher;
  readonly storage: StorageResolution;
  /** Shared rate-limit store, or null when `REDIS_URL` is unset (limits stay in-process). */
  readonly redis: RedisConnection | null;
  /**
   * The per-principal Redis cache over derived reads (listings, quota) and immutable entries
   * (delivery grants). Always present; inert unless Redis is configured and the deployment enables
   * it, in which case it degrades to a pass-through on every failure. See `cache/user-cache.ts`.
   */
  readonly userCache: UserCache;
  /** Open upload sessions. Process-local by design; see docs/DECISIONS.md (D31, D33). */
  readonly uploadSessions: UploadSessionStore;
  /**
   * Background finalize jobs for large uploads. Process-local, for the same reason the session
   * record is: the staged bytes live in this process.
   */
  readonly finalizeJobs: FinalizeJobStore;
  /**
   * Signer for short-lived inline preview URLs, or null when no signing secret is configured (the
   * preview route then answers `503`). Injected by tests that need a deterministic token.
   */
  readonly preview: PreviewSigner | null;
  /**
   * Signer for short-lived, cacheable `/cdn` delivery URLs, or null when no signing secret is
   * configured (the mint route then answers `503`). A delivery URL is how a browser element fetches
   * bytes without an Authorization header while remaining cacheable.
   */
  readonly delivery: DeliverySigner | null;
  /**
   * The local edge cache that fronts the storage provider, or null when caching is disabled or no
   * provider is attached. Exposed so shutdown can flush its index (it is derived state; losing it
   * costs only speed).
   */
  readonly edgeCache: DiskByteCache | null;
}

export interface CreateServicesOptions {
  readonly storage?: StorageResolution;
  /** Injected by tests; defaults to the configured token verification. */
  readonly verifier?: AccessTokenVerifier;
  /** Injected by tests; defaults to the configured hashing secret. */
  readonly hashIp?: IpHasher;
  /** Database connection overrides (a scratch URL in tests, notices in development). */
  readonly database?: DatabaseClientOptions;
  /** Injected by tests; defaults to a connection built from `REDIS_URL`. */
  readonly redis?: RedisConnection | null;
  /** Injected by tests; defaults to a cache over the resolved Redis connection. */
  readonly userCache?: UserCache;
  /** Injected by tests that need to exercise expiry without waiting for it. */
  readonly uploadSessions?: UploadSessionStore;
  /** Injected by tests that need to observe a finalize job. */
  readonly finalizeJobs?: FinalizeJobStore;
  /** Injected by tests; null explicitly disables previews, undefined builds them from config. */
  readonly preview?: PreviewSigner | null;
  /** Injected by tests; null explicitly disables delivery URLs, undefined builds them from config. */
  readonly delivery?: DeliverySigner | null;
}

export function createServices(
  config: ApiConfig,
  options: CreateServicesOptions = {},
): AppServices {
  // The edge cache wraps the provider resolved from configuration. A resolution injected by a test
  // is used as-is: caching is a deployment concern, and a test wants to observe the provider
  // directly rather than a local copy of it.
  const storage =
    options.storage === undefined
      ? applyEdgeCache(resolveStorageProvider(config), config)
      : { resolution: options.storage, cache: null };

  const redis =
    options.redis !== undefined ? options.redis : createRedisConnection(config.redisUrl);

  return {
    config,
    db: createDatabaseClient(config, options.database ?? {}),
    verifier: options.verifier ?? createAccessTokenVerifier(config.auth),
    hashIp: options.hashIp ?? createIpHasher(config.ipHashSecret),
    storage: storage.resolution,
    redis,
    userCache:
      options.userCache ??
      createUserCache({
        client: redis === null ? null : redisCacheClient(redis.client),
        enabled: config.userCache.enabled,
        ttlSeconds: config.userCache.ttlSeconds,
      }),
    uploadSessions:
      options.uploadSessions ??
      new UploadSessionStore({
        maxActiveSessionsPerPrincipal: config.uploads.maxActiveSessionsPerPrincipal,
      }),
    finalizeJobs: options.finalizeJobs ?? new FinalizeJobStore(),
    preview:
      options.preview !== undefined
        ? options.preview
        : createPreviewSigner({
            secret: config.preview.signingSecret,
            ttlSeconds: config.preview.tokenTtlSeconds,
          }),
    delivery:
      options.delivery !== undefined
        ? options.delivery
        : createDeliverySigner({
            secret: config.delivery.signingSecret,
            ttlSeconds: config.delivery.tokenTtlSeconds,
          }),
    edgeCache: storage.cache,
  };
}
