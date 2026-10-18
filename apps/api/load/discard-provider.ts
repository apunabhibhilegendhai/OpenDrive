import {
  AppError,
  assertCapability,
  duplicateRequest,
  integrityCheckFailed,
  invalidSessionState,
  providerLimitExceeded,
  sessionExpired,
  storageUnavailable,
  uploadNotFound,
} from '@opendrive/shared';
import type {
  AbortReason,
  ByteRange,
  ByteSource,
  DeleteOutcome,
  InitiateUploadInput,
  ObjectMetadata,
  ReadResult,
  StorageCapabilities,
  StorageHealth,
  StorageProvider,
  StorageUsage,
  StoreObjectRef,
  StoredObject,
  UploadPartInput,
  UploadPartResult,
  UploadSession,
  UploadWholeObjectInput,
} from '@opendrive/shared';

/**
 * A storage provider for load runs that counts bytes and keeps none.
 *
 * It exists so a load test can push terabytes through the *real* upload engine — session records,
 * quota holds, part admission, provider calls, background finalize — without asking a real backend
 * to hold them. It is not a test double in the "pretend it worked" sense: it consumes every part
 * stream to the end with backpressure (so a client cannot send faster than the server reads),
 * enforces the same part-size, duplicate-part and completeness rules the Telegram provider does,
 * and refuses reads because it genuinely cannot serve bytes.
 *
 * It is deliberately not selectable from environment configuration: `STORAGE_PROVIDER` has no
 * `load-test` value, so this can never back a deployment by accident.
 */

interface Upload {
  input: InitiateUploadInput;
  session: UploadSession;
  parts: Map<number, number>;
  receivedBytes: number;
  finalized: StoredObject | null;
}

export interface DiscardProviderOptions {
  /** Artificial delay per part, to approximate a remote backend. Zero means "as fast as read". */
  readonly partDelayMs?: number;
  readonly maxPartSizeBytes?: number;
  readonly maxObjectSizeBytes?: number;
  readonly now?: () => Date;
  /**
   * Materialise each part whole before discarding it. Default true, because that is what the
   * deployed Telegram backend does (`stageBytes` merges the part into one buffer, then the
   * transport copies it into a request body), and per-part memory is the quantity this harness
   * exists to measure. Set false to measure the route's own overhead with a streaming backend.
   */
  readonly bufferParts?: boolean;
}

const DEFAULT_MAX_PART_BYTES = 64 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class DiscardStorageProvider implements StorageProvider {
  readonly providerId = 'load-test-discard';
  readonly displayName = 'Load-test discard storage (keeps no bytes)';
  readonly experimental = true;
  readonly durabilityNotes =
    'This provider is a load-test instrument. It reads every byte it is sent and stores none of ' +
    'it, so nothing uploaded through it survives the process. It must never be configured as a ' +
    'deployment backend.';
  readonly capabilities: StorageCapabilities;

  private readonly uploads = new Map<string, Upload>();
  private readonly partDelayMs: number;
  private readonly bufferParts: boolean;
  private readonly now: () => Date;
  /**
   * Parts held for the simulated backend call. This is what makes the memory reading comparable to
   * the deployment: a real backend keeps the part's buffer alive for the whole send (seconds to
   * Telegram), while a provider that returns instantly lets V8 free it immediately and understates
   * peak memory at any concurrency.
   */
  private readonly heldParts = new Set<Uint8Array>();

  constructor(options: DiscardProviderOptions = {}) {
    this.partDelayMs = options.partDelayMs ?? 0;
    this.bufferParts = options.bufferParts ?? true;
    this.now = options.now ?? (() => new Date());
    const maxObjectSizeBytes = options.maxObjectSizeBytes ?? null;
    const maxPartSizeBytes = options.maxPartSizeBytes ?? DEFAULT_MAX_PART_BYTES;
    this.capabilities = {
      multipartUpload: true,
      singleShotUpload: true,
      // Session state is in this process only, exactly like the other providers in this build.
      resumableUpload: false,
      rangedRead: false,
      directDownloadUrl: false,
      serverSideChecksum: false,
      permanentRetention: false,
      guaranteedDurability: false,
      deleteIsFinal: false,
      maxObjectSizeBytes,
      minPartSizeBytes: 1,
      maxPartSizeBytes,
    };
  }

  private requireUpload(uploadId: string): Upload {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw uploadNotFound(uploadId);
    return upload;
  }

  private assertOpen(upload: Upload): void {
    const expiresAt = upload.session.expiresAt;
    if (expiresAt !== null && this.now().getTime() > Date.parse(expiresAt)) {
      upload.session = { ...upload.session, state: 'expired' };
      throw sessionExpired(upload.session.uploadId);
    }
    const state = upload.session.state;
    if (state !== 'initiated' && state !== 'in_progress') {
      throw invalidSessionState(
        `Upload ${upload.session.uploadId} is "${state}" and cannot accept more bytes.`,
      );
    }
  }

  /**
   * Reads a part to its end, enforcing the declared length.
   *
   * In buffered mode this holds the part whole, twice: once as the merged copy and once as the
   * request-body copy the Telegram transport makes — the same peak the deployment pays per
   * in-flight part. In streaming mode only the current chunk is alive.
   */
  private async countBytes(
    source: ByteSource,
    declaredBytes: number,
    partNumber: number,
  ): Promise<number> {
    let total = 0;
    if (source instanceof Uint8Array) {
      total = source.byteLength;
    } else if (this.bufferParts) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) {
        total += chunk.byteLength;
        if (total > declaredBytes) {
          throw integrityCheckFailed(
            `Part ${partNumber} sent more than its declared ${declaredBytes} bytes.`,
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
      // The production transport's second copy, so the peak matches the deployed path.
      const body = new Uint8Array(merged.byteLength);
      body.set(merged);
      total = body.byteLength;
      if (this.partDelayMs > 0) {
        this.heldParts.add(merged);
        this.heldParts.add(body);
        try {
          await sleep(this.partDelayMs);
        } finally {
          this.heldParts.delete(merged);
          this.heldParts.delete(body);
        }
      }
    } else {
      for await (const chunk of source) {
        total += chunk.byteLength;
        if (total > declaredBytes) {
          throw integrityCheckFailed(
            `Part ${partNumber} sent more than its declared ${declaredBytes} bytes.`,
          );
        }
      }
      // A streaming backend holds no part, so the simulated service time costs nothing here.
      if (this.partDelayMs > 0) await sleep(this.partDelayMs);
    }
    if (total !== declaredBytes) {
      throw integrityCheckFailed(
        `Part ${partNumber} declared ${declaredBytes} bytes but sent ${total}.`,
      );
    }
    return total;
  }

  async initiateUpload(input: InitiateUploadInput): Promise<UploadSession> {
    const existing = this.uploads.get(input.uploadId);
    if (existing !== undefined) {
      if (existing.finalized !== null) return { ...existing.session, state: 'finalized' };
      return existing.session;
    }
    const maxObject = this.capabilities.maxObjectSizeBytes;
    if (maxObject !== null && input.sizeBytes > maxObject) {
      throw providerLimitExceeded(
        `Declared size ${input.sizeBytes} exceeds the provider ceiling of ${maxObject} bytes.`,
      );
    }
    if (input.sizeBytes <= 0) {
      throw new AppError('INVALID_REQUEST', { detail: 'Upload size must be greater than zero.' });
    }
    const partSizeBytes = Math.min(
      Math.max(input.chunkSizeBytes, this.capabilities.minPartSizeBytes ?? 1),
      this.capabilities.maxPartSizeBytes ?? input.chunkSizeBytes,
    );
    const session: UploadSession = {
      uploadId: input.uploadId,
      fileId: input.fileId,
      providerId: this.providerId,
      state: 'initiated',
      partSizeBytes,
      expectedParts: Math.ceil(input.sizeBytes / partSizeBytes),
      providerSessionRef: `discard_${input.uploadId}`,
      expiresAt: new Date(
        this.now().getTime() + (input.sessionTtlSeconds ?? 86_400) * 1000,
      ).toISOString(),
    };
    this.uploads.set(input.uploadId, {
      input,
      session,
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
    const maxPart = this.capabilities.maxPartSizeBytes;
    if (maxPart !== null && part.sizeBytes > maxPart) {
      throw providerLimitExceeded(
        `Part ${part.partNumber} declares ${part.sizeBytes} bytes, above the ${maxPart}-byte ceiling.`,
      );
    }
    if (upload.parts.has(part.partNumber)) {
      throw duplicateRequest(
        `Part ${part.partNumber} was already received for session ${session.uploadId}.`,
      );
    }
    if (upload.receivedBytes + part.sizeBytes > upload.input.sizeBytes) {
      throw integrityCheckFailed(
        `Receiving part ${part.partNumber} would exceed the declared object size.`,
      );
    }
    const received = await this.countBytes(part.source, part.sizeBytes, part.partNumber);
    upload.parts.set(part.partNumber, received);
    upload.receivedBytes += received;
    upload.session = { ...upload.session, state: 'in_progress' };
    return { partNumber: part.partNumber, receivedBytes: received, checksumSha256: null };
  }

  async uploadWholeObject(input: UploadWholeObjectInput): Promise<StoredObject> {
    assertCapability(this, 'singleShotUpload', 'uploadWholeObject');
    const upload = this.requireUpload(input.session.uploadId);
    this.assertOpen(upload);
    const received = await this.countBytes(input.source, input.sizeBytes, 1);
    upload.parts.set(1, received);
    upload.receivedBytes = received;
    upload.session = { ...upload.session, state: 'in_progress' };
    return this.commit(upload);
  }

  private commit(upload: Upload): StoredObject {
    const expectedParts = upload.session.expectedParts;
    if (expectedParts !== null && upload.parts.size !== expectedParts) {
      throw invalidSessionState(
        `Upload ${upload.session.uploadId} is missing parts: expected ${expectedParts}, ` +
          `received ${upload.parts.size}.`,
      );
    }
    for (let index = 0; index < upload.parts.size; index += 1) {
      if (!upload.parts.has(index + 1)) {
        throw invalidSessionState(`Upload ${upload.session.uploadId} has a gap in part numbers.`);
      }
    }
    if (upload.receivedBytes !== upload.input.sizeBytes) {
      throw integrityCheckFailed(
        `Upload ${upload.session.uploadId} received ${upload.receivedBytes} of ${upload.input.sizeBytes} bytes.`,
      );
    }
    const stored: StoredObject = {
      ref: {
        providerId: this.providerId,
        locator: `discard:${upload.session.uploadId}:${upload.input.sizeBytes}`,
        sizeBytes: upload.input.sizeBytes,
        checksumSha256: null,
      },
      sizeBytes: upload.input.sizeBytes,
      checksumSha256: null,
      storedAt: this.now().toISOString(),
    };
    upload.parts.clear();
    upload.receivedBytes = 0;
    upload.finalized = stored;
    upload.session = { ...upload.session, state: 'finalized' };
    return stored;
  }

  async finalizeUpload(session: UploadSession): Promise<StoredObject> {
    const upload = this.requireUpload(session.uploadId);
    if (upload.finalized !== null) return upload.finalized;
    this.assertOpen(upload);
    return this.commit(upload);
  }

  async abortUpload(session: UploadSession, _reason: AbortReason): Promise<void> {
    const upload = this.uploads.get(session.uploadId);
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
    if (!ref.locator.startsWith('discard:')) throw storageUnavailable('Unknown object locator.');
    return {
      ref,
      sizeBytes: ref.sizeBytes,
      contentType: null,
      checksumSha256: null,
      storedAt: null,
    };
  }

  async openReadStream(_ref: StoreObjectRef, _range?: ByteRange): Promise<ReadResult> {
    throw storageUnavailable(
      'The load-test discard provider stores no bytes, so it cannot serve a read.',
    );
  }

  async deleteObject(_ref: StoreObjectRef): Promise<DeleteOutcome> {
    return { deleted: false, alreadyAbsent: true };
  }

  async describeUsage(): Promise<StorageUsage> {
    return { usedBytes: 0, objectCount: 0 };
  }

  async health(): Promise<StorageHealth> {
    return {
      status: 'ok',
      checkedAt: this.now().toISOString(),
      detail: 'Load-test discard provider: accepted bytes are counted and discarded.',
      latencyMs: 0,
    };
  }
}
