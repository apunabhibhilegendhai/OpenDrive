export {
  CAPABILITY_KEYS,
  assertCapability,
  describeCapabilities,
  providerObjectLimit,
} from './capabilities.js';
export type {
  BooleanCapabilityKey,
  CapabilityKey,
  StorageCapabilities,
  StorageProviderDescriptor,
} from './capabilities.js';

export {
  duplicateRequest,
  integrityCheckFailed,
  invalidSessionState,
  objectNotFound,
  providerLimitExceeded,
  sessionExpired,
  storageUnavailable,
  uploadNotFound,
} from './errors.js';

export type {
  AbortReason,
  ByteRange,
  ByteSource,
  ByteStream,
  DeleteOutcome,
  DownloadUrl,
  InitiateUploadInput,
  ObjectMetadata,
  ReadResult,
  StorageHealth,
  StorageProvider,
  StorageUsage,
  StoreObjectRef,
  StoredObject,
  UploadPartInput,
  UploadPartResult,
  UploadSession,
  UploadSessionState,
  UploadWholeObjectInput,
} from './types.js';
