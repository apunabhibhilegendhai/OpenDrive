import type { ApiConfig } from './config.js';
import { createAccessTokenVerifier } from './auth/tokens.js';
import type { AccessTokenVerifier } from './auth/tokens.js';
import { createDatabaseClient } from './db/client.js';
import type { DatabaseClient, DatabaseClientOptions } from './db/client.js';
import { createIpHasher } from './auth/ip-hash.js';
import type { IpHasher } from './auth/ip-hash.js';
import { resolveStorageProvider } from './storage/registry.js';
import type { StorageResolution } from './storage/registry.js';
import { UploadSessionStore } from './storage/upload-sessions.js';

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
  /** Open upload sessions. Process-local by design; see docs/DECISIONS.md (D31, D33). */
  readonly uploadSessions: UploadSessionStore;
}

export interface CreateServicesOptions {
  readonly storage?: StorageResolution;
  /** Injected by tests; defaults to the configured token verification. */
  readonly verifier?: AccessTokenVerifier;
  /** Injected by tests; defaults to the configured hashing secret. */
  readonly hashIp?: IpHasher;
  /** Database connection overrides (a scratch URL in tests, notices in development). */
  readonly database?: DatabaseClientOptions;
  /** Injected by tests that need to exercise expiry without waiting for it. */
  readonly uploadSessions?: UploadSessionStore;
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
    uploadSessions:
      options.uploadSessions ??
      new UploadSessionStore({
        maxActiveSessionsPerPrincipal: config.uploads.maxActiveSessionsPerPrincipal,
      }),
  };
}
