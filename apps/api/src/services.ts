import type { ApiConfig } from './config.js';
import { createAccessTokenVerifier } from './auth/tokens.js';
import type { AccessTokenVerifier } from './auth/tokens.js';
import { createDatabaseClient } from './db/client.js';
import type { DatabaseClient, DatabaseClientOptions } from './db/client.js';
import { createIpHasher } from './auth/ip-hash.js';
import type { IpHasher } from './auth/ip-hash.js';
import { createRedisConnection } from './redis.js';
import type { RedisConnection } from './redis.js';
import { resolveStorageProvider } from './storage/registry.js';
import type { StorageResolution } from './storage/registry.js';
import { FinalizeJobStore } from './storage/finalize-jobs.js';
import { UploadSessionStore } from './storage/upload-sessions.js';
import { createPreviewSigner } from './preview-tokens.js';
import type { PreviewSigner } from './preview-tokens.js';

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
  /** Injected by tests that need to exercise expiry without waiting for it. */
  readonly uploadSessions?: UploadSessionStore;
  /** Injected by tests that need to observe a finalize job. */
  readonly finalizeJobs?: FinalizeJobStore;
  /** Injected by tests; null explicitly disables previews, undefined builds them from config. */
  readonly preview?: PreviewSigner | null;
}

export function createServices(
  config: ApiConfig,
  options: CreateServicesOptions = {},
): AppServices {
  return {
    config,
    db: createDatabaseClient(config, options.database ?? {}),
    verifier: options.verifier ?? createAccessTokenVerifier(config.auth),
    hashIp: options.hashIp ?? createIpHasher(config.ipHashSecret),
    storage: options.storage ?? resolveStorageProvider(config),
    redis: options.redis !== undefined ? options.redis : createRedisConnection(config.redisUrl),
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
  };
}
