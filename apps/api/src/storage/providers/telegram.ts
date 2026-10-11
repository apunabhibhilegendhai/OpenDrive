import { createHash } from 'node:crypto';
import {
  AppError,
  assertCapability,
  duplicateRequest,
  integrityCheckFailed,
  invalidSessionState,
  newOpaqueToken,
  objectNotFound,
  providerLimitExceeded,
  sessionExpired,
  sha256HexOfBytes,
  storageUnavailable,
  uploadNotFound,
} from '@opendrive/shared';
import type {
  AbortReason,
  ByteRange,
  ByteSource,
  ByteStream,
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
import {
  TelegramApiError,
  TelegramNotFoundError,
  TelegramPayloadTooLargeError,
  type TelegramTransport,
  type TelegramUploadReceipt,
} from './telegram-transport.js';

/**
 * Telegram Bot API storage provider.
 *
 * An object becomes an ordered list of parts; each part is uploaded as a document message
 * to the configured chat via sendDocument and read back via getFile + the file endpoint.
 * The locator persisted alongside the file metadata encodes exactly those Telegram
 * message/file ids, so a restarted process can still stream or delete the object from the
 * locator alone — the provider keeps no other server state for finished objects.
 *
 * Honest limits (see `capabilities` and docs/STORAGE-PROVIDERS.md):
 * - The standard Bot API cannot download a single file above 20 MiB, so parts default to
 *   20 MiB and objects are split into as many parts as needed. A self-hosted Local Bot API
 *   server lifts that ceiling (TELEGRAM_MAX_PART_SIZE_BYTES).
 * - A whole-object upload must fit in one Telegram file, so `uploadWholeObject` refuses
 *   anything above the part ceiling; large objects must use multipart.
 * - No checksumming, range reads, direct download URLs or server-side state survive
 *   restarts, so those capabilities are declared false.
 * - Durability is not guaranteed: Telegram retention is policy, not contract.
 */

const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB configured target
const DEFAULT_MAX_PART_BYTES = 20 * 1024 * 1024; // standard Bot API download ceiling
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
/** Transient read failures are retried this many times before the part is given up on. */
const DEFAULT_READ_RETRY_ATTEMPTS = 4;
const DEFAULT_READ_RETRY_DELAY_MS = 500;
/** Cap on parts read at once while verifying, before the memory budget below is applied. */
const DEFAULT_MAX_VERIFY_CONCURRENCY = 8;
/** Bytes the verify pass may hold in flight; keeps a large part size from buffering the object. */
const VERIFY_BUFFER_BUDGET_BYTES = 256 * 1024 * 1024;

export interface TelegramStorageProviderOptions {
  /** Transport used for every Telegram call. Tests inject an in-memory fake. */
  transport: TelegramTransport;
  providerId?: string;
  displayName?: string;
  /** Hard ceiling for a single object, enforced at initiate. */
  maxObjectSizeBytes?: number;
  /** Largest accepted part; also the largest single file Telegram must serve back. */
  maxPartSizeBytes?: number;
  sessionTtlSeconds?: number;
  /** How many times a transient read failure is retried before it is surfaced. */
  readRetryAttempts?: number;
  /** Base backoff between read retries in milliseconds; tests pass 0 for instant retries. */
  readRetryDelayMs?: number;
  /**
   * Upper bound on parts read concurrently while verifying a finalized upload. Also bounded
   * internally by a memory budget, so a provider with a very large part size reads fewer
   * parts at once rather than buffering the whole object.
   */
  maxVerifyConcurrency?: number;
  now?: () => Date;
}

interface StagedPart {
  partNumber: number;
  messageId: number;
  fileId: string;
  fileSize: number;
}

interface TelegramUpload {
  input: InitiateUploadInput;
  mode: 'multipart' | 'single-shot';
  parts: Map<number, StagedPart>;
  receivedBytes: number;
  session: UploadSession;
  finalized: StoredObject | null;
}

/** In-process record of completed objects, used for usage/`storedAt` only. */
interface TelegramObjectRecord {
  sizeBytes: number;
  checksumSha256: string | null;
  contentType: string | null;
  storedAt: string;
}

/** `ref.locator` payload. Self-contained: a restarted provider needs nothing else. */
interface LocatorPart {
  n: number; // part number (1-based)
  m: number; // Telegram message id
  f: string; // Telegram file_id
  s: number; // part size in bytes
}
interface LocatorV1 {
  v: 1;
  parts: LocatorPart[];
  size: number;
  checksum: string | null;
  contentType: string | null;
}

export function encodeLocator(payload: LocatorV1): string {
  return btoa(JSON.stringify(payload))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function decodeLocator(locator: string): LocatorV1 {
  let json: string;
  try {
    json = atob(locator.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    throw objectNotFound();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw objectNotFound();
  }
  if (!isLocatorV1(payload)) throw objectNotFound();
  return payload;
}

function isLocatorV1(value: unknown): value is LocatorV1 {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return false;
  if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) {
    return false;
  }
  if (record.checksum !== null && typeof record.checksum !== 'string') return false;
  if (record.contentType !== null && typeof record.contentType !== 'string') return false;
  const parts = record.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  return parts.every((part) => {
    if (typeof part !== 'object' || part === null) return false;
    const item = part as Record<string, unknown>;
    return (
      typeof item.n === 'number' &&
      Number.isSafeInteger(item.n) &&
      item.n >= 1 &&
      typeof item.m === 'number' &&
      Number.isSafeInteger(item.m) &&
      typeof item.f === 'string' &&
      item.f.length > 0 &&
      typeof item.s === 'number' &&
      Number.isSafeInteger(item.s) &&
      item.s >= 0
    );
  });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True when Telegram reported a failure that a later attempt may survive. */
function isRetryableTelegramError(error: unknown): boolean {
  return error instanceof TelegramApiError && error.retryable;
}

export class TelegramStorageProvider implements StorageProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly experimental = true;
  readonly durabilityNotes =
    'Bytes are stored as file parts inside a Telegram chat the bot controls. Telegram ' +
    'retention is not contractual: large or unaccessed media can be removed by Telegram, and ' +
    'anyone holding the bot token can read the files. The standard Bot API also cannot ' +
    'download a single file above 20 MiB, so objects are split into parts carefully kept ' +
    'under that ceiling. Treat this provider as undurable: do not store data you cannot ' +
    'afford to lose.';
  readonly capabilities: StorageCapabilities;

  private readonly uploads = new Map<string, TelegramUpload>();
  private readonly objects = new Map<string, TelegramObjectRecord>();
  /**
   * Locators this process has deleted. Telegram keeps resolving a file id — and serving the
   * bytes — after its message is deleted (measured against the live Bot API: `getFile` still
   * answered and the download still returned the original SHA-256 more than 35s after
   * `deleteMessage`). An existence probe therefore cannot honour "a deleted object must read
   * as gone", so deletion is recorded here as well. The tombstone is process-local, which is
   * why `deleteIsFinal` stays false: another process, or this one after a restart, has no way
   * to observe it, and Telegram may still hold a copy.
   */
  private readonly deleted = new Set<string>();
  private readonly transport: TelegramTransport;
  private readonly maxObjectSizeBytes: number;
  private readonly maxPartSizeBytes: number;
  private readonly sessionTtlSeconds: number;
  private readonly readRetryAttempts: number;
  private readonly readRetryDelayMs: number;
  private readonly maxVerifyConcurrency: number;
  private readonly now: () => Date;

  constructor(options: TelegramStorageProviderOptions) {
    this.transport = options.transport;
    this.providerId = options.providerId ?? 'telegram';
    this.displayName = options.displayName ?? 'Telegram Bot API storage (experimental)';
    this.maxObjectSizeBytes = options.maxObjectSizeBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.maxPartSizeBytes = options.maxPartSizeBytes ?? DEFAULT_MAX_PART_BYTES;
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.readRetryAttempts = options.readRetryAttempts ?? DEFAULT_READ_RETRY_ATTEMPTS;
    this.readRetryDelayMs = options.readRetryDelayMs ?? DEFAULT_READ_RETRY_DELAY_MS;
    this.maxVerifyConcurrency = options.maxVerifyConcurrency ?? DEFAULT_MAX_VERIFY_CONCURRENCY;
    this.now = options.now ?? (() => new Date());
    this.capabilities = {
      multipartUpload: true,
      singleShotUpload: true,
      // Staged part state lives in this process only; a restart loses in-progress uploads.
      resumableUpload: false,
      // Telegram file URLs are whole-file downloads; there is no server-side range read.
      rangedRead: false,
      // A Telegram file URL embeds the bot token, so direct links are never issued.
      directDownloadUrl: false,
      // Telegram performs no integrity checking of its own.
      serverSideChecksum: false,
      permanentRetention: false,
      guaranteedDurability: false,
      // deleteMessage removes the message immediately, but nothing proves Telegram does not
      // retain copies server-side, so deletion is treated as not provably final.
      deleteIsFinal: false,
      maxObjectSizeBytes: this.maxObjectSizeBytes,
      minPartSizeBytes: 1,
      maxPartSizeBytes: this.maxPartSizeBytes,
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private requireUpload(uploadId: string): TelegramUpload {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw uploadNotFound(uploadId);
    return upload;
  }

  private assertNotExpired(upload: TelegramUpload): void {
    const expiresAt = upload.session.expiresAt;
    if (expiresAt !== null && this.now().getTime() > Date.parse(expiresAt)) {
      upload.session = { ...upload.session, state: 'expired' };
      throw sessionExpired(upload.session.uploadId);
    }
  }

  private assertOpen(upload: TelegramUpload): void {
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

    const ttlSeconds = input.sessionTtlSeconds ?? this.sessionTtlSeconds;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
    const minPartSizeBytes = this.capabilities.minPartSizeBytes ?? 1;
    const maxPartSizeBytes = this.capabilities.maxPartSizeBytes ?? input.chunkSizeBytes;
    const effectivePartSize = Math.min(
      Math.max(input.chunkSizeBytes, minPartSizeBytes),
      maxPartSizeBytes,
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
      providerSessionRef: `tg_${newOpaqueToken(8)}`,
      expiresAt,
    };

    this.uploads.set(input.uploadId, {
      input,
      mode: 'multipart',
      parts: new Map(),
      receivedBytes: 0,
      session,
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
    if (upload.receivedBytes + part.sizeBytes > upload.input.sizeBytes) {
      throw integrityCheckFailed(
        `Receiving part ${part.partNumber} would exceed the declared object size of ${upload.input.sizeBytes} bytes.`,
      );
    }

    const bytes = await this.stageBytes(part.source, part.sizeBytes);
    const receipt = await this.uploadPartBytes({
      partNumber: part.partNumber,
      fileId: upload.input.fileId,
      bytes,
    });
    upload.parts.set(part.partNumber, {
      partNumber: part.partNumber,
      messageId: receipt.messageId,
      fileId: receipt.fileId,
      fileSize: bytes.byteLength,
    });
    upload.receivedBytes += bytes.byteLength;
    upload.session = { ...upload.session, state: 'in_progress' };
    return {
      partNumber: part.partNumber,
      receivedBytes: bytes.byteLength,
      checksumSha256: null,
    };
  }

  /** Sends one part through the transport, translating Telegram failures into provider errors. */
  private async uploadPartBytes(input: {
    partNumber: number;
    fileId: string;
    bytes: Uint8Array;
  }): Promise<TelegramUploadReceipt> {
    try {
      return await this.transport.sendDocument({
        filename: `${input.fileId}-part${input.partNumber}.bin`,
        mimeType: 'application/octet-stream',
        bytes: input.bytes,
        caption: `od part ${input.partNumber}`,
      });
    } catch (error) {
      if (error instanceof TelegramPayloadTooLargeError) {
        throw providerLimitExceeded(
          `Telegram refused part ${input.partNumber}: ${error.description}`,
        );
      }
      if (error instanceof TelegramApiError) {
        throw storageUnavailable(
          `Telegram upload of part ${input.partNumber} failed: ${error.description}`,
          error,
        );
      }
      throw storageUnavailable(`Telegram upload of part ${input.partNumber} failed.`, error);
    }
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
    if (input.sizeBytes > this.maxPartSizeBytes) {
      throw providerLimitExceeded(
        `A whole-object upload must fit in one Telegram file; the part ceiling is ` +
          `${this.maxPartSizeBytes} bytes. Use multipart delivery for larger objects.`,
      );
    }
    upload.mode = 'single-shot';

    const bytes = await this.stageBytes(input.source, input.sizeBytes);
    const checksum = await sha256HexOfBytes(bytes);
    const declared = input.checksumSha256 ?? upload.input.checksumSha256 ?? null;
    if (declared !== null && declared !== checksum) {
      // Nothing becomes readable on mismatch: the object is never registered.
      throw integrityCheckFailed('Whole-object checksum mismatch: nothing becomes readable.');
    }

    const receipt = await this.uploadPartBytes({
      partNumber: 1,
      fileId: upload.input.fileId,
      bytes,
    });
    upload.parts.set(1, {
      partNumber: 1,
      messageId: receipt.messageId,
      fileId: receipt.fileId,
      fileSize: bytes.byteLength,
    });
    upload.receivedBytes = bytes.byteLength;
    upload.session = { ...upload.session, state: 'in_progress' };
    const staged = upload.parts.get(1);
    if (staged === undefined) throw new AppError('INTERNAL', { detail: 'Staged part 1 vanished.' });
    return this.commitUpload(upload, [staged], checksum);
  }

  async finalizeUpload(session: UploadSession): Promise<StoredObject> {
    const upload = this.requireUpload(session.uploadId);
    // Idempotent: a retried finalize must not create a second object.
    if (upload.finalized !== null) return upload.finalized;

    this.assertOpen(upload);
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

    const ordered = [...upload.parts.values()].sort(
      (left, right) => left.partNumber - right.partNumber,
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const part = ordered[index];
      if (part !== undefined && part.partNumber !== index + 1) {
        throw invalidSessionState(`Upload ${session.uploadId} has a gap in part numbers.`);
      }
    }

    let received = 0;
    for (const part of ordered) received += part.fileSize;
    if (received !== upload.input.sizeBytes) {
      throw integrityCheckFailed(
        `Upload ${session.uploadId} staged ${received} bytes but declared ${upload.input.sizeBytes}.`,
      );
    }

    // Integrity before availability: verify the whole-object checksum by reading the staged
    // parts back through Telegram, streaming through a bounded hasher (never the whole object).
    const checksum = await this.hashObjectParts(ordered);
    const declaredChecksum = upload.input.checksumSha256 ?? null;
    if (declaredChecksum !== null && declaredChecksum !== checksum) {
      throw integrityCheckFailed('Whole-object checksum mismatch: nothing becomes readable.');
    }
    return this.commitUpload(upload, ordered, checksum);
  }

  /**
   * Verifies the whole-object checksum by reading every staged part back through Telegram.
   *
   * Parts are read through a bounded window and each part is buffered whole before hashing, for
   * two reasons measured against the live Bot API: reads are throttled to well under a MiB/s per
   * connection, so a strictly sequential verify would take hours on a multi-GiB object; and a
   * stream cannot be rewound, so a retry is only safe when the whole part is re-read from the
   * start rather than spliced into an in-progress hash.
   */
  private async hashObjectParts(parts: readonly StagedPart[]): Promise<string> {
    const window = this.verifyWindowSize();
    const pending: Array<Promise<Uint8Array>> = [];
    const start = (index: number): void => {
      const part = parts[index];
      if (part === undefined) return;
      const promise = this.readPartBytes(part);
      // A later part can reject before an earlier one is awaited; keep that from surfacing as an
      // unhandled rejection. Awaiting the promise below still observes the failure.
      promise.catch(() => undefined);
      pending[index] = promise;
    };
    for (let index = 0; index < Math.min(window, parts.length); index += 1) start(index);

    const hash = createHash('sha256');
    for (let index = 0; index < parts.length; index += 1) {
      const part = pending[index];
      if (part === undefined) {
        throw new AppError('INTERNAL', { detail: `Verify window lost part ${index + 1}.` });
      }
      hash.update(await part);
      start(index + window);
    }
    return hash.digest('hex');
  }

  /** Parts to read at once during verify, bounded by the concurrency cap and the byte budget. */
  private verifyWindowSize(): number {
    const perPart = Math.max(1, this.maxPartSizeBytes);
    const byBudget = Math.floor(VERIFY_BUFFER_BUDGET_BYTES / perPart);
    return Math.max(1, Math.min(this.maxVerifyConcurrency, byBudget));
  }

  /**
   * Reads one stored part into memory, retrying transient Telegram failures. The part ceiling
   * bounds the buffer, so verification never holds more than a window of parts at once.
   */
  private async readPartBytes(part: StagedPart): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.readRetryAttempts; attempt += 1) {
      try {
        const file = await this.transport.getFile(part.fileId);
        const stream = await this.transport.download(file.filePath);
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.byteLength;
          if (total > this.maxPartSizeBytes) {
            throw storageUnavailable(
              `Telegram returned more than the ${this.maxPartSizeBytes}-byte part ceiling ` +
                `for part ${part.partNumber}.`,
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
      } catch (error) {
        if (!isRetryableTelegramError(error)) this.throwReadFailure(part, error);
        lastError = error;
        if (attempt < this.readRetryAttempts) {
          await sleep(this.readRetryDelayMs * attempt);
        }
      }
    }
    this.throwReadFailure(part, lastError);
  }

  /** Resolves a part's download stream, mapping Telegram failures into provider errors. */
  private async openPartStream(part: { messageId: number; fileId: string }): Promise<ByteStream> {
    try {
      const file = await this.transport.getFile(part.fileId);
      return await this.transport.download(file.filePath);
    } catch (error) {
      this.throwReadFailure(part, error);
    }
  }

  /** Maps a read failure onto the provider's error taxonomy. Always throws. */
  private throwReadFailure(part: { messageId: number; fileId: string }, error: unknown): never {
    // An already-classified provider error carries the most precise message; pass it through.
    if (error instanceof AppError) throw error;
    if (error instanceof TelegramNotFoundError) throw objectNotFound();
    if (error instanceof TelegramApiError) {
      throw storageUnavailable(
        `Telegram could not read a stored part (message ${part.messageId}): ${error.description}`,
        error,
      );
    }
    throw storageUnavailable(
      `Telegram could not read a stored part (message ${part.messageId}).`,
      error,
    );
  }

  private async commitUpload(
    upload: TelegramUpload,
    parts: readonly StagedPart[],
    checksum: string,
  ): Promise<StoredObject> {
    const storedAt = this.timestamp();
    const locator = encodeLocator({
      v: 1,
      parts: parts.map((part) => ({
        n: part.partNumber,
        m: part.messageId,
        f: part.fileId,
        s: part.fileSize,
      })),
      size: upload.input.sizeBytes,
      checksum,
      contentType: upload.input.mimeType,
    });
    const stored: StoredObject = {
      ref: {
        providerId: this.providerId,
        locator,
        sizeBytes: upload.input.sizeBytes,
        checksumSha256: checksum,
      },
      sizeBytes: upload.input.sizeBytes,
      checksumSha256: checksum,
      storedAt,
    };
    this.objects.set(locator, {
      sizeBytes: stored.sizeBytes,
      checksumSha256: checksum,
      contentType: upload.input.mimeType,
      storedAt,
    });
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
    if (upload.session.state === 'aborted') return;
    for (const part of upload.parts.values()) {
      try {
        await this.transport.deleteMessage(part.messageId);
      } catch {
        // Best effort: the session is being torn down regardless of chat-level hiccups.
      }
    }
    upload.parts.clear();
    upload.receivedBytes = 0;
    upload.session = { ...upload.session, state: 'aborted' };
  }

  async getMetadata(ref: StoreObjectRef): Promise<ObjectMetadata> {
    const locator = decodeLocator(ref.locator);
    // Deletion wins over any probe result: Telegram would still report a deleted file as
    // present, so the tombstone is the only reliable signal for this process.
    if (this.deleted.has(ref.locator)) throw objectNotFound();
    const first = locator.parts[0];
    if (first === undefined) throw objectNotFound();
    // The idempotent-delete contract: a deleted object must read as gone, even for a
    // provider instance that never saw the delete. Probe Telegram for the first part.
    let present: boolean;
    try {
      await this.transport.getFile(first.f);
      present = true;
    } catch (error) {
      if (error instanceof TelegramNotFoundError) present = false;
      else if (error instanceof TelegramApiError) {
        throw storageUnavailable(
          `Telegram could not confirm whether the object still exists: ${error.description}`,
          error,
        );
      } else {
        throw storageUnavailable(
          'Telegram could not confirm whether the object still exists.',
          error,
        );
      }
    }
    if (!present) throw objectNotFound();
    const record = this.objects.get(ref.locator);
    return {
      ref,
      sizeBytes: locator.size,
      contentType: locator.contentType,
      checksumSha256: locator.checksum,
      storedAt: record?.storedAt ?? null,
    };
  }

  async openReadStream(ref: StoreObjectRef, range?: ByteRange): Promise<ReadResult> {
    const locator = decodeLocator(ref.locator);
    if (this.deleted.has(ref.locator)) throw objectNotFound();
    if (range !== undefined) {
      assertCapability(this, 'rangedRead', 'openReadStream with a byte range');
    }
    return {
      stream: this.readParts(locator.parts),
      length: locator.size,
      range: null,
    };
  }

  private async *readParts(parts: readonly LocatorPart[]): ByteStream {
    for (const part of parts) {
      const ref = { messageId: part.m, fileId: part.f };
      const stream = await this.openPartStream(ref);
      try {
        for await (const chunk of stream) yield chunk;
      } catch (error) {
        // Serving a client streams straight through, so a mid-body drop can only be surfaced,
        // not retried: the consumer already holds the chunks delivered before the failure.
        this.throwReadFailure(ref, error);
      }
    }
  }

  async deleteObject(ref: StoreObjectRef): Promise<DeleteOutcome> {
    const locator = decodeLocator(ref.locator);
    let removedAny = false;
    for (const part of locator.parts) {
      let removed: boolean;
      try {
        removed = await this.transport.deleteMessage(part.m);
      } catch (error) {
        if (error instanceof TelegramNotFoundError) {
          removed = false;
        } else if (error instanceof TelegramApiError) {
          throw storageUnavailable(
            `Telegram could not delete a stored part (message ${part.m}): ${error.description}`,
            error,
          );
        } else {
          throw storageUnavailable(
            `Telegram could not delete a stored part (message ${part.m}).`,
            error,
          );
        }
      }
      if (removed) removedAny = true;
    }
    this.objects.delete(ref.locator);
    this.deleted.add(ref.locator);
    if (removedAny) return { deleted: true, alreadyAbsent: false };
    return { deleted: false, alreadyAbsent: true };
  }

  async describeUsage(): Promise<StorageUsage> {
    let usedBytes = 0;
    for (const record of this.objects.values()) usedBytes += record.sizeBytes;
    return { usedBytes, objectCount: this.objects.size };
  }

  async health(): Promise<StorageHealth> {
    const started = Date.now();
    try {
      const me = await this.transport.getMe();
      return {
        status: 'ok',
        checkedAt: this.timestamp(),
        detail: `Telegram bot @${me.username === '' ? me.id : me.username} is reachable.`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const detail =
        error instanceof TelegramApiError
          ? `Telegram API unreachable: ${error.description}`
          : 'Telegram API unreachable.';
      return { status: 'unavailable', checkedAt: this.timestamp(), detail, latencyMs: null };
    }
  }
}
