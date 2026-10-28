import type { StorageProvider } from '@opendrive/shared';
import { AppError } from '@opendrive/shared';
import { MemoryStorageProvider } from '@opendrive/shared/storage/testing';
import type { ApiConfig } from '../config.js';
import { CachingStorageProvider } from './cache/caching-provider.js';
import { DiskByteCache } from './cache/disk-byte-cache.js';
import { TelegramHttpTransport } from './providers/telegram-transport.js';
import { TelegramStorageProvider } from './providers/telegram.js';

/**
 * Storage provider registry.
 *
 * Phase 0 has no production storage backend. Rather than shipping a fake one, this
 * module returns either a real provider or `null` plus an explanation. The API then
 * reports uploads as unavailable instead of accepting bytes it cannot store.
 *
 * Guardrails encoded here:
 * - The in-memory test double is refused in production outright.
 * - The Telegram backend is experimental: it passes the provider contract suite but is
 *   not validated for production, so it is attached with `productionSafe: false` and an
 *   honest durability warning rather than being advertised as durable.
 */

export interface StorageResolution {
  /** Null when no usable provider is configured. */
  readonly provider: StorageProvider | null;
  readonly configuredName: ApiConfig['storageProvider'];
  /** Operator-facing explanation. Safe to expose: contains no secrets. */
  readonly detail: string;
  /** True only for providers validated as durable enough for real user data. */
  readonly productionSafe: boolean;
}

function readEnv(name: string, env: Record<string, string | undefined>): string | null {
  const value = env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** A self-hosted Bot API server started with `--local` is reached over loopback. */
function isLocalBotApi(apiBaseUrl: string | null): boolean {
  if (apiBaseUrl === null) return false;
  try {
    const { hostname } = new URL(apiBaseUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/** The Local Bot API's per-document ceiling: 2000 MB, the reason to run `--local` at all. */
const LOCAL_BOT_API_MAX_DOCUMENT_BYTES = 2_000_000_000;
/** The public Bot API serves back at most 20 MiB, so a bigger document could never be read. */
const PUBLIC_BOT_API_MAX_RETRIEVABLE_BYTES = 20 * 1024 * 1024;

/**
 * The attached provider, or a 503.
 *
 * Uploads and downloads need bytes on disk somewhere. When no provider is attached the honest
 * answer is "this deployment cannot store files", not a 500 and not a silent no-op — the caller can
 * retry once an operator configures storage. The `detail` from the resolution is safe to expose: it
 * names configuration variables, never their values.
 */
export function requireStorageProvider(resolution: StorageResolution): StorageProvider {
  if (resolution.provider === null) {
    throw new AppError('STORAGE_UNAVAILABLE', { detail: resolution.detail });
  }
  return resolution.provider;
}

/**
 * The resolved provider plus the edge cache that fronts it (or `null` when caching is off).
 *
 * The cache is non-authoritative derived state on this host's disk — never Postgres, never Redis.
 * It exists to hide the storage provider's read latency behind a local copy, which matters most for
 * the Telegram backend (~0.17 MiB/s). It is wiped with the ephemeral host, so it is an origin read
 * cache, not a globally replicated CDN; see docs/EDGE-CACHE.md and docs/DECISIONS.md (D45).
 */
export interface EdgeCachedStorage {
  readonly resolution: StorageResolution;
  /** The cache to close on shutdown, or `null` when caching is disabled or no provider is attached. */
  readonly cache: DiskByteCache | null;
}

/**
 * Wraps a resolved provider with the local edge cache.
 *
 * Only the provider's read path changes: a cached object is served from disk, a miss is answered by
 * the provider *and* copied into the cache in the background so the next read is local. A provider
 * that is not attached is left alone, and the resolution's operator-facing `detail` gains one honest
 * sentence about the cache so `/readyz` never implies the cache is a durability guarantee.
 */
export function applyEdgeCache(
  resolution: StorageResolution,
  config: ApiConfig,
): EdgeCachedStorage {
  if (resolution.provider === null || !config.edgeCache.enabled) {
    return { resolution, cache: null };
  }
  const cache = new DiskByteCache({
    dir: config.edgeCache.dir,
    maxBytes: config.edgeCache.maxBytes,
    ttlSeconds: config.edgeCache.ttlSeconds,
  });
  return {
    resolution: {
      ...resolution,
      provider: new CachingStorageProvider(resolution.provider, {
        cache,
        backgroundFill: true,
      }),
      detail:
        `${resolution.detail} A local edge cache fronts the provider ` +
        `(${config.edgeCache.maxBytes}-byte LRU budget at "${config.edgeCache.dir}"); it is ` +
        `non-authoritative and lost with this host.`,
    },
    cache,
  };
}

/**
 * The Telegram bot token and target chat are credentials, so they are deliberately NOT part
 * of the resolved `ApiConfig` surface (third-party secrets stay out of it). They are read
 * here, at the moment the provider is attached, from the runtime environment.
 */
export function resolveStorageProvider(
  config: ApiConfig,
  runtimeEnv: Record<string, string | undefined> = process.env,
): StorageResolution {
  switch (config.storageProvider) {
    case 'none':
      return {
        provider: null,
        configuredName: 'none',
        detail:
          'No storage provider is configured. Upload and download endpoints answer 503 ' +
          'STORAGE_UNAVAILABLE, because accepting bytes there is nowhere to keep would be a lie.',
        productionSafe: false,
      };

    case 'memory-test': {
      if (config.nodeEnv === 'production') {
        return {
          provider: null,
          configuredName: 'memory-test',
          detail:
            'STORAGE_PROVIDER=memory-test is refused in production: it keeps bytes in process ' +
            'memory only. Configure a durable provider instead.',
          productionSafe: false,
        };
      }
      return {
        provider: new MemoryStorageProvider(),
        configuredName: 'memory-test',
        detail:
          'Using the in-memory test double: bytes are lost on restart and are not durable. ' +
          'Development and test use only.',
        productionSafe: false,
      };
    }

    case 'telegram-experimental': {
      // Credentials arrive through the runtime environment, not through the resolved
      // configuration surface (third-party secrets stay out of it).
      const botToken = readEnv('TELEGRAM_BOT_TOKEN', runtimeEnv);
      const chatId = readEnv('TELEGRAM_STORAGE_CHAT_ID', runtimeEnv);
      if (botToken === null || chatId === null) {
        return {
          provider: null,
          configuredName: 'telegram-experimental',
          detail:
            'Telegram storage is selected but TELEGRAM_BOT_TOKEN and ' +
            'TELEGRAM_STORAGE_CHAT_ID are not both configured, so no provider is attached. ' +
            'Upload and download endpoints remain unavailable.',
          productionSafe: false,
        };
      }
      const transport = new TelegramHttpTransport({
        botToken,
        chatId,
        ...(config.telegram.apiBaseUrl === null ? {} : { apiBaseUrl: config.telegram.apiBaseUrl }),
        ...(config.telegram.filesBaseUrl === null
          ? {}
          : { filesBaseUrl: config.telegram.filesBaseUrl }),
        ...(config.telegram.workDir === null ? {} : { workDir: config.telegram.workDir }),
      });
      const localBotApi = isLocalBotApi(config.telegram.apiBaseUrl);
      // The public Bot API cannot serve a part back above 20 MiB, so a larger part would be
      // stored but never readable. Clamp to that ceiling unless a `--local` server is in use.
      const maxPartSizeBytes = localBotApi
        ? config.telegram.maxPartSizeBytes
        : Math.min(
            config.telegram.maxPartSizeBytes ?? PUBLIC_BOT_API_MAX_RETRIEVABLE_BYTES,
            PUBLIC_BOT_API_MAX_RETRIEVABLE_BYTES,
          );
      // The largest object that may ride as ONE document. `--local` raises it to the server's own
      // 2000 MB ceiling; the public Bot API caps retrieval at 20 MiB, so nothing bigger could be
      // read back even if it were accepted.
      const wholeObjectCeiling = localBotApi
        ? LOCAL_BOT_API_MAX_DOCUMENT_BYTES
        : (maxPartSizeBytes ?? PUBLIC_BOT_API_MAX_RETRIEVABLE_BYTES);
      const provider = new TelegramStorageProvider({
        transport,
        // Keep the provider's own object ceiling equal to the size the API already advertises, so
        // the two cannot disagree about what fits: a file the API accepts is never refused by the
        // provider before a single byte has moved.
        maxObjectSizeBytes: config.limits.maxFileSizeBytes,
        ...(maxPartSizeBytes === null ? {} : { maxPartSizeBytes }),
        // A self-hosted `--local` server can hold a whole object as one document, so stage the
        // parts and send once at finalize: one document per file, up to the server's ceiling.
        maxWholeObjectSizeBytes: Math.min(wholeObjectCeiling, config.limits.maxFileSizeBytes),
        stagePartsToSingleDocument: localBotApi,
      });
      return {
        provider,
        configuredName: 'telegram-experimental',
        detail:
          'Telegram storage is attached but experimental: it passes the provider contract ' +
          'suite, yet it is not validated for production and Telegram retention is not a ' +
          'durability guarantee (see docs/STORAGE-PROVIDERS.md).',
        productionSafe: false,
      };
    }

    default: {
      const exhaustive: never = config.storageProvider;
      return {
        provider: null,
        configuredName: 'none',
        detail: `Unknown storage provider "${String(exhaustive)}"; no provider is attached.`,
        productionSafe: false,
      };
    }
  }
}
