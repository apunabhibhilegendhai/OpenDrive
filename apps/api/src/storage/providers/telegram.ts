import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
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
  type TelegramFileInfo,
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
 *   server run with `--local` lifts that ceiling (TELEGRAM_MAX_PART_SIZE_BYTES, up to
 *   2000 MB) and returns absolute on-disk paths from `getFile`, which the transport reads
 *   from disk or rewrites through a configured file-server base URL.
 * - A whole-object upload must fit in one Telegram file, so `uploadWholeObject` refuses
 *   anything above the part ceiling; large objects must use multipart. A streamed whole
 *   object is spooled once to a temp file (never buffered whole in memory) and each upload
 *   attempt re-reads the spool, so transient failures are retried from byte zero.
 * - Transient upload failures are retried with backoff, mirroring the read path.
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
/** Transient upload failures (network drops, 5xx, rate limits) are retried with backoff. */
const DEFAULT_UPLOAD_RETRY_ATTEMPTS = 4;
const DEFAULT_UPLOAD_RETRY_DELAY_MS = 500;
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
  /**
   * Largest object this provider may deliver as ONE Telegram document. Defaults to
   * `maxPartSizeBytes`, i.e. no whole-object delivery beyond the part ceiling. Pointing at a
   * `--local` Bot API server (which lifts the 20 MiB retrieval ceiling) lets an operator raise
   * this to the server's own 2000 MB ceiling so a whole object rides in a single `sendDocument`.
   */
  maxWholeObjectSizeBytes?: number;
  /**
   * Deliver a multipart object as a single document instead of one document per part.
   *
   * When true and the declared object fits `maxWholeObjectSizeBytes`, `uploadPart` streams each
   * part to a local spool file instead of uploading it, and `finalizeUpload` reassembles and
   * sends the object as one `sendDocument`. This is what lets a client that must send small
   * parts (for example behind a proxy with a 100 MiB request-body cap) still store one document
   * per file. Defaults to false: each part becomes its own document.
   */
  stagePartsToSingleDocument?: boolean;
  sessionTtlSeconds?: number;
  /** How many times a transient read failure is retried before it is surfaced. */
  readRetryAttempts?: number;
  /** Base backoff between read retries in milliseconds; tests pass 0 for instant retries. */
  readRetryDelayMs?: number;
  /** How many times a transient upload failure is retried before it is surfaced. */
  uploadRetryAttempts?: number;
  /** Base backoff between upload retries in milliseconds; tests pass 0 for instant retries. */
  uploadRetryDelayMs?: number;
  /**
   * Directory used to spool a streamed whole-object upload once to disk (see
   * `DEFAULT_*`): memory stays bounded to a part, the checksum is computed before anything
   * is sent, and each upload attempt re-reads the spool so a transient failure can be
   * retried from byte zero. Defaults to the OS temp directory.
   */
  spoolDir?: string;
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
  /**
   * Set in staged mode: the part's bytes on local disk, not yet sent to Telegram. The part is
   * uploaded (as part of the one whole-object document) at `finalizeUpload`.
   */
  spoolPath?: string;
}

interface TelegramUpload {
  input: InitiateUploadInput;
  mode: 'multipart' | 'single-shot' | 'staged';
  parts: Map<number, StagedPart>;
  receivedBytes: number;
  session: UploadSession;
  finalized: StoredObject | null;
  /** Directory holding staged part files (staged mode only). Created on the first part. */
  spoolDir?: string;
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

/**
 * Streams a whole object to a temp file while hashing it, refusing to exceed `declaredBytes`.
 * Memory stays bounded to a write buffer; the returned checksum and byte count let the caller
 * enforce integrity before anything is uploaded.
 */
async function spoolWholeObject(
  source: ByteStream,
  declaredBytes: number,
  dir: string,
): Promise<{ filePath: string; checksum: string; actualBytes: number }> {
  const filePath = join(dir, 'object.bin');
  const hash = createHash('sha256');
  let total = 0;
  const hashing = (async function* generate(): ByteStream {
    for await (const chunk of source) {
      total += chunk.byteLength;
      if (total > declaredBytes) {
        throw providerLimitExceeded(
          `Streamed payload exceeds the accepted maximum of ${declaredBytes} bytes`,
        );
      }
      hash.update(chunk);
      yield chunk;
    }
  })();
  await pipeline(hashing, createWriteStream(filePath));
  return { filePath, checksum: hash.digest('hex'), actualBytes: total };
}

/** Re-reads a spooled file as a fresh stream, so each upload attempt starts at byte zero. */
function localFileStream(filePath: string): ByteStream {
  return (async function* generate(): ByteStream {
    try {
      for await (const chunk of createReadStream(filePath)) {
        yield chunk;
      }
    } catch (error) {
      // A failure reading the spooled copy is transient at the transport's level: the retry
      // loop re-opens the file and starts over.
      throw new TelegramApiError(
        `Spooled file "${filePath}" could not be read.`,
        '',
        null,
        true,
        error,
      );
    }
  })();
}

/** Normalises a byte source to a stream so one code path handles buffers and streams alike. */
function toByteStream(source: ByteSource): ByteStream {
  if (source instanceof Uint8Array) {
    return (async function* generate(): ByteStream {
      yield source;
    })();
  }
  return source;
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
  private readonly maxWholeObjectSizeBytes: number;
  private readonly stagePartsToSingleDocument: boolean;
  private readonly sessionTtlSeconds: number;
  private readonly readRetryAttempts: number;
  private readonly readRetryDelayMs: number;
  private readonly uploadRetryAttempts: number;
  private readonly uploadRetryDelayMs: number;
  private readonly maxVerifyConcurrency: number;
  private readonly spoolDir: string;
  private readonly now: () => Date;

  constructor(options: TelegramStorageProviderOptions) {
    this.transport = options.transport;
    this.providerId = options.providerId ?? 'telegram';
    this.displayName = options.displayName ?? 'Telegram Bot API storage (experimental)';
    this.maxObjectSizeBytes = options.maxObjectSizeBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.maxPartSizeBytes = options.maxPartSizeBytes ?? DEFAULT_MAX_PART_BYTES;
    this.maxWholeObjectSizeBytes = options.maxWholeObjectSizeBytes ?? this.maxPartSizeBytes;
    this.stagePartsToSingleDocument = options.stagePartsToSingleDocument ?? false;
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.readRetryAttempts = options.readRetryAttempts ?? DEFAULT_READ_RETRY_ATTEMPTS;
    this.readRetryDelayMs = options.readRetryDelayMs ?? DEFAULT_READ_RETRY_DELAY_MS;
    this.uploadRetryAttempts = options.uploadRetryAttempts ?? DEFAULT_UPLOAD_RETRY_ATTEMPTS;
    this.uploadRetryDelayMs = options.uploadRetryDelayMs ?? DEFAULT_UPLOAD_RETRY_DELAY_MS;
    this.maxVerifyConcurrency = options.maxVerifyConcurrency ?? DEFAULT_MAX_VERIFY_CONCURRENCY;
    this.spoolDir = options.spoolDir ?? tmpdir();
    this.now = options.now ?? (() => new Date());
    this.capabilities = {
      multipartUpload: true,
      singleShotUpload: true,
      // Staged part state lives in this process only; a restart loses in-progress uploads.
      resumableUpload: false,
      // A range is served by requesting that window from the one part (or the few parts) that
      // cover it; the Bot API file endpoint used by the transport supports `Range`, and a server
      // that ignores it is trimmed in the transport, so a partial read never fetches the whole
      // object. See `openReadStream` / `readPartRange`.
      rangedRead: true,
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

    // Staged mode reassembles the parts into one document at finalize. It is only chosen when
    // the whole object fits the single-document ceiling, so the send can always be one file.
    const deliverAsSingleDocument =
      this.stagePartsToSingleDocument && input.sizeBytes <= this.maxWholeObjectSizeBytes;

    this.uploads.set(input.uploadId, {
      input,
      mode: deliverAsSingleDocument ? 'staged' : 'multipart',
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

    // Staged delivery: keep the bytes on local disk; the object is sent as one document at
    // finalize. Multipart delivery sends each part as its own document immediately.
    if (upload.mode === 'staged') {
      return await this.stagePartToDisk(upload, part);
    }

    const bytes = await this.stageBytes(part.source, part.sizeBytes);
    const receipt = await this.uploadPartBytes({
      partNumber: part.partNumber,
      fileId: upload.input.fileId,
      sizeBytes: bytes.byteLength,
      openSource: () => bytes,
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

  /**
   * Streams one part to a per-upload spool file without buffering it whole.
   *
   * The bytes never touch Telegram here: staged mode holds them locally until `finalizeUpload`
   * sends the reassembled object as a single document. The part is verified as it is written
   * (declared length, and its own checksum when supplied); any failure removes the partial file
   * so a retry starts from a clean slot.
   */
  private async stagePartToDisk(
    upload: TelegramUpload,
    part: UploadPartInput,
  ): Promise<UploadPartResult> {
    upload.spoolDir ??= await mkdtemp(join(this.spoolDir, 'opendrive-stage-'));
    const partPath = join(upload.spoolDir, `part-${part.partNumber}.bin`);
    const hash = createHash('sha256');
    let total = 0;
    const metered = (async function* generate(): ByteStream {
      for await (const chunk of toByteStream(part.source)) {
        total += chunk.byteLength;
        if (total > part.sizeBytes) {
          throw providerLimitExceeded(
            `Received more than the declared ${part.sizeBytes} bytes for part ${part.partNumber}.`,
          );
        }
        hash.update(chunk);
        yield chunk;
      }
    })();
    try {
      await pipeline(metered, createWriteStream(partPath));
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
    if (total !== part.sizeBytes) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw integrityCheckFailed(`Declared ${part.sizeBytes} bytes but received ${total}.`);
    }
    const actualChecksum = hash.digest('hex');
    if (part.checksumSha256 != null && part.checksumSha256 !== actualChecksum) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw integrityCheckFailed(`Part ${part.partNumber} failed its checksum check.`);
    }
    upload.parts.set(part.partNumber, {
      partNumber: part.partNumber,
      messageId: -1,
      fileId: '',
      fileSize: total,
      spoolPath: partPath,
    });
    upload.receivedBytes += total;
    upload.session = { ...upload.session, state: 'in_progress' };
    return {
      partNumber: part.partNumber,
      receivedBytes: total,
      checksumSha256: part.checksumSha256 ?? null,
    };
  }

  /** Re-reads every staged part file in part order as one continuous, re-readable stream. */
  private async *concatSpoolStream(parts: readonly StagedPart[]): ByteStream {
    for (const part of parts) {
      const path = part.spoolPath;
      if (path === undefined) {
        throw new AppError('INTERNAL', {
          detail: `Staged part ${part.partNumber} has no spool file.`,
        });
      }
      try {
        for await (const chunk of createReadStream(path)) yield chunk;
      } catch (error) {
        // The stream is re-readable, so a retry reopens it and starts from byte zero.
        throw new TelegramApiError(
          `Staged part file "${path}" could not be read.`,
          '',
          null,
          true,
          error,
        );
      }
    }
  }

  /** Whole-object SHA-256 of the staged parts, read in part order before anything is sent. */
  private async hashSpooledParts(parts: readonly StagedPart[]): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.concatSpoolStream(parts)) hash.update(chunk);
    return hash.digest('hex');
  }

  /** Removes the staged-mode spool directory and forgets the part files. */
  private async cleanupSpool(upload: TelegramUpload): Promise<void> {
    const dir = upload.spoolDir;
    if (dir === undefined) return;
    upload.spoolDir = undefined;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Sends the reassembled staged parts as ONE Telegram document.
   *
   * Integrity is checked before anything is sent — the assembled length and the whole-object
   * checksum (when declared) are verified from the spool files — so a mismatch leaves no orphan
   * document in the chat. The spool is removed only once the object is committed; a failed send
   * keeps it, so the client can retry finalize without re-uploading.
   */
  private async commitStagedUpload(upload: TelegramUpload): Promise<StoredObject> {
    const expectedParts = upload.session.expectedParts;
    if (expectedParts !== null && upload.parts.size !== expectedParts) {
      throw invalidSessionState(
        `Upload ${upload.session.uploadId} is missing parts: expected ${expectedParts}, ` +
          `received ${upload.parts.size}.`,
      );
    }
    const ordered = [...upload.parts.values()].sort(
      (left, right) => left.partNumber - right.partNumber,
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const part = ordered[index];
      if (part !== undefined && part.partNumber !== index + 1) {
        throw invalidSessionState(`Upload ${upload.session.uploadId} has a gap in part numbers.`);
      }
    }
    let received = 0;
    for (const part of ordered) received += part.fileSize;
    if (received !== upload.input.sizeBytes) {
      throw integrityCheckFailed(
        `Upload ${upload.session.uploadId} staged ${received} bytes but declared ${upload.input.sizeBytes}.`,
      );
    }

    const checksum = await this.hashSpooledParts(ordered);
    const declaredChecksum = upload.input.checksumSha256 ?? null;
    if (declaredChecksum !== null && declaredChecksum !== checksum) {
      throw integrityCheckFailed('Whole-object checksum mismatch: nothing becomes readable.');
    }

    const receipt = await this.uploadPartBytes({
      partNumber: 1,
      fileId: upload.input.fileId,
      sizeBytes: upload.input.sizeBytes,
      openSource: () => this.concatSpoolStream(ordered),
    });

    upload.parts.clear();
    upload.parts.set(1, {
      partNumber: 1,
      messageId: receipt.messageId,
      fileId: receipt.fileId,
      fileSize: upload.input.sizeBytes,
    });
    upload.receivedBytes = upload.input.sizeBytes;
    upload.session = { ...upload.session, state: 'in_progress' };
    const staged = upload.parts.get(1);
    if (staged === undefined) throw new AppError('INTERNAL', { detail: 'Staged part 1 vanished.' });
    const stored = await this.commitUpload(upload, [staged], checksum);
    await this.cleanupSpool(upload);
    return stored;
  }

  /**
   * Sends one Telegram document, retrying transient failures with backoff. `openSource`
   * must produce a fresh byte source per attempt — parts hand back the same buffer; a
   * streamed whole object produces a fresh stream from its spooled copy — so a retry always
   * restarts from byte zero instead of resuming an exhausted stream.
   */
  private async uploadPartBytes(input: {
    partNumber: number;
    fileId: string;
    sizeBytes: number;
    openSource: () => ByteSource;
  }): Promise<TelegramUploadReceipt> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.uploadRetryAttempts; attempt += 1) {
      try {
        return await this.transport.sendDocument({
          filename: `${input.fileId}-part${input.partNumber}.bin`,
          mimeType: 'application/octet-stream',
          source: input.openSource(),
          sizeBytes: input.sizeBytes,
          caption: `od part ${input.partNumber}`,
        });
      } catch (error) {
        if (!isRetryableTelegramError(error)) this.throwUploadFailure(input, error);
        lastError = error;
        if (attempt < this.uploadRetryAttempts) {
          await sleep(this.uploadRetryDelayMs * attempt);
        }
      }
    }
    this.throwUploadFailure(input, lastError);
  }

  /** Maps an upload failure onto the provider's error taxonomy. Always throws. */
  private throwUploadFailure(input: { partNumber: number }, error: unknown): never {
    if (error instanceof AppError) throw error;
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

  async uploadWholeObject(input: UploadWholeObjectInput): Promise<StoredObject> {
    assertCapability(this, 'singleShotUpload', 'uploadWholeObject');
    const upload = this.requireUpload(input.session.uploadId);
    this.assertOpen(upload);
    if (upload.mode !== 'single-shot' && upload.parts.size > 0) {
      throw invalidSessionState(
        `Upload ${input.session.uploadId} already has staged parts; ` +
          'refusing to mix multipart and single-object delivery in one session.',
      );
    }
    if (input.sizeBytes > this.maxWholeObjectSizeBytes) {
      throw providerLimitExceeded(
        `A whole-object upload must fit in one Telegram file; the single-document ceiling is ` +
          `${this.maxWholeObjectSizeBytes} bytes. Use multipart delivery for larger objects.`,
      );
    }
    upload.mode = 'single-shot';

    const { receipt, checksum } = await this.sendWholeObject({
      fileId: upload.input.fileId,
      source: input.source,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256 ?? upload.input.checksumSha256 ?? null,
    });
    upload.parts.set(1, {
      partNumber: 1,
      messageId: receipt.messageId,
      fileId: receipt.fileId,
      fileSize: input.sizeBytes,
    });
    upload.receivedBytes = input.sizeBytes;
    upload.session = { ...upload.session, state: 'in_progress' };
    const staged = upload.parts.get(1);
    if (staged === undefined) throw new AppError('INTERNAL', { detail: 'Staged part 1 vanished.' });
    return this.commitUpload(upload, [staged], checksum);
  }

  /**
   * Sends a whole object as a single Telegram document, streaming with bounded memory.
   *
   * A buffered `Uint8Array` is sent directly. A stream is spooled once to a temp file: the
   * checksum is computed while spooling and verified BEFORE anything is sent (a mismatch
   * must not leave an orphan document in the chat), and each upload attempt reads a fresh
   * stream from the spool so a transient failure retries from byte zero instead of resuming
   * an exhausted stream. Memory never holds the whole object.
   */
  private async sendWholeObject(input: {
    fileId: string;
    source: ByteSource;
    sizeBytes: number;
    checksumSha256: string | null;
  }): Promise<{ receipt: TelegramUploadReceipt; checksum: string }> {
    if (input.source instanceof Uint8Array) {
      if (input.source.byteLength !== input.sizeBytes) {
        throw integrityCheckFailed(
          `Declared ${input.sizeBytes} bytes but received ${input.source.byteLength}.`,
        );
      }
      const checksum = await sha256HexOfBytes(input.source);
      this.assertWholeObjectChecksum(checksum, input.checksumSha256);
      const receipt = await this.uploadPartBytes({
        partNumber: 1,
        fileId: input.fileId,
        sizeBytes: input.sizeBytes,
        openSource: () => input.source,
      });
      return { receipt, checksum };
    }

    const dir = await mkdtemp(join(this.spoolDir, 'opendrive-upload-'));
    try {
      const spooled = await spoolWholeObject(input.source, input.sizeBytes, dir);
      if (spooled.actualBytes !== input.sizeBytes) {
        throw integrityCheckFailed(
          `Declared ${input.sizeBytes} bytes but received ${spooled.actualBytes}.`,
        );
      }
      this.assertWholeObjectChecksum(spooled.checksum, input.checksumSha256);
      const receipt = await this.uploadPartBytes({
        partNumber: 1,
        fileId: input.fileId,
        sizeBytes: input.sizeBytes,
        openSource: () => localFileStream(spooled.filePath),
      });
      return { receipt, checksum: spooled.checksum };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private assertWholeObjectChecksum(actual: string, declared: string | null): void {
    if (declared !== null && declared !== actual) {
      // Nothing becomes readable on mismatch: the object is never registered, and because the
      // checksum is known before the send, nothing is uploaded to Telegram either.
      throw integrityCheckFailed('Whole-object checksum mismatch: nothing becomes readable.');
    }
  }

  async finalizeUpload(session: UploadSession): Promise<StoredObject> {
    const upload = this.requireUpload(session.uploadId);
    // Idempotent: a retried finalize must not create a second object.
    if (upload.finalized !== null) return upload.finalized;

    this.assertOpen(upload);
    // Staged mode reassembles the parts and sends ONE document; multipart mode verifies the
    // parts already sent as separate documents. Both are idempotent (guarded above).
    if (upload.mode === 'staged') {
      return await this.commitStagedUpload(upload);
    }
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
  private async openPartStream(
    part: { messageId: number; fileId: string },
    range?: ByteRange,
  ): Promise<ByteStream> {
    try {
      const file = await this.getFileWithRetry(part.fileId);
      return await this.transport.download(file.filePath, range);
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
    // Staged bytes live on local disk, never in the chat, so release the spool first.
    await this.cleanupSpool(upload);
    for (const part of upload.parts.values()) {
      if (part.messageId < 0) continue;
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

  /**
   * Resolves a file's download path through `transport.getFile`, retrying transient Telegram
   * failures with the same backoff as whole-part reads.
   *
   * The Local Bot API server can keep a freshly-uploaded multi-GB file locked for a while
   * (it writes/hashes the document in the background), so `getFile` may sit unanswered until
   * that finishes. `getMetadata` and the read path must tolerate this: a transient network
   * timeout is retryable, and a later attempt lands after the file is released.
   */
  private async getFileWithRetry(fileId: string): Promise<TelegramFileInfo> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.readRetryAttempts; attempt += 1) {
      try {
        return await this.transport.getFile(fileId);
      } catch (error) {
        if (!isRetryableTelegramError(error)) throw error;
        lastError = error;
        if (attempt < this.readRetryAttempts) {
          await sleep(this.readRetryDelayMs * attempt);
        }
      }
    }
    throw lastError;
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
      await this.getFileWithRetry(first.f);
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
    if (range === undefined) {
      return {
        stream: this.readParts(locator.parts),
        length: locator.size,
        range: null,
      };
    }
    assertCapability(this, 'rangedRead', 'openReadStream with a byte range');
    if (range.start < 0 || range.endInclusive < range.start || range.endInclusive >= locator.size) {
      throw new AppError('INVALID_REQUEST', {
        detail: `Range ${range.start}-${range.endInclusive} is outside the object (0-${locator.size - 1}).`,
      });
    }
    return {
      stream: this.readPartRange(locator.parts, range),
      length: range.endInclusive - range.start + 1,
      range,
    };
  }

  /**
   * Yields exactly the bytes in `range` by walking the parts that cover it. Parts before the
   * window are skipped without a request; the parts at either edge are asked for only the
   * sub-range they contribute, so a partial read of a multi-GiB object never pulls the whole
   * object through memory or the network.
   */
  private async *readPartRange(parts: readonly LocatorPart[], range: ByteRange): ByteStream {
    let base = 0;
    for (const part of parts) {
      if (base > range.endInclusive) break;
      const partEnd = base + part.s - 1;
      if (partEnd >= range.start) {
        const from = Math.max(range.start, base) - base;
        const to = Math.min(range.endInclusive, partEnd) - base;
        const wholePart = from === 0 && to === part.s - 1;
        const ref = { messageId: part.m, fileId: part.f };
        const stream = await this.openPartStream(
          ref,
          wholePart ? undefined : { start: from, endInclusive: to },
        );
        try {
          for await (const chunk of stream) yield chunk;
        } catch (error) {
          this.throwReadFailure(ref, error);
        }
      }
      base += part.s;
    }
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
