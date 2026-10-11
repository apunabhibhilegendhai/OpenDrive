import type { StorageProvider } from '@opendrive/shared';
import { MemoryStorageProvider } from '@opendrive/shared/storage/testing';
import type { ApiConfig } from '../config.js';

/**
 * Storage provider registry.
 *
 * Phase 0 has no production storage backend. Rather than shipping a fake one, this
 * module returns either a real provider or `null` plus an explanation. The API then
 * reports uploads as unavailable instead of accepting bytes it cannot store.
 *
 * Guardrails encoded here:
 * - The in-memory test double is refused in production outright.
 * - The Telegram backend is advertised as experimental and is not implemented yet, so
 *   selecting it yields no provider rather than a pretend one.
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

export function resolveStorageProvider(config: ApiConfig): StorageResolution {
  switch (config.storageProvider) {
    case 'none':
      return {
        provider: null,
        configuredName: 'none',
        detail:
          'No storage provider is configured. Upload and download endpoints are declared but ' +
          'unimplemented, and return 501 NOT_IMPLEMENTED.',
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

    case 'telegram-experimental':
      return {
        provider: null,
        configuredName: 'telegram-experimental',
        detail:
          'Telegram storage is experimental, not production-validated, and not implemented ' +
          'yet (see docs/STORAGE-PROVIDERS.md). No provider is attached.',
        productionSafe: false,
      };

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
