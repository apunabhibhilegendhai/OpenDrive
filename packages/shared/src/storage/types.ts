import type { StorageProviderDescriptor } from './capabilities.js';

/**
 * Provider-agnostic storage interface.
 *
 * Design rules (enforced by the contract suite in `storage/testing/storage-contract.ts`):
 *
 * 1. Streaming only. Implementations consume `ByteStream`s with backpressure and
 *    buffer no more than a bounded part in memory. Nothing here may require a whole
 *    object in application memory — a 2 GB file must stream through in parts.
 * 2. No provider leakage. `StoreObjectRef.locator` is opaque and provider-specific.
 *    It is persisted alongside file metadata and must never appear in a public API
 *    response or log line.
 * 3. No assumed capabilities. Operations that depend on an optional capability must
 *    throw `STORAGE_CAPABILITY_UNSUPPORTED` when the flag is false (see
 *    `assertCapability`).
 * 4. Idempotent failure handling. Uploads are stateful workflows: staged parts for an
 *    abandoned or failed upload must be releasable via `abortUpload`, and `deleteObject`
 *    is idempotent. `finalizeUpload` on an already-finalized session returns the stored
 *    object rather than creating a duplicate.
 * 5. Integrity before availability. When a checksum is supplied, a mismatch fails the
 *    operation and no object becomes readable.
 */

/** A single-use stream of bytes. Sources are not re-readable. */
export type ByteStream = AsyncIterable<Uint8Array>;

/** Either a stream (preferred) or a small in-memory buffer. */
export type ByteSource = ByteStream | Uint8Array;

export type UploadSessionState =
  'initiated' | 'in_progress' | 'finalized' | 'aborted' | 'expired' | 'failed';

export interface InitiateUploadInput {
  /** Internal upload id (`upl_…`). Idempotency key for duplicate initiate requests. */
  uploadId: string;
  /** Internal file id (`file_…`) the bytes belong to. */
  fileId: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  chunkSizeBytes: number;
  /** Optional whole-object SHA-256, verified by the provider when declared. */
  checksumSha256?: string | null;
  /** How long an incomplete upload may stay staged before it is garbage collected. */
  sessionTtlSeconds?: number;
}

export interface UploadSession {
  uploadId: string;
  fileId: string;
  providerId: string;
  state: UploadSessionState;
  /** Size the provider wants each part to be (may differ from the requested chunk size). */
  partSizeBytes: number;
  /** Parts expected for the declared size, or null when the provider cannot know yet. */
  expectedParts: number | null;
  /** Opaque provider-side session handle, when the provider keeps server state. */
  providerSessionRef: string | null;
  expiresAt: string | null;
}

export interface UploadPartInput {
  partNumber: number;
  source: ByteSource;
  sizeBytes: number;
  /** Checksum of this part, verified when the provider supports integrity checks. */
  checksumSha256?: string | null;
}

export interface UploadPartResult {
  partNumber: number;
  receivedBytes: number;
  checksumSha256: string | null;
}

export interface UploadWholeObjectInput {
  session: UploadSession;
  source: ByteStream;
  sizeBytes: number;
  checksumSha256?: string | null;
}

/** Opaque pointer to bytes. `locator` never leaves the server. */
export interface StoreObjectRef {
  providerId: string;
  locator: string;
  sizeBytes: number;
  checksumSha256: string | null;
}

export interface StoredObject {
  ref: StoreObjectRef;
  sizeBytes: number;
  checksumSha256: string | null;
  /** ISO-8601 timestamp. */
  storedAt: string;
}

export interface ObjectMetadata {
  ref: StoreObjectRef;
  sizeBytes: number;
  contentType: string | null;
  checksumSha256: string | null;
  storedAt: string | null;
}

/** Inclusive byte offsets; `endInclusive` is not an exclusive bound. */
export interface ByteRange {
  start: number;
  endInclusive: number;
}

export interface ReadResult {
  stream: ByteStream;
  /** Bytes that will be produced by the stream. */
  length: number;
  /** Echoes the satisfied range, or null for a full read. */
  range: ByteRange | null;
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}

export interface DeleteOutcome {
  /** True when this call removed bytes. */
  deleted: boolean;
  /** True when the object was already gone; deletion is idempotent. */
  alreadyAbsent: boolean;
}

export interface StorageHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  checkedAt: string;
  detail: string;
  latencyMs: number | null;
}

export interface StorageUsage {
  usedBytes: number | null;
  objectCount: number;
}

export type AbortReason =
  'client_cancelled' | 'expired' | 'failed' | 'orphaned_cleanup' | 'integrity_failure';

export interface StorageProvider extends StorageProviderDescriptor {
  /** Opens an upload session. Requires nothing; every provider can start a session. */
  initiateUpload(input: InitiateUploadInput): Promise<UploadSession>;

  /** Requires `multipartUpload`. Sends one part; parts may arrive out of order. */
  uploadPart(session: UploadSession, part: UploadPartInput): Promise<UploadPartResult>;

  /** Requires `singleShotUpload`. Sends the whole object as one stream. */
  uploadWholeObject(input: UploadWholeObjectInput): Promise<StoredObject>;

  /**
   * Completes the upload and returns the stored object.
   * Idempotent: finalizing an already-finalized session returns the same object.
   */
  finalizeUpload(session: UploadSession): Promise<StoredObject>;

  /** Releases staged bytes. Idempotent for aborted sessions; refuses finalized ones. */
  abortUpload(session: UploadSession, reason: AbortReason): Promise<void>;

  getMetadata(ref: StoreObjectRef): Promise<ObjectMetadata>;

  /** Requires `rangedRead` when `range` is provided. */
  openReadStream(ref: StoreObjectRef, range?: ByteRange): Promise<ReadResult>;

  /** Requires `directDownloadUrl`. */
  getDownloadUrl?(ref: StoreObjectRef, ttlSeconds: number): Promise<DownloadUrl>;

  /** Idempotent. */
  deleteObject(ref: StoreObjectRef): Promise<DeleteOutcome>;

  /** Optional: providers that can report capacity. */
  describeUsage?(): Promise<StorageUsage>;

  /** Non-destructive reachability probe used by readiness checks. */
  health(): Promise<StorageHealth>;
}
