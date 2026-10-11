import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { newOpaqueToken, sha256HexOfBytes } from '../../tokens.js';
import { assertCapability } from '../capabilities.js';
import type { StorageCapabilities } from '../capabilities.js';
import {
  duplicateRequest,
  integrityCheckFailed,
  invalidSessionState,
  objectNotFound,
  providerLimitExceeded,
  sessionExpired,
  storageUnavailable,
  uploadNotFound,
} from '../errors.js';
import type {
  AbortReason,
  ByteRange,
  ByteSource,
  ByteStream,
  DeleteOutcome,
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
  UploadWholeObjectInput,
} from '../types.js';

/**
 * TEST DOUBLE — NOT A STORAGE BACKEND.
 *
 * `MemoryStorageProvider` holds bytes in the process heap. It is used to exercise the
 * storage contract, to develop the API without a real backend and to run tests. It is
 * explicitly NOT production storage: bytes vanish on restart, are not shared between
 * processes, are not durable and are not encrypted. Never configure it for a deployed
 * environment, and never treat data written here as persisted.
 *
 * Capability flags below describe exactly what this double can do, so that the same
 * contract suite that will be used for real providers (Telegram, S3-compatible, …)
 * can run against it.
 */

const DEFAULT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const DEFAULT_CAPACITY_BYTES = 64 * 1024 * 1024;
const DEFAULT_PART_SIZE_BYTES = 1024 * 1024;

export interface MemoryStorageProviderOptions {
  providerId?: string;
  displayName?: string;
  /** Hard ceiling for one object. Objects above it are rejected with PAYLOAD_TOO_LARGE. */
  maxObjectSizeBytes?: number;
  /** Total staged + stored bytes retained in memory before writes are refused. */
  capacityBytes?: number;
  partSizeBytes?: number;
  /** Override individual capability flags to exercise capability-failure paths. */
  capabilities?: Partial<StorageCapabilities>;
  now?: () => Date;
}

interface StagedUpload {
  /** How bytes are being delivered. Mixing modes within one session is refused. */
  mode: 'multipart' | 'single-shot';
  session: UploadSession;
  declaredSizeBytes: number;
  declaredChecksum: string | null;
  contentType: string;
  parts: Map<number, Uint8Array>;
  receivedBytes: number;
  finalized: StoredObject | null;
}

interface StoredBlob {
  bytes: Uint8Array;
  contentType: string;
  checksumSha256: string | null;
  storedAt: string;
}

function defaultCapabilities(
  maxObjectSizeBytes: number,
  partSizeBytes: number,
): StorageCapabilities {
  return {
    multipartUpload: true,
    singleShotUpload: true,
    // Staged uploads live in this process only: a restart loses them.
    resumableUpload: false,
    rangedRead: true,
    directDownloadUrl: false,
    serverSideChecksum: true,
    // Not durable storage, so these must stay false.
    permanentRetention: false,
    guaranteedDurability: false,
    deleteIsFinal: true,
    maxObjectSizeBytes,
    minPartSizeBytes: 1,
    maxPartSizeBytes: partSizeBytes,
  };
}

/** Consumes a byte source, refusing to buffer more than `maxBytes`. */
async function collect(source: ByteSource, maxBytes: number): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > maxBytes) {
      throw providerLimitExceeded(
        `Received ${source.byteLength} bytes, above the accepted maximum of ${maxBytes}`,
      );
    }
    return source.slice();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw providerLimitExceeded(
        `Streamed payload exceeds the accepted maximum of ${maxBytes} bytes`,
      );
    }
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function* sliceStream(bytes: Uint8Array, range: ByteRange | null): ByteStream {
  const window = range === null ? bytes : bytes.subarray(range.start, range.endInclusive + 1);
  const step = 64 * 1024;
  for (let offset = 0; offset < window.byteLength; offset += step) {
    yield window.subarray(offset, Math.min(offset + step, window.byteLength));
  }
}

export class MemoryStorageProvider implements StorageProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly experimental = true;
  readonly durabilityNotes =
    'Process-local memory only. Bytes are lost on restart, shared with no other process, ' +
    'not durable and not encrypted. Test double — never use for real user data.';
  readonly capabilities: StorageCapabilities;

  private readonly uploads = new Map<string, StagedUpload>();
  private readonly objects = new Map<string, StoredBlob>();
  private readonly capacityBytes: number;
  private readonly partSizeBytes: number;
  private readonly now: () => Date;

  constructor(options: MemoryStorageProviderOptions = {}) {
    this.providerId = options.providerId ?? 'memory-test';
    this.displayName = options.displayName ?? 'In-memory test double';
    this.partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
    const maxObjectSizeBytes = options.maxObjectSizeBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.capacityBytes = options.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
    this.capabilities = {
      ...defaultCapabilities(maxObjectSizeBytes, this.partSizeBytes),
      ...options.capabilities,
    };
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /** Current staged + stored byte count. */
  describeUsageSync(): { stagedBytes: number; storedBytes: number } {
    let stagedBytes = 0;
    for (const upload of this.uploads.values()) stagedBytes += upload.receivedBytes;
    let storedBytes = 0;
    for (const blob of this.objects.values()) storedBytes += blob.bytes.byteLength;
    return { stagedBytes, storedBytes };
  }

  private requireUpload(uploadId: string): StagedUpload {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw uploadNotFound(uploadId);
    return upload;
  }

  private assertNotExpired(upload: StagedUpload): void {
    const expiresAt = upload.session.expiresAt;
    if (expiresAt !== null && this.now().getTime() > Date.parse(expiresAt)) {
      upload.session = { ...upload.session, state: 'expired' };
      throw sessionExpired(upload.session.uploadId);
    }
  }

  private assertOpen(upload: StagedUpload): void {
    this.assertNotExpired(upload);
    const state = upload.session.state;
    if (state !== 'initiated' && state !== 'in_progress') {
      throw invalidSessionState(
        `Upload ${upload.session.uploadId} is "${state}" and cannot accept more bytes.`,
      );
    }
  }

  private async stageBytes(source: ByteSource, declaredBytes: number): Promise<Uint8Array> {
    const bytes = await collect(source, declaredBytes);
    if (bytes.byteLength !== declaredBytes) {
      throw integrityCheckFailed(
        `Declared ${declaredBytes} bytes but received ${bytes.byteLength}.`,
      );
    }
    return bytes;
  }

  private assertCapacity(additionalBytes: number): void {
    const { stagedBytes, storedBytes } = this.describeUsageSync();
    if (stagedBytes + storedBytes + additionalBytes > this.capacityBytes) {
      throw storageUnavailable(
        'In-memory test provider is at capacity. This limit exists only in the test double; ' +
          'a real provider would report its own quota error.',
      );
    }
  }

  async initiateUpload(input: InitiateUploadInput): Promise<UploadSession> {
    const existing = this.uploads.get(input.uploadId);
    if (existing !== undefined) {
      if (existing.finalized !== null) return { ...existing.session, state: 'finalized' };
      // Duplicate initiate for a live session: return the same session, do not restart it.
      return existing.session;
    }
    const maxObjectSizeBytes = this.capabilities.maxObjectSizeBytes;
    if (maxObjectSizeBytes !== null && input.sizeBytes > maxObjectSizeBytes) {
      throw providerLimitExceeded(
        `Declared size ${input.sizeBytes} exceeds this provider's ceiling of ${maxObjectSizeBytes} bytes.`,
      );
    }
    if (input.sizeBytes <= 0) {
      throw new AppError('INVALID_REQUEST', { detail: 'Upload size must be greater than zero.' });
    }

    const ttlSeconds = input.sessionTtlSeconds ?? 24 * 60 * 60;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
    // The caller proposes a chunk size; the provider clamps it into the range it accepts
    // and reports the effective value back on the session.
    const effectivePartSize = Math.min(
      Math.max(input.chunkSizeBytes, this.capabilities.minPartSizeBytes ?? 1),
      this.capabilities.maxPartSizeBytes ?? input.chunkSizeBytes,
    );
    const expectedParts =
      this.capabilities.multipartUpload && effectivePartSize > 0
        ? Math.ceil(input.sizeBytes / effectivePartSize)
        : null;

    const session: UploadSession = {
      uploadId: input.uploadId,
      fileId: input.fileId,
      providerId: this.providerId,
      state: 'initiated',
      partSizeBytes: effectivePartSize,
      expectedParts,
      providerSessionRef: `mem_${newOpaqueToken(8)}`,
      expiresAt,
    };

    this.uploads.set(input.uploadId, {
      mode: this.capabilities.multipartUpload ? 'multipart' : 'single-shot',
      session,
      declaredSizeBytes: input.sizeBytes,
      declaredChecksum: input.checksumSha256 ?? null,
      contentType: input.mimeType,
      parts: new Map(),
      receivedBytes: 0,
      finalized: null,
    });
    return session;
  }

  async uploadPart(session: UploadSession, part: UploadPartInput): Promise<UploadPartResult> {
    assertCapability(this, 'multipartUpload', 'uploadPart');
    const upload = this.requireUpload(session.uploadId);
    this.assertOpen(upload);
    if (upload.mode === 'single-shot') {
      throw invalidSessionState(
        `Upload ${session.uploadId} is being delivered as a single object; parts cannot be added to it.`,
      );
    }

    const maxPartSizeBytes = this.capabilities.maxPartSizeBytes;
    if (maxPartSizeBytes !== null && part.sizeBytes > maxPartSizeBytes) {
      throw providerLimitExceeded(
        `Part ${part.partNumber} declares ${part.sizeBytes} bytes, above the provider part ceiling of ${maxPartSizeBytes}.`,
      );
    }
    const minPartSizeBytes = this.capabilities.minPartSizeBytes;
    if (minPartSizeBytes !== null && part.sizeBytes < minPartSizeBytes) {
      throw new AppError('INVALID_REQUEST', {
        detail: `Part ${part.partNumber} declares ${part.sizeBytes} bytes, below the provider minimum of ${minPartSizeBytes}.`,
      });
    }
    if (upload.parts.has(part.partNumber)) {
      throw duplicateRequest(
        `Part ${part.partNumber} was already uploaded for session ${session.uploadId}. ` +
          'Retrying a part requires aborting the session first, so a silent overwrite cannot corrupt the object.',
      );
    }
    if (upload.receivedBytes + part.sizeBytes > upload.declaredSizeBytes) {
      throw integrityCheckFailed(
        `Receiving part ${part.partNumber} would exceed the declared object size of ${upload.declaredSizeBytes} bytes.`,
      );
    }

    this.assertCapacity(part.sizeBytes);
    const bytes = await this.stageBytes(part.source, part.sizeBytes);
    const checksum = await sha256HexOfBytes(bytes);
    if (
      this.capabilities.serverSideChecksum &&
      part.checksumSha256 != null &&
      part.checksumSha256 !== checksum
    ) {
      throw integrityCheckFailed(
        `Part ${part.partNumber} checksum mismatch: declared ${part.checksumSha256}, computed ${checksum}.`,
      );
    }

    upload.parts.set(part.partNumber, bytes);
    upload.receivedBytes += bytes.byteLength;
    upload.session = { ...upload.session, state: 'in_progress' };
    return {
      partNumber: part.partNumber,
      receivedBytes: bytes.byteLength,
      checksumSha256: this.capabilities.serverSideChecksum ? checksum : null,
    };
  }

  async uploadWholeObject(input: UploadWholeObjectInput): Promise<StoredObject> {
    assertCapability(this, 'singleShotUpload', 'uploadWholeObject');
    const upload = this.requireUpload(input.session.uploadId);
    this.assertOpen(upload);
    if (upload.mode === 'multipart' && upload.parts.size > 0) {
      throw invalidSessionState(
        `Upload ${input.session.uploadId} already has staged parts; ` +
          'refusing to mix multipart and single-object delivery in one session.',
      );
    }
    upload.mode = 'single-shot';
    this.assertCapacity(input.sizeBytes);

    const bytes = await this.stageBytes(input.source, input.sizeBytes);
    upload.parts.set(1, bytes);
    upload.receivedBytes = bytes.byteLength;
    upload.session = { ...upload.session, state: 'in_progress' };
    return this.finalizeUpload(upload.session);
  }

  async finalizeUpload(session: UploadSession): Promise<StoredObject> {
    const upload = this.requireUpload(session.uploadId);
    // Idempotent: a retried finalize must not create a second object.
    if (upload.finalized !== null) return upload.finalized;

    this.assertOpen(upload);
    // Completeness: a single-object delivery is proven complete by byte count alone,
    // while a multipart delivery must have exactly the parts the session declared.
    const expectedParts = upload.session.expectedParts;
    if (
      upload.mode === 'multipart' &&
      expectedParts !== null &&
      upload.parts.size !== expectedParts
    ) {
      throw invalidSessionState(
        `Upload ${session.uploadId} is missing parts: expected ${expectedParts}, received ${upload.parts.size}.`,
      );
    }
    let received = 0;
    for (const part of upload.parts.values()) received += part.byteLength;
    if (received !== upload.declaredSizeBytes) {
      throw integrityCheckFailed(
        `Upload ${session.uploadId} staged ${received} bytes but declared ${upload.declaredSizeBytes}.`,
      );
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    const orderedParts = [...upload.parts.entries()].sort(([left], [right]) => left - right);
    for (const [, part] of orderedParts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }

    const checksum = await sha256HexOfBytes(merged);
    if (upload.declaredChecksum !== null && upload.declaredChecksum !== checksum) {
      // Nothing becomes readable on mismatch: no object is registered.
      throw integrityCheckFailed(
        `Whole-object checksum mismatch: declared ${upload.declaredChecksum}, computed ${checksum}.`,
      );
    }

    const locator = `${this.providerId}/${newId('storageObject')}`;
    const stored: StoredObject = {
      ref: {
        providerId: this.providerId,
        locator,
        sizeBytes: merged.byteLength,
        checksumSha256: checksum,
      },
      sizeBytes: merged.byteLength,
      checksumSha256: checksum,
      storedAt: this.timestamp(),
    };
    this.objects.set(locator, {
      bytes: merged,
      contentType: upload.contentType,
      checksumSha256: checksum,
      storedAt: stored.storedAt,
    });

    // Release staged parts; the object map now owns the bytes.
    upload.parts.clear();
    upload.receivedBytes = 0;
    upload.finalized = stored;
    upload.session = { ...upload.session, state: 'finalized' };
    return stored;
  }

  async abortUpload(session: UploadSession, _reason: AbortReason): Promise<void> {
    const upload = this.uploads.get(session.uploadId);
    // Idempotent by design: orphan clean-up must never fail on an unknown or
    // already-aborted session.
    if (upload === undefined) return;
    if (upload.finalized !== null) {
      throw invalidSessionState(
        `Upload ${session.uploadId} is finalized; delete the stored object instead of aborting.`,
      );
    }
    upload.parts.clear();
    upload.receivedBytes = 0;
    upload.session = { ...upload.session, state: 'aborted' };
  }

  async getMetadata(ref: StoreObjectRef): Promise<ObjectMetadata> {
    const blob = this.objects.get(ref.locator);
    if (blob === undefined) throw objectNotFound();
    return {
      ref: { ...ref, sizeBytes: blob.bytes.byteLength, checksumSha256: blob.checksumSha256 },
      sizeBytes: blob.bytes.byteLength,
      contentType: blob.contentType,
      checksumSha256: blob.checksumSha256,
      storedAt: blob.storedAt,
    };
  }

  async openReadStream(ref: StoreObjectRef, range?: ByteRange): Promise<ReadResult> {
    const blob = this.objects.get(ref.locator);
    if (blob === undefined) throw objectNotFound();
    if (range === undefined) {
      return {
        stream: sliceStream(blob.bytes, null),
        length: blob.bytes.byteLength,
        range: null,
      };
    }
    assertCapability(this, 'rangedRead', 'openReadStream with a byte range');
    if (
      range.start < 0 ||
      range.endInclusive < range.start ||
      range.endInclusive >= blob.bytes.byteLength
    ) {
      throw new AppError('INVALID_REQUEST', {
        detail: `Range ${range.start}-${range.endInclusive} is outside the object (0-${blob.bytes.byteLength - 1}).`,
      });
    }
    return {
      stream: sliceStream(blob.bytes, range),
      length: range.endInclusive - range.start + 1,
      range,
    };
  }

  async deleteObject(ref: StoreObjectRef): Promise<DeleteOutcome> {
    const existing = this.objects.get(ref.locator);
    if (existing === undefined) return { deleted: false, alreadyAbsent: true };
    this.objects.delete(ref.locator);
    return { deleted: true, alreadyAbsent: false };
  }

  async describeUsage(): Promise<StorageUsage> {
    const { storedBytes } = this.describeUsageSync();
    return { usedBytes: storedBytes, objectCount: this.objects.size };
  }

  async health(): Promise<StorageHealth> {
    return {
      status: 'ok',
      checkedAt: this.timestamp(),
      detail: 'In-memory test double is reachable (no durability guarantee).',
      latencyMs: 0,
    };
  }
}
