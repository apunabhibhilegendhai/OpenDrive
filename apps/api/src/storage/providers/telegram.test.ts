import { describe, expect, it, vi } from 'vitest';
import { newId, sha256HexOfBytes } from '@opendrive/shared';
import type { ByteStream } from '@opendrive/shared';
import { describeStorageProviderContract } from '@opendrive/shared/storage/testing';
import { TelegramStorageProvider } from './telegram.js';
import {
  classifyApiError,
  TelegramApiError,
  TelegramHttpTransport,
  TelegramNotFoundError,
  TelegramPayloadTooLargeError,
  TelegramRateLimitedError,
  type TelegramFileInfo,
  type TelegramMe,
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

  async sendDocument(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    caption?: string;
  }): Promise<TelegramUploadReceipt> {
    const messageId = this.nextMessageId;
    this.nextMessageId += 1;
    const fileId = `fake_file_${this.nextFileId}`;
    this.nextFileId += 1;
    const file: FakeFile = {
      fileId,
      fileUniqueId: `fake_unique_${fileId}`,
      bytes: input.bytes.slice(),
      filePath: `doc/fake/${fileId}.bin`,
    };
    this.files.set(fileId, file);
    this.messages.set(messageId, fileId);
    return {
      messageId,
      fileId,
      fileUniqueId: file.fileUniqueId,
      fileSize: input.bytes.byteLength,
    };
  }

  async getFile(fileId: string): Promise<TelegramFileInfo> {
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

  async download(filePath: string): Promise<ByteStream> {
    const file = [...this.files.values()].find((candidate) => candidate.filePath === filePath);
    if (file === undefined) {
      throw new TelegramNotFoundError(`download: path ${filePath} not found`, 404);
    }
    const bytes = file.bytes;
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

function uploadInput(sizeBytes: number, chunkSizeBytes = 1024) {
  return {
    uploadId: newId('upload'),
    fileId: newId('file'),
    filename: 'fixture.bin',
    sizeBytes,
    mimeType: 'application/octet-stream',
    chunkSizeBytes,
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

    const session = await first.initiateUpload(uploadInput(payload.byteLength));
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

    const session = await provider.initiateUpload(uploadInput(payload.byteLength, 8192));
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

  it('maps a persistent download failure to STORAGE_UNAVAILABLE instead of leaking it', async () => {
    const transport = new FakeTelegramTransport();
    transport.alwaysFailDownloads = true;
    transport.failureAfterChunks = 0;
    const provider = new TelegramStorageProvider({ transport, readRetryDelayMs: 0 });
    const session = await provider.initiateUpload(uploadInput(2048));
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

  it('verifies parts through a bounded concurrent window', async () => {
    const transport = new FakeTelegramTransport();
    const provider = new TelegramStorageProvider({ transport, maxVerifyConcurrency: 3 });
    const partSize = 4096;
    const partCount = 8;
    const payload = new Uint8Array(partSize * partCount);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 7) % 256;
    const session = await provider.initiateUpload(uploadInput(payload.byteLength, partSize));
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
});

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
