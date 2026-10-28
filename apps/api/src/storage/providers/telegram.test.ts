import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newId, sha256HexOfBytes } from '@opendrive/shared';
import type { ByteRange, ByteStream } from '@opendrive/shared';
import { describeStorageProviderContract } from '@opendrive/shared/storage/testing';
import { TelegramStorageProvider } from './telegram.js';
import type { TelegramStorageProviderOptions } from './telegram.js';
import {
  classifyApiError,
  TelegramApiError,
  TelegramHttpTransport,
  TelegramNotFoundError,
  TelegramPayloadTooLargeError,
  TelegramRateLimitedError,
  type TelegramFileInfo,
  type TelegramMe,
  type TelegramSendDocumentInput,
  type TelegramTransport,
  type TelegramUploadReceipt,
} from './telegram-transport.js';

async function drain(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

interface FakeFile {
  fileId: string;
  fileUniqueId: string;
  bytes: Uint8Array;
  filePath: string;
}

/**
 * In-memory stand-in for the Telegram Bot API, modelling what the live API was measured to
 * do: `deleteMessage` removes the message, but the file it carried stays resolvable and
 * downloadable afterwards. `messages` tracks live messages (so tests can assert staged
 * messages are released); `files` tracks bytes and outlives message deletion. The provider
 * must therefore rely on its own deletion tombstone, not a `getFile` probe, to report a
 * deleted object as gone.
 */
class FakeTelegramTransport implements TelegramTransport {
  /** Live messages, keyed by message id and pointing at a file id. */
  readonly messages = new Map<number, string>();
  /** Files, keyed by file id; retained even after their message is deleted, as Telegram does. */
  readonly files = new Map<string, FakeFile>();
  private nextMessageId = 1000;
  private nextFileId = 0;

  /**
   * Read-path fault injection. `transientDownloadFailures` makes that many downloads die
   * mid-body before succeeding (mirroring a dropped Telegram connection); `alwaysFailDownloads`
   * makes every read fail. `activeDownloads`/`maxConcurrentDownloads` observe how many reads the
   * provider keeps in flight, which is how the verify window is asserted.
   */
  transientDownloadFailures = 0;
  alwaysFailDownloads = false;
  failureAfterChunks = 1;
  activeDownloads = 0;
  maxConcurrentDownloads = 0;
  /**
   * `transientGetFileFailures` makes that many getFile calls fail with a retryable error before
   * succeeding (mirroring a Local Bot API server that is still finishing the file the client
   * just uploaded); `alwaysFailGetFile` makes every call fail. `getFileAttempts` counts every
   * call so a retry is observable.
   */
  transientGetFileFailures = 0;
  alwaysFailGetFile = false;
  getFileAttempts = 0;
  /**
   * Upload-path fault injection. `transientUploadFailures` makes that many sendDocument calls
   * fail with a retryable error before succeeding; `alwaysFailUploads` makes every call fail;
   * `payloadTooLarge` makes every call fail with a size refusal (which must NOT be retried).
   * `uploadAttempts` counts every sendDocument call, so a retry is observable.
   */
  transientUploadFailures = 0;
  alwaysFailUploads = false;
  payloadTooLarge = false;
  uploadAttempts = 0;
  /**
   * Every `download` call, in order, with the range it was asked for. Lets a test assert that a
   * partial read only fetched the parts it needed.
   */
  readonly downloadCalls: { filePath: string; range?: ByteRange }[] = [];

  async sendDocument(input: TelegramSendDocumentInput): Promise<TelegramUploadReceipt> {
    this.uploadAttempts += 1;
    if (this.alwaysFailUploads) {
      throw new TelegramApiError('simulated persistent upload failure', '', null, true);
    }
    if (this.transientUploadFailures > 0) {
      this.transientUploadFailures -= 1;
      throw new TelegramApiError('simulated transient upload failure', '', null, true);
    }
    if (this.payloadTooLarge) {
      throw new TelegramPayloadTooLargeError('Bad Request: file is too big', 400);
    }
    const messageId = this.nextMessageId;
    this.nextMessageId += 1;
    const fileId = `fake_file_${this.nextFileId}`;
    this.nextFileId += 1;
    const bytes =
      input.source instanceof Uint8Array ? input.source.slice() : await drain(input.source);
    const file: FakeFile = {
      fileId,
      fileUniqueId: `fake_unique_${fileId}`,
      bytes,
      filePath: `doc/fake/${fileId}.bin`,
    };
    this.files.set(fileId, file);
    this.messages.set(messageId, fileId);
    return {
      messageId,
      fileId,
      fileUniqueId: file.fileUniqueId,
      fileSize: bytes.byteLength,
    };
  }

  async getFile(fileId: string): Promise<TelegramFileInfo> {
    this.getFileAttempts += 1;
    if (this.alwaysFailGetFile) {
      throw new TelegramApiError('simulated persistent getFile failure', '', null, true);
    }
    if (this.transientGetFileFailures > 0) {
      this.transientGetFileFailures -= 1;
      throw new TelegramApiError('simulated transient getFile failure', '', null, true);
    }
    const file = this.files.get(fileId);
    if (file === undefined) {
      throw new TelegramNotFoundError(`getFile: file ${fileId} not found`, 400);
    }
    return {
      fileId,
      fileUniqueId: file.fileUniqueId,
      fileSize: file.bytes.byteLength,
      filePath: file.filePath,
    };
  }

  async download(filePath: string, range?: ByteRange): Promise<ByteStream> {
    this.downloadCalls.push(range === undefined ? { filePath } : { filePath, range });
    const file = [...this.files.values()].find((candidate) => candidate.filePath === filePath);
    if (file === undefined) {
      throw new TelegramNotFoundError(`download: path ${filePath} not found`, 404);
    }
    const bytes =
      range === undefined ? file.bytes : file.bytes.subarray(range.start, range.endInclusive + 1);
    const shouldFail = this.alwaysFailDownloads || this.transientDownloadFailures > 0;
    if (!this.alwaysFailDownloads && this.transientDownloadFailures > 0) {
      this.transientDownloadFailures -= 1;
    }
    const failureAfterChunks = this.failureAfterChunks;
    this.activeDownloads += 1;
    this.maxConcurrentDownloads = Math.max(this.maxConcurrentDownloads, this.activeDownloads);
    const release = (): void => {
      this.activeDownloads -= 1;
    };
    return (async function* generate(): ByteStream {
      try {
        const step = 4096;
        for (let offset = 0; offset < bytes.byteLength; offset += step) {
          if (shouldFail && offset >= step * failureAfterChunks) {
            // Mirrors the live failure mode: the response resolved, then the body died mid-stream.
            throw new TelegramApiError('simulated mid-body drop', '', null, true);
          }
          yield bytes.subarray(offset, Math.min(offset + step, bytes.byteLength));
        }
      } finally {
        release();
      }
    })();
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    // Removes the message only. The file stays resolvable, exactly as the live API behaves.
    return this.messages.delete(messageId);
  }

  async getMe(): Promise<TelegramMe> {
    return { id: 7, username: 'opendrive_fake_bot' };
  }
}

function uploadInput(sizeBytes: number, chunkSizeBytes = 1024, checksumSha256?: string) {
  return {
    uploadId: newId('upload'),
    fileId: newId('file'),
    filename: 'fixture.bin',
    sizeBytes,
    mimeType: 'application/octet-stream',
    chunkSizeBytes,
    ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
  };
}

describe('Telegram storage provider', () => {
  describeStorageProviderContract('telegram', () => {
    return new TelegramStorageProvider({ transport: new FakeTelegramTransport() });
  });

  it('releases the staged Telegram messages when an upload is aborted', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const session = await provider.initiateUpload(uploadInput(2048));
    const part = new Uint8Array(1024).fill(1);
    await provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 });
    await provider.uploadPart(session, { partNumber: 2, source: part, sizeBytes: 1024 });
    expect(transport.messages.size).toBe(2);
    await provider.abortUpload(session, 'client_cancelled');
    expect(transport.messages.size).toBe(0);
  });

  it('streams an object from its locator alone after a provider restart', async () => {
    const transport = new FakeTelegramTransport();
    const first = new TelegramStorageProvider({ transport });
    const payload = new Uint8Array(4096);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 3) % 256;
    const expected = await sha256HexOfBytes(payload);

    const session = await first.initiateUpload(uploadInput(payload.byteLength, 1024, expected));
    for (let partNumber = 1; partNumber <= 4; partNumber += 1) {
      await first.uploadPart(session, {
        partNumber,
        source: payload.subarray((partNumber - 1) * 1024, partNumber * 1024),
        sizeBytes: 1024,
      });
    }
    const stored = await first.finalizeUpload(session);

    // A fresh provider with no in-memory state (as after a restart) must still read the
    // object because the locator alone carries the Telegram ids.
    const restarted = new TelegramStorageProvider({ transport });
    const read = await restarted.openReadStream(stored.ref);
    expect(read.length).toBe(payload.byteLength);
    expect(read.range).toBeNull();
    expect(await sha256HexOfBytes(await drain(read.stream))).toBe(expected);
    const metadata = await restarted.getMetadata(stored.ref);
    expect(metadata.sizeBytes).toBe(payload.byteLength);
    expect(metadata.checksumSha256).toBe(expected);
  });

  it('serves a byte range spanning parts without fetching the parts outside it', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const partSize = 256;
    const payload = new Uint8Array(partSize * 4);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 7) % 251;

    const session = await provider.initiateUpload(uploadInput(payload.byteLength, partSize));
    for (let partNumber = 1; partNumber <= 4; partNumber += 1) {
      await provider.uploadPart(session, {
        partNumber,
        source: payload.subarray((partNumber - 1) * partSize, partNumber * partSize),
        sizeBytes: partSize,
      });
    }
    const stored = await provider.finalizeUpload(session);

    // Parts cover 0-255, 256-511, 512-767 and 768-1023; this window needs the first two only.
    transport.downloadCalls.length = 0;
    const range = { start: 200, endInclusive: 449 };
    const read = await provider.openReadStream(stored.ref, range);

    expect(read.length).toBe(250);
    expect(read.range).toEqual(range);
    const window = await drain(read.stream);
    expect(Buffer.from(window).equals(Buffer.from(payload.subarray(200, 450)))).toBe(true);

    // Only the two overlapping parts were fetched, and only for the bytes they contribute.
    expect(transport.downloadCalls).toHaveLength(2);
    expect(transport.downloadCalls[0]?.range).toEqual({ start: 200, endInclusive: 255 });
    expect(transport.downloadCalls[1]?.range).toEqual({ start: 0, endInclusive: 193 });
  });

  it('rejects a range outside the object with INVALID_REQUEST', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const payload = new Uint8Array(512).fill(3);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength));
    const stored = await provider.uploadWholeObject({
      session,
      source: (async function* generate(): ByteStream {
        yield payload;
      })(),
      sizeBytes: payload.byteLength,
    });

    await expect(
      provider.openReadStream(stored.ref, { start: 0, endInclusive: payload.byteLength }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      provider.openReadStream(stored.ref, { start: -1, endInclusive: 10 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      provider.openReadStream(stored.ref, { start: 20, endInclusive: 10 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('destroys a multipart object by deleting every staged message', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const session = await provider.initiateUpload(uploadInput(2048));
    const part = new Uint8Array(1024).fill(2);
    await provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 });
    await provider.uploadPart(session, { partNumber: 2, source: part, sizeBytes: 1024 });
    const stored = await provider.finalizeUpload(session);
    expect(transport.messages.size).toBe(2);

    const first = await provider.deleteObject(stored.ref);
    expect(first.deleted).toBe(true);
    expect(transport.messages.size).toBe(0);

    const second = await provider.deleteObject(stored.ref);
    expect(second.deleted).toBe(false);
    expect(second.alreadyAbsent).toBe(true);
    await expect(provider.getMetadata(stored.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports a deleted object as gone even though Telegram keeps the file resolvable', async () => {
    // Measured against the live Bot API: after deleteMessage the message disappears, but
    // getFile still answers and the bytes stay downloadable. Existence must therefore come
    // from the provider's own tombstone, not from probing Telegram.
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const payload = new Uint8Array(512).fill(7);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength));
    const stored = await provider.uploadWholeObject({
      session,
      source: (async function* generate(): ByteStream {
        yield payload;
      })(),
      sizeBytes: payload.byteLength,
    });
    const fileId = [...transport.files.keys()][0];
    expect(fileId).toBeDefined();

    await provider.deleteObject(stored.ref);

    expect(transport.messages.size).toBe(0);
    await expect(transport.getFile(fileId ?? '')).resolves.toBeDefined();
    await expect(provider.getMetadata(stored.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(provider.openReadStream(stored.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('retries a transient mid-body download failure while verifying the upload', async () => {
    const transport = new FakeTelegramTransport();
    // The first part read dies after one chunk, exactly as a dropped Telegram connection does.
    transport.transientDownloadFailures = 1;
    transport.failureAfterChunks = 1;
    const provider = new TelegramStorageProvider({ transport, readRetryDelayMs: 0 });
    const payload = new Uint8Array(16 * 1024);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = index % 251;
    const expected = await sha256HexOfBytes(payload);

    const session = await provider.initiateUpload(uploadInput(payload.byteLength, 8192, expected));
    for (let partNumber = 1; partNumber <= 2; partNumber += 1) {
      await provider.uploadPart(session, {
        partNumber,
        source: payload.subarray((partNumber - 1) * 8192, partNumber * 8192),
        sizeBytes: 8192,
      });
    }

    const stored = await provider.finalizeUpload(session);
    expect(stored.checksumSha256).toBe(expected);
  });

  it('retries a transient getFile failure for metadata and streamed reads', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport, readRetryDelayMs: 0 });
    const payload = new Uint8Array(16 * 1024);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = index % 251;
    const expected = await sha256HexOfBytes(payload);

    const session = await provider.initiateUpload(uploadInput(payload.byteLength));
    const stored = await provider.uploadWholeObject({
      session,
      source: (async function* generate(): ByteStream {
        yield payload;
      })(),
      sizeBytes: payload.byteLength,
    });

    // A freshly stored document can be locked server-side for a while; the first two getFile
    // probes fail transiently and the provider must recover on the next attempt.
    transport.transientGetFileFailures = 2;
    await expect(provider.getMetadata(stored.ref)).resolves.toMatchObject({
      sizeBytes: payload.byteLength,
      checksumSha256: expected,
    });
    expect(transport.getFileAttempts).toBeGreaterThan(1);

    transport.transientGetFileFailures = 2;
    const read = await provider.openReadStream(stored.ref);
    expect(await sha256HexOfBytes(await drain(read.stream))).toBe(expected);
    expect(transport.getFileAttempts).toBeGreaterThan(3);
  });

  it('surfaces STORAGE_UNAVAILABLE when getFile keeps failing transiently', async () => {
    const transport = new FakeTelegramTransport();
    // A short budget keeps the exhaustion loop fast while proving the failure is mapped.
    const provider = new TelegramStorageProvider({
      transport,
      readRetryDelayMs: 0,
      readRetryAttempts: 2,
    });
    const payload = new Uint8Array(1024).fill(9);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength));
    const stored = await provider.uploadWholeObject({
      session,
      source: (async function* generate(): ByteStream {
        yield payload;
      })(),
      sizeBytes: payload.byteLength,
    });

    transport.alwaysFailGetFile = true;
    await expect(provider.getMetadata(stored.ref)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    // openReadStream is lazy: the failure surfaces while the stream is consumed.
    const read = await provider.openReadStream(stored.ref);
    await expect(drain(read.stream)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('maps a persistent download failure to STORAGE_UNAVAILABLE instead of leaking it', async () => {
    const transport = new FakeTelegramTransport();
    transport.alwaysFailDownloads = true;
    transport.failureAfterChunks = 0;
    const provider = new TelegramStorageProvider({ transport, readRetryDelayMs: 0 });
    const session = await provider.initiateUpload(
      uploadInput(2048, 1024, await sha256HexOfBytes(new Uint8Array(2048).fill(3))),
    );
    const part = new Uint8Array(1024).fill(3);
    await provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 });
    await provider.uploadPart(session, { partNumber: 2, source: part, sizeBytes: 1024 });

    // The live failure arrived as a raw `TypeError: terminated`; it must surface classified.
    await expect(provider.finalizeUpload(session)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('maps a mid-body download failure while streaming to STORAGE_UNAVAILABLE', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const payload = new Uint8Array(8192).fill(9);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength, 8192));
    const stored = await provider.uploadWholeObject({
      session,
      source: (async function* generate(): ByteStream {
        yield payload;
      })(),
      sizeBytes: payload.byteLength,
    });

    transport.alwaysFailDownloads = true;
    transport.failureAfterChunks = 1;
    const read = await provider.openReadStream(stored.ref);
    await expect(drain(read.stream)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('verifies parts through a bounded concurrent window when a whole-object checksum is declared', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport, maxVerifyConcurrency: 3 });
    const partSize = 4096;
    const partCount = 8;
    const payload = new Uint8Array(partSize * partCount);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 7) % 256;
    const expected = await sha256HexOfBytes(payload);
    const session = await provider.initiateUpload(
      uploadInput(payload.byteLength, partSize, expected),
    );
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      await provider.uploadPart(session, {
        partNumber,
        source: payload.subarray((partNumber - 1) * partSize, partNumber * partSize),
        sizeBytes: partSize,
      });
    }

    await provider.finalizeUpload(session);
    // Reads overlap, but never more than the configured window.
    expect(transport.maxConcurrentDownloads).toBeGreaterThan(1);
    expect(transport.maxConcurrentDownloads).toBeLessThanOrEqual(3);
  });

  it('streams a whole-object upload through a spool and retries transient failures', async () => {
    const transport = new FakeTelegramTransport();
    // The first sendDocument call dies; the retry must re-read the spooled copy from byte zero.
    transport.transientUploadFailures = 1;
    const provider = new TelegramStorageProvider({ transport, uploadRetryDelayMs: 0 });
    const payload = new Uint8Array(64 * 1024);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 5) % 256;
    const expected = await sha256HexOfBytes(payload);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength));
    const stored = await provider.uploadWholeObject({
      session,
      source: (async function* generate(): ByteStream {
        const step = 4096;
        for (let offset = 0; offset < payload.byteLength; offset += step) {
          yield payload.subarray(offset, offset + step);
        }
      })(),
      sizeBytes: payload.byteLength,
    });
    expect(stored.checksumSha256).toBe(expected);
    expect(transport.uploadAttempts).toBe(2);
    const read = await provider.openReadStream(stored.ref);
    expect(await sha256HexOfBytes(await drain(read.stream))).toBe(expected);
  });

  it('retries a transient part-upload failure and still verifies', async () => {
    const transport = new FakeTelegramTransport();
    transport.transientUploadFailures = 1;
    const provider = new TelegramStorageProvider({ transport, uploadRetryDelayMs: 0 });
    const payload = new Uint8Array(2048);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 3) % 251;
    const expected = await sha256HexOfBytes(payload);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength, 1024, expected));
    const part = new Uint8Array(1024);
    part.set(payload.subarray(0, 1024));
    await provider.uploadPart(session, {
      partNumber: 1,
      source: part,
      sizeBytes: 1024,
    });
    // The first of two attempts failed; the retried send succeeded.
    expect(transport.uploadAttempts).toBe(2);
    part.set(payload.subarray(1024, 2048));
    await provider.uploadPart(session, {
      partNumber: 2,
      source: part,
      sizeBytes: 1024,
    });
    expect(transport.uploadAttempts).toBe(3);
    const stored = await provider.finalizeUpload(session);
    expect(stored.sizeBytes).toBe(payload.byteLength);
    expect(stored.checksumSha256).toBe(expected);
  });

  it('rejects a part whose declared checksum does not match its bytes, before sending it', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const session = await provider.initiateUpload(uploadInput(1024, 1024));
    await expect(
      provider.uploadPart(session, {
        partNumber: 1,
        source: new Uint8Array(1024).fill(4),
        sizeBytes: 1024,
        checksumSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
    // Nothing reached the chat, and no retry was spent on a definitive mismatch.
    expect(transport.uploadAttempts).toBe(0);
    expect(transport.messages.size).toBe(0);
  });

  it('does not read a whole object back when the client declared no checksum', async () => {
    // The browser never declares a whole-object checksum. Re-downloading a multi-gigabyte object
    // from Telegram at its read rate would outlast every client timeout, so finalize must commit
    // on size and per-part checks alone and record no checksum.
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const payload = new Uint8Array(2048).fill(6);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength, 1024));
    await provider.uploadPart(session, {
      partNumber: 1,
      source: payload.subarray(0, 1024),
      sizeBytes: 1024,
    });
    await provider.uploadPart(session, {
      partNumber: 2,
      source: payload.subarray(1024),
      sizeBytes: 1024,
    });

    transport.downloadCalls.length = 0;
    const stored = await provider.finalizeUpload(session);
    expect(stored.sizeBytes).toBe(payload.byteLength);
    expect(stored.checksumSha256).toBeNull();
    expect(transport.downloadCalls).toHaveLength(0);
    // The object is still readable byte-for-byte.
    const read = await provider.openReadStream(stored.ref);
    expect(await sha256HexOfBytes(await drain(read.stream))).toBe(await sha256HexOfBytes(payload));
  });

  it('does not retry a Telegram size refusal', async () => {
    const transport = new FakeTelegramTransport();
    transport.payloadTooLarge = true;
    const provider = new TelegramStorageProvider({ transport, uploadRetryDelayMs: 0 });
    const session = await provider.initiateUpload(uploadInput(2048));
    const part = new Uint8Array(1024).fill(1);
    await expect(
      provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(transport.uploadAttempts).toBe(1);
  });

  it('rejects a streamed whole-object checksum mismatch before sending anything', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const payload = new Uint8Array(1024).fill(7);
    const session = await provider.initiateUpload(uploadInput(payload.byteLength));
    await expect(
      provider.uploadWholeObject({
        session,
        source: (async function* generate(): ByteStream {
          yield payload;
        })(),
        sizeBytes: payload.byteLength,
        checksumSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
    expect(transport.messages.size).toBe(0);
  });

  it('fails a streamed whole-object whose declared size does not match its bytes', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport });
    const session = await provider.initiateUpload(uploadInput(2048));
    await expect(
      provider.uploadWholeObject({
        session,
        source: (async function* generate(): ByteStream {
          yield new Uint8Array(10).fill(3);
        })(),
        sizeBytes: 2048,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
    expect(transport.messages.size).toBe(0);
  });

  it('fails a streamed whole-object that exceeds its declared size without sending anything', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport, maxPartSizeBytes: 1024 });
    const session = await provider.initiateUpload(uploadInput(512));
    await expect(
      provider.uploadWholeObject({
        session,
        source: (async function* generate(): ByteStream {
          yield new Uint8Array(2048).fill(5);
        })(),
        sizeBytes: 512,
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(transport.messages.size).toBe(0);
  });

  describe('staged single-document delivery', () => {
    function stagedProvider(
      transport: FakeTelegramTransport,
      extra: Partial<TelegramStorageProviderOptions> = {},
    ): TelegramStorageProvider {
      return new TelegramStorageProvider({
        transport,
        stagePartsToSingleDocument: true,
        maxWholeObjectSizeBytes: 1024 * 1024,
        ...extra,
      });
    }

    it('keeps every part on local disk, then sends ONE document at finalize', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport);
      const payload = new Uint8Array(4096);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] = (index * 11) % 256;
      }
      const expected = await sha256HexOfBytes(payload);

      const session = await provider.initiateUpload(uploadInput(payload.byteLength, 1024));
      for (let partNumber = 1; partNumber <= 4; partNumber += 1) {
        await provider.uploadPart(session, {
          partNumber,
          source: payload.subarray((partNumber - 1) * 1024, partNumber * 1024),
          sizeBytes: 1024,
        });
      }

      // Nothing has reached Telegram: the parts are spool files, not messages.
      expect(transport.messages.size).toBe(0);
      expect(transport.uploadAttempts).toBe(0);

      const stored = await provider.finalizeUpload(session);

      // Exactly one document, one send, and the object reads back byte-for-byte.
      expect(transport.messages.size).toBe(1);
      expect(transport.uploadAttempts).toBe(1);
      expect(stored.checksumSha256).toBe(expected);
      const read = await provider.openReadStream(stored.ref);
      expect(read.length).toBe(payload.byteLength);
      expect(await sha256HexOfBytes(await drain(read.stream))).toBe(expected);
    });

    it('keeps the spool when the single send fails, so finalize can be retried', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport, { uploadRetryDelayMs: 0 });
      const payload = new Uint8Array(2048).fill(5);
      const session = await provider.initiateUpload(uploadInput(payload.byteLength, 1024));
      await provider.uploadPart(session, {
        partNumber: 1,
        source: payload.subarray(0, 1024),
        sizeBytes: 1024,
      });
      await provider.uploadPart(session, {
        partNumber: 2,
        source: payload.subarray(1024),
        sizeBytes: 1024,
      });

      transport.alwaysFailUploads = true;
      await expect(provider.finalizeUpload(session)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
      });
      expect(transport.messages.size).toBe(0);

      // The bytes stayed on disk: the retry succeeds without the client re-sending a byte.
      transport.alwaysFailUploads = false;
      const stored = await provider.finalizeUpload(session);
      expect(stored.checksumSha256).toBe(await sha256HexOfBytes(payload));
      expect(transport.messages.size).toBe(1);
      // Idempotent: a third finalize must not send a second document.
      await provider.finalizeUpload(session);
      expect(transport.messages.size).toBe(1);
    });

    it('sends parts as separate documents above the single-document ceiling', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport, { maxWholeObjectSizeBytes: 1024 });
      const session = await provider.initiateUpload(uploadInput(2048, 1024));
      const part = new Uint8Array(1024).fill(9);
      await provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 });
      await provider.uploadPart(session, { partNumber: 2, source: part, sizeBytes: 1024 });
      // Above the ceiling the provider keeps multipart delivery: one document per part.
      expect(transport.messages.size).toBe(2);
    });

    it('refuses a duplicate part before it overwrites the staged copy', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport);
      const session = await provider.initiateUpload(uploadInput(2048, 1024));
      const part = new Uint8Array(1024).fill(1);
      await provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 });
      await expect(
        provider.uploadPart(session, { partNumber: 1, source: part, sizeBytes: 1024 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(transport.messages.size).toBe(0);
    });

    it('rejects a staged part whose checksum does not match, before anything is sent', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport);
      const session = await provider.initiateUpload(uploadInput(1024, 1024));
      await expect(
        provider.uploadPart(session, {
          partNumber: 1,
          source: new Uint8Array(1024).fill(2),
          sizeBytes: 1024,
          checksumSha256: '0'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
      expect(transport.messages.size).toBe(0);
      expect(transport.uploadAttempts).toBe(0);
    });

    it('refuses to finalize a staged upload with a missing part', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport);
      const session = await provider.initiateUpload(uploadInput(2048, 1024));
      await provider.uploadPart(session, {
        partNumber: 1,
        source: new Uint8Array(1024).fill(1),
        sizeBytes: 1024,
      });
      await expect(provider.finalizeUpload(session)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(transport.messages.size).toBe(0);
    });

    it('releases the spool on abort without leaving a Telegram message', async () => {
      const transport = new FakeTelegramTransport();
      const provider = stagedProvider(transport);
      const session = await provider.initiateUpload(uploadInput(2048, 1024));
      await provider.uploadPart(session, {
        partNumber: 1,
        source: new Uint8Array(1024).fill(4),
        sizeBytes: 1024,
      });
      await provider.abortUpload(session, 'client_cancelled');
      expect(transport.messages.size).toBe(0);
      // A finalize after abort is refused rather than reading a vanished spool.
      await expect(provider.finalizeUpload(session)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });
});

describe('TelegramHttpTransport', () => {
  it('classifies a body failure that happens after the response has resolved', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4096).fill(1));
        controller.error(new TypeError('terminated'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    try {
      const transport = new TelegramHttpTransport({ botToken: 'test-token', chatId: 'test-chat' });
      const stream = await transport.download('doc/file.bin');
      const failure = await drain(stream).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TelegramApiError);
      expect((failure as TelegramApiError).retryable).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('streams a whole-object upload as multipart from a byte source without a File', async () => {
    const payload = new TextEncoder().encode('hello telegram upload');
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 11,
              document: { file_id: 'file_x', file_unique_id: 'u', file_size: payload.byteLength },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    try {
      const transport = new TelegramHttpTransport({ botToken: 'test-token', chatId: 'test-chat' });
      const receipt = await transport.sendDocument({
        filename: 'stream.bin',
        mimeType: 'application/octet-stream',
        source: (async function* generate(): ByteStream {
          yield payload;
        })(),
        sizeBytes: payload.byteLength,
        caption: 'part 1',
      });
      expect(receipt.fileId).toBe('file_x');
      expect(seen).toHaveLength(1);
      const call = seen[0];
      if (call === undefined) throw new Error('fetch was not called');
      const init = call.init;
      expect(init.method).toBe('POST');
      expect(call.url).toContain('/bottest-token/sendDocument');
      const duplex = (init as RequestInit & { duplex?: string }).duplex;
      expect(duplex).toBe('half');
      const contentType = (init.headers as Record<string, string>)['Content-Type'];
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      const body = init.body as ReadableStream<Uint8Array>;
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) chunks.push(value);
      }
      const text = new TextDecoder().decode(mergeBytes(chunks));
      expect(text).toContain('name="chat_id"');
      expect(text).toContain('test-chat');
      expect(text).toContain('name="document"; filename="stream.bin"');
      expect(text).toContain(new TextDecoder().decode(payload));
      expect(text).toContain('name="caption"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the standard file URL for a relative getFile path', async () => {
    let requestedUrl: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        requestedUrl = String(url);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );
    try {
      const transport = new TelegramHttpTransport({ botToken: 'test-token', chatId: 'test-chat' });
      const stream = await transport.download('doc/file.bin');
      await drain(stream);
      expect(requestedUrl).toBe('https://api.telegram.org/file/bottest-token/doc/file.bin');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads an absolute local path from disk when the server runs with --local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-download-test-'));
    const filePath = join(dir, 'file.bin');
    const payload = new Uint8Array(8192);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = index % 251;
    writeFileSync(filePath, payload);
    try {
      const transport = new TelegramHttpTransport({ botToken: 'test-token', chatId: 'test-chat' });
      const stream = await transport.download(filePath);
      expect(await drain(stream)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves an absolute local path through the configured file server', async () => {
    const payload = new TextEncoder().encode('served');
    let requestedUrl: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        requestedUrl = String(url);
        return new Response(payload, { status: 200 });
      }),
    );
    try {
      const transport = new TelegramHttpTransport({
        botToken: 'test-token',
        chatId: 'test-chat',
        filesBaseUrl: 'https://files.example/telegram',
        workDir: '/var/lib/telegram-bot-api',
      });
      const stream = await transport.download('/var/lib/telegram-bot-api/123/document/file_2.bin');
      expect(await drain(stream)).toEqual(payload);
      expect(requestedUrl).toBe('https://files.example/telegram/123/document/file_2.bin');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to rewrite an absolute path without a work dir when a file server is set', async () => {
    const transport = new TelegramHttpTransport({
      botToken: 'test-token',
      chatId: 'test-chat',
      filesBaseUrl: 'https://files.example',
    });
    await expect(
      transport.download('/var/lib/telegram-bot-api/123/document/file_2.bin'),
    ).rejects.toMatchObject({ name: 'TelegramApiError', retryable: false });
  });
});

/** Concatenates Uint8Array chunks (for draining a captured request body). */
function mergeBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

describe('classifyApiError', () => {
  it('classifies not-found, oversized, rate-limited and generic errors', () => {
    expect(classifyApiError('Bad Request: file to download not found', 400)).toBeInstanceOf(
      TelegramNotFoundError,
    );
    expect(classifyApiError('Bad Request: file is too big', 400)).toBeInstanceOf(
      TelegramPayloadTooLargeError,
    );
    expect(classifyApiError('Too Many Requests: retry after 10 seconds', 429)).toBeInstanceOf(
      TelegramRateLimitedError,
    );
    const generic = classifyApiError('Bad Request: there is no caption in the message', 400);
    expect(generic).not.toBeInstanceOf(TelegramNotFoundError);
    expect(generic.retryable).toBe(false);
    expect(classifyApiError('Internal Server Error', 500).retryable).toBe(true);
  });
});
