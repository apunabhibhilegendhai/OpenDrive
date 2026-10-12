import type { StorageProvider } from '@opendrive/shared';
import { AppError } from '@opendrive/shared';
import { MemoryStorageProvider } from '@opendrive/shared/storage/testing';
import type { ApiConfig } from '../config.js';
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
      const provider = new TelegramStorageProvider({
        transport,
        ...(config.telegram.maxPartSizeBytes === null
          ? {}
          : { maxPartSizeBytes: config.telegram.maxPartSizeBytes }),
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
