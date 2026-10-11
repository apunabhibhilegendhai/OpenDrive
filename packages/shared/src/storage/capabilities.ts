/**
 * Storage capability model.
 *
 * No provider may be assumed to support multipart uploads, random access,
 * direct downloads or permanent storage. Instead every provider publishes a
 * `StorageCapabilities` object and the platform refuses operations the provider
 * does not actually support, instead of failing halfway through an upload.
 *
 * A provider must never set a capability flag to `true` merely because the
 * operation sometimes works: flags are a contract asserted by the contract test
 * suite in `storage/testing/storage-contract.ts`.
 */
import { AppError } from '../errors.js';

export interface StorageCapabilities {
  /** Accepts an object in multiple independently-uploaded parts. */
  multipartUpload: boolean;
  /** Accepts a whole object as a single stream in one request. */
  singleShotUpload: boolean;
  /** An in-progress upload survives a process restart (provider-side session state). */
  resumableUpload: boolean;
  /** Supports byte-range reads of stored objects. */
  rangedRead: boolean;
  /** Can issue a URL that serves the object without proxying through our API. */
  directDownloadUrl: boolean;
  /** Can verify an object's checksum itself, independently of our computation. */
  serverSideChecksum: boolean;
  /** Stored bytes are retained indefinitely by the provider's own policy. */
  permanentRetention: boolean;
  /** The provider guarantees redundancy/durability for stored bytes. */
  guaranteedDurability: boolean;
  /** Deletion is immediate and irreversible. */
  deleteIsFinal: boolean;
  /** Hard ceiling for a single object, or null when the provider documents none. */
  maxObjectSizeBytes: number | null;
  /** Smallest accepted part, or null when the provider puts no floor on parts. */
  minPartSizeBytes: number | null;
  /** Largest accepted part, or null when the provider documents no ceiling. */
  maxPartSizeBytes: number | null;
}

export const CAPABILITY_KEYS = [
  'multipartUpload',
  'singleShotUpload',
  'resumableUpload',
  'rangedRead',
  'directDownloadUrl',
  'serverSideChecksum',
  'permanentRetention',
  'guaranteedDurability',
  'deleteIsFinal',
  'maxObjectSizeBytes',
  'minPartSizeBytes',
  'maxPartSizeBytes',
] as const satisfies readonly (keyof StorageCapabilities)[];

export type CapabilityKey = keyof StorageCapabilities;
export type BooleanCapabilityKey = {
  [K in CapabilityKey]: StorageCapabilities[K] extends boolean ? K : never;
}[CapabilityKey];

export interface StorageProviderDescriptor {
  /** Stable identifier persisted alongside file metadata. Never shown to end users. */
  providerId: string;
  /** Human-readable label for operator tooling and logs. */
  displayName: string;
  /** True while limits and behaviour have not been validated for production use. */
  experimental: boolean;
  /** Honest statement of what is and is not guaranteed for bytes held here. */
  durabilityNotes: string;
  capabilities: StorageCapabilities;
}

/**
 * Throws unless the provider declares the capability. Every call site that relies
 * on optional behaviour must call this first so failure is explicit and early.
 */
export function assertCapability(
  descriptor: StorageProviderDescriptor,
  capability: BooleanCapabilityKey,
  operation: string,
): void {
  if (descriptor.capabilities[capability] !== true) {
    throw new AppError('STORAGE_CAPABILITY_UNSUPPORTED', {
      detail: `Storage provider "${descriptor.providerId}" does not support ${capability}; ${operation} is unavailable for this provider.`,
      context: { providerId: descriptor.providerId, capability, operation },
    });
  }
}

/** Effective per-object ceiling: the provider's own limit, if it publishes one. */
export function providerObjectLimit(descriptor: StorageProviderDescriptor): number | null {
  return descriptor.capabilities.maxObjectSizeBytes;
}

export function describeCapabilities(capabilities: StorageCapabilities): {
  enabled: string[];
  disabled: string[];
} {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    const value = capabilities[key];
    if (typeof value === 'boolean') {
      (value ? enabled : disabled).push(key);
    }
  }
  return { enabled, disabled };
}
