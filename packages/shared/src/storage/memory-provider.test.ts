import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { ByteStream } from './types.js';
import { MemoryStorageProvider } from './testing/memory-provider.js';
import { describeStorageProviderContract } from './testing/storage-contract.js';

/** Whole-object uploads take a stream, never a buffer, so large files cannot be silently materialised. */
function streamOf(bytes: Uint8Array): ByteStream {
  return (async function* generate() {
    yield bytes;
  })();
}

describeStorageProviderContract('MemoryStorageProvider', () => new MemoryStorageProvider());

describe('MemoryStorageProvider specifics', () => {
  it('refuses an object larger than its configured ceiling', async () => {
    const provider = new MemoryStorageProvider({ maxObjectSizeBytes: 1024 });
    await expect(
      provider.initiateUpload({
        uploadId: 'upl_0123456789012345678901234a',
        fileId: 'file_0123456789012345678901234a',
        filename: 'big.bin',
        sizeBytes: 1025,
        mimeType: 'application/octet-stream',
        chunkSizeBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses writes once the in-memory capacity is exhausted', async () => {
    // Capacity is a hard ceiling for staged + stored bytes; the second write must not fit.
    const provider = new MemoryStorageProvider({ capacityBytes: 1536, partSizeBytes: 1024 });
    const payload = new Uint8Array(1024).fill(1);
    const session = await provider.initiateUpload({
      uploadId: 'upl_0123456789012345678901234a',
      fileId: 'file_0123456789012345678901234a',
      filename: 'a.bin',
      sizeBytes: payload.byteLength,
      mimeType: 'application/octet-stream',
      chunkSizeBytes: 1024,
    });
    await provider.uploadWholeObject({
      session,
      source: streamOf(payload),
      sizeBytes: payload.byteLength,
    });
    const second = await provider.initiateUpload({
      uploadId: 'upl_0123456789012345678901234b',
      fileId: 'file_0123456789012345678901234b',
      filename: 'b.bin',
      sizeBytes: payload.byteLength,
      mimeType: 'application/octet-stream',
      chunkSizeBytes: 1024,
    });
    await expect(
      provider.uploadWholeObject({
        session: second,
        source: streamOf(payload),
        sizeBytes: payload.byteLength,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('marks itself experimental, non-durable and non-permanent', () => {
    const provider = new MemoryStorageProvider();
    expect(provider.experimental).toBe(true);
    expect(provider.capabilities.permanentRetention).toBe(false);
    expect(provider.capabilities.guaranteedDurability).toBe(false);
    expect(provider.capabilities.resumableUpload).toBe(false);
    expect(provider.capabilities.directDownloadUrl).toBe(false);
    expect(provider.durabilityNotes).toMatch(/test double/i);
  });

  it('expires an abandoned upload session instead of accepting late parts', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const provider = new MemoryStorageProvider({ now: () => now });
    const session = await provider.initiateUpload({
      uploadId: 'upl_0123456789012345678901234a',
      fileId: 'file_0123456789012345678901234a',
      filename: 'a.bin',
      sizeBytes: 1024,
      mimeType: 'application/octet-stream',
      chunkSizeBytes: 1024,
      sessionTtlSeconds: 60,
    });
    now = new Date('2026-01-01T00:02:00.000Z');
    await expect(
      provider.uploadPart(session, {
        partNumber: 1,
        source: new Uint8Array(1024),
        sizeBytes: 1024,
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.code === 'CONFLICT');
  });

  it('accepts capability overrides so capability-failure paths can be tested', async () => {
    const provider = new MemoryStorageProvider({ capabilities: { multipartUpload: false } });
    await expect(
      provider.uploadPart(
        {
          uploadId: 'upl_0123456789012345678901234a',
          fileId: 'file_0123456789012345678901234a',
          providerId: provider.providerId,
          state: 'initiated',
          partSizeBytes: 1024,
          expectedParts: 1,
          providerSessionRef: null,
          expiresAt: null,
        },
        { partNumber: 1, source: new Uint8Array(10), sizeBytes: 10 },
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_CAPABILITY_UNSUPPORTED' });
  });
});
