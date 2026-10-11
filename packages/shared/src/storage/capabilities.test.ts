import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  CAPABILITY_KEYS,
  assertCapability,
  describeCapabilities,
  providerObjectLimit,
} from './capabilities.js';
import type { StorageProviderDescriptor } from './capabilities.js';
import { MemoryStorageProvider } from './testing/memory-provider.js';

function descriptor(
  overrides: Partial<StorageProviderDescriptor['capabilities']> = {},
): StorageProviderDescriptor {
  const capabilities = new MemoryStorageProvider().capabilities;
  return {
    providerId: 'fixture-provider',
    displayName: 'Fixture',
    experimental: false,
    durabilityNotes: 'Fixture provider used only in unit tests.',
    capabilities: { ...capabilities, ...overrides },
  };
}

describe('capability handling', () => {
  it('lists every capability key so documentation cannot drift', () => {
    const declared = Object.keys(new MemoryStorageProvider().capabilities).sort();
    expect([...CAPABILITY_KEYS].sort()).toEqual(declared);
  });

  it('allows operations whose capability is declared', () => {
    expect(() => assertCapability(descriptor(), 'multipartUpload', 'uploadPart')).not.toThrow();
  });

  it('refuses operations whose capability is not declared, naming the provider and operation', () => {
    try {
      assertCapability(descriptor({ rangedRead: false }), 'rangedRead', 'openReadStream');
      throw new Error('expected assertCapability to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('STORAGE_CAPABILITY_UNSUPPORTED');
      expect(appError.detail).toContain('fixture-provider');
      expect(appError.detail).toContain('rangedRead');
      expect(appError.detail).toContain('openReadStream');
    }
  });

  it('summarises enabled and disabled capabilities', () => {
    const summary = describeCapabilities(descriptor({ rangedRead: false }).capabilities);
    expect(summary.disabled).toContain('rangedRead');
    expect(summary.enabled).toContain('multipartUpload');
    expect(summary.enabled).not.toContain('rangedRead');
  });

  it('reports the provider object ceiling', () => {
    expect(providerObjectLimit(descriptor())).toBe(16 * 1024 * 1024);
    expect(providerObjectLimit(descriptor({ maxObjectSizeBytes: null }))).toBeNull();
  });
});
