import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { sha256HexOfBytes } from '../../tokens.js';
import type { InitiateUploadInput, StorageProvider, UploadSession, ByteStream } from '../types.js';

/**
 * Provider contract suite.
 *
 * Every storage provider — the in-memory test double today, Telegram and any other
 * real backend later — must pass this suite unchanged. It asserts the invariants the
 * rest of the platform relies on, and that a provider's declared capability flags
 * match its actual behaviour. A provider that fails here must not be enabled.
 */

export interface StorageContractOptions {
  /** Number of parts used for multipart tests. Defaults to 3. */
  partCount?: number;
  /**
   * Chunk size requested for the multipart fixture. Defaults to the smallest value the
   * provider accepts (its declared minimum, floored at 1 KiB) so contract runs stay light.
   */
  partSizeBytes?: number;
}

/** Picks a chunk size the provider must honour rather than clamp. */
function choosePartSize(provider: StorageProvider, options: StorageContractOptions): number {
  if (options.partSizeBytes !== undefined) return options.partSizeBytes;
  const minimum = provider.capabilities.minPartSizeBytes ?? 1024;
  const maximum = provider.capabilities.maxPartSizeBytes ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(1024, minimum), maximum);
}

function streamOf(bytes: Uint8Array): ByteStream {
  return (async function* generate() {
    yield bytes;
  })();
}

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

function uploadInput(
  sizeBytes: number,
  checksumSha256?: string | null,
  chunkSizeBytes = 1024,
): InitiateUploadInput {
  return {
    uploadId: newId('upload'),
    fileId: newId('file'),
    filename: 'contract-fixture.bin',
    sizeBytes,
    mimeType: 'application/octet-stream',
    chunkSizeBytes,
    ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`Expected the call to fail with ${code}, but it resolved.`);
}

export function describeStorageProviderContract(
  name: string,
  createProvider: () => StorageProvider,
  options: StorageContractOptions = {},
): void {
  // The factory must be synchronous: which tests exist is decided at collection time from
  // the provider's declared capabilities, before any beforeEach hook has run.
  const capabilities = createProvider().capabilities;

  describe(`${name} — storage provider contract`, () => {
    // Fresh instance per test so state cannot leak between cases.
    let provider!: StorageProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('publishes a complete capability and durability description', () => {
      expect(provider.providerId).toBeTruthy();
      expect(provider.displayName).toBeTruthy();
      expect(typeof provider.experimental).toBe('boolean');
      expect(provider.durabilityNotes.length).toBeGreaterThan(10);
      for (const [key, value] of Object.entries(provider.capabilities)) {
        if (key.startsWith('max') || key.startsWith('min')) {
          expect(value === null || typeof value === 'number').toBe(true);
        } else {
          expect(typeof value, `capability ${key} must be a boolean`).toBe('boolean');
        }
      }
    });

    it('reports health without side effects', async () => {
      const health = await provider.health();
      expect(['ok', 'degraded', 'unavailable']).toContain(health.status);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
      expect(health.detail.length).toBeGreaterThan(0);
    });

    it('rejects an upload for an unknown session', async () => {
      const unknown: UploadSession = {
        uploadId: newId('upload'),
        fileId: newId('file'),
        providerId: provider.providerId,
        state: 'initiated',
        partSizeBytes: 1024,
        expectedParts: null,
        providerSessionRef: null,
        expiresAt: null,
      };
      await expectAppError(provider.finalizeUpload(unknown), 'NOT_FOUND');
    });

    if (capabilities.multipartUpload) {
      it('stores an object uploaded as multiple parts and reads it back byte-for-byte', async () => {
        const partSize = choosePartSize(provider, options);
        const partCount = options.partCount ?? 3;
        const payload = new Uint8Array(partSize * partCount);
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] = (index * 7) % 251;
        }
        const expectedChecksum = await sha256HexOfBytes(payload);
        const session = await provider.initiateUpload(
          uploadInput(payload.byteLength, expectedChecksum, partSize),
        );
        expect(session.providerId).toBe(provider.providerId);
        // The caller must use the part size the provider reports, not the one it requested.
        expect(session.partSizeBytes).toBe(partSize);

        for (let offset = 0; offset < partCount; offset += 1) {
          // Parts are delivered out of order on purpose: providers must not depend on sequence.
          const partNumber = partCount - offset;
          const sliceForPart = payload.subarray((partNumber - 1) * partSize, partNumber * partSize);
          expect(sliceForPart.byteLength).toBe(partSize);
          const result = await provider.uploadPart(session, {
            partNumber,
            source: streamOf(sliceForPart),
            sizeBytes: sliceForPart.byteLength,
            checksumSha256: await sha256HexOfBytes(sliceForPart),
          });
          expect(result.partNumber).toBe(partNumber);
          expect(result.receivedBytes).toBe(partSize);
        }

        const stored = await provider.finalizeUpload(session);
        expect(stored.sizeBytes).toBe(payload.byteLength);
        expect(stored.checksumSha256).toBe(expectedChecksum);
        expect(stored.ref.providerId).toBe(provider.providerId);

        const read = await provider.openReadStream(stored.ref);
        expect(read.length).toBe(payload.byteLength);
        expect(read.range).toBeNull();
        const roundTripped = await drain(read.stream);
        expect(roundTripped.byteLength).toBe(payload.byteLength);
        expect(await sha256HexOfBytes(roundTripped)).toBe(expectedChecksum);

        const metadata = await provider.getMetadata(stored.ref);
        expect(metadata.sizeBytes).toBe(payload.byteLength);
        expect(metadata.checksumSha256).toBe(expectedChecksum);
      });

      it('is idempotent when finalize is retried', async () => {
        const payload = new Uint8Array(1024).fill(9);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        await provider.uploadPart(session, {
          partNumber: 1,
          source: payload,
          sizeBytes: payload.byteLength,
        });
        const first = await provider.finalizeUpload(session);
        const second = await provider.finalizeUpload(session);
        expect(second.ref.locator).toBe(first.ref.locator);
        expect(second.checksumSha256).toBe(first.checksumSha256);
        const usage = provider.describeUsage === undefined ? null : await provider.describeUsage();
        if (usage !== null) expect(usage.objectCount).toBe(1);
      });

      it('refuses a duplicate part number instead of silently overwriting', async () => {
        const payload = new Uint8Array(1024).fill(3);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        await provider.uploadPart(session, {
          partNumber: 1,
          source: payload,
          sizeBytes: payload.byteLength,
        });
        await expectAppError(
          provider.uploadPart(session, {
            partNumber: 1,
            source: payload,
            sizeBytes: payload.byteLength,
          }),
          'CONFLICT',
        );
      });

      it('refuses a part whose declared size does not match the delivered bytes', async () => {
        const session = await provider.initiateUpload(uploadInput(2048));
        await expectAppError(
          provider.uploadPart(session, {
            partNumber: 1,
            source: new Uint8Array(10),
            sizeBytes: 2048,
          }),
          'INTEGRITY_CHECK_FAILED',
        );
      });

      it('rejects a whole-object checksum mismatch and stores nothing', async () => {
        const payload = new Uint8Array(1024).fill(1);
        const wrongChecksum = '0'.repeat(64);
        const session = await provider.initiateUpload(
          uploadInput(payload.byteLength, wrongChecksum),
        );
        await provider.uploadPart(session, {
          partNumber: 1,
          source: payload,
          sizeBytes: payload.byteLength,
        });
        await expectAppError(provider.finalizeUpload(session), 'INTEGRITY_CHECK_FAILED');
        const usage = provider.describeUsage === undefined ? null : await provider.describeUsage();
        if (usage !== null) expect(usage.objectCount).toBe(0);
      });

      it('releases staged bytes when an upload is aborted, and is idempotent', async () => {
        const payload = new Uint8Array(1024).fill(4);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        await provider.uploadPart(session, {
          partNumber: 1,
          source: payload,
          sizeBytes: payload.byteLength,
        });
        const before = provider.describeUsage === undefined ? null : await provider.describeUsage();
        await provider.abortUpload(session, 'client_cancelled');
        await provider.abortUpload(session, 'client_cancelled'); // must not throw
        const after = provider.describeUsage === undefined ? null : await provider.describeUsage();
        if (before !== null && after !== null) {
          expect(after.objectCount).toBe(before.objectCount);
        }
        await expectAppError(provider.finalizeUpload(session), 'CONFLICT');
      });

      it('refuses to abort a finalized upload', async () => {
        const payload = new Uint8Array(1024).fill(5);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        await provider.uploadPart(session, {
          partNumber: 1,
          source: payload,
          sizeBytes: payload.byteLength,
        });
        await provider.finalizeUpload(session);
        await expectAppError(provider.abortUpload(session, 'client_cancelled'), 'CONFLICT');
      });
    } else {
      it('refuses part uploads when multipartUpload is not declared', async () => {
        const session = await provider.initiateUpload(uploadInput(1024));
        await expectAppError(
          provider.uploadPart(session, {
            partNumber: 1,
            source: new Uint8Array(1024),
            sizeBytes: 1024,
          }),
          'STORAGE_CAPABILITY_UNSUPPORTED',
        );
      });
    }

    if (capabilities.singleShotUpload) {
      it('stores an object delivered as a single stream', async () => {
        const payload = new Uint8Array(2048).fill(7);
        const checksum = await sha256HexOfBytes(payload);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength, checksum));
        const stored = await provider.uploadWholeObject({
          session,
          source: streamOf(payload),
          sizeBytes: payload.byteLength,
          checksumSha256: checksum,
        });
        expect(stored.sizeBytes).toBe(payload.byteLength);
        const read = await provider.openReadStream(stored.ref);
        expect(await sha256HexOfBytes(await drain(read.stream))).toBe(checksum);
      });

      it('refuses to mix single-object and multipart delivery in one session', async () => {
        if (!capabilities.multipartUpload) return;
        const payload = new Uint8Array(2048).fill(8);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength, null, 2048));
        await provider.uploadPart(session, {
          partNumber: 1,
          source: payload,
          sizeBytes: payload.byteLength,
        });
        await expectAppError(
          provider.uploadWholeObject({
            session,
            source: streamOf(new Uint8Array(payload.byteLength)),
            sizeBytes: payload.byteLength,
          }),
          'CONFLICT',
        );
      });
    } else {
      it('refuses whole-object upload when singleShotUpload is not declared', async () => {
        const payload = new Uint8Array(64);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        await expectAppError(
          provider.uploadWholeObject({
            session,
            source: streamOf(payload),
            sizeBytes: payload.byteLength,
          }),
          'STORAGE_CAPABILITY_UNSUPPORTED',
        );
      });
    }

    if (capabilities.rangedRead) {
      it('serves a byte range without reading the whole object', async () => {
        const payload = new Uint8Array(1024);
        for (let index = 0; index < payload.byteLength; index += 1) payload[index] = index % 256;
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        const stored = await provider.uploadWholeObject({
          session,
          source: streamOf(payload),
          sizeBytes: payload.byteLength,
        });
        const range = { start: 100, endInclusive: 199 };
        const read = await provider.openReadStream(stored.ref, range);
        expect(read.length).toBe(100);
        expect(read.range).toEqual(range);
        const window = await drain(read.stream);
        expect(window.byteLength).toBe(100);
        expect(window[0]).toBe(payload[100]);
        expect(window[99]).toBe(payload[199]);
        await expectAppError(
          provider.openReadStream(stored.ref, { start: 0, endInclusive: payload.byteLength }),
          'INVALID_REQUEST',
        );
      });
    } else {
      it('refuses range reads when rangedRead is not declared', async () => {
        const payload = new Uint8Array(256).fill(2);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        const stored = await provider.uploadWholeObject({
          session,
          source: streamOf(payload),
          sizeBytes: payload.byteLength,
        });
        await expectAppError(
          provider.openReadStream(stored.ref, { start: 0, endInclusive: 10 }),
          'STORAGE_CAPABILITY_UNSUPPORTED',
        );
      });
    }

    if (capabilities.directDownloadUrl) {
      it('issues a download URL that expires', async () => {
        expect(typeof provider.getDownloadUrl).toBe('function');
        const payload = new Uint8Array(128).fill(1);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        const stored = await provider.uploadWholeObject({
          session,
          source: streamOf(payload),
          sizeBytes: payload.byteLength,
        });
        const url = await provider.getDownloadUrl?.(stored.ref, 60);
        expect(url?.url).toBeTruthy();
        expect(Number.isNaN(Date.parse(url?.expiresAt ?? ''))).toBe(false);
      });
    } else {
      it('refuses direct download URLs when directDownloadUrl is not declared', async () => {
        if (typeof provider.getDownloadUrl !== 'function') return; // method not implemented at all
        const payload = new Uint8Array(64).fill(1);
        const session = await provider.initiateUpload(uploadInput(payload.byteLength));
        const stored = await provider.uploadWholeObject({
          session,
          source: streamOf(payload),
          sizeBytes: payload.byteLength,
        });
        await expectAppError(
          provider.getDownloadUrl?.(stored.ref, 60) ?? Promise.resolve(),
          'STORAGE_CAPABILITY_UNSUPPORTED',
        );
      });
    }

    it('deletes idempotently and reports whether bytes were removed', async () => {
      const payload = new Uint8Array(512).fill(6);
      const session = await provider.initiateUpload(uploadInput(payload.byteLength));
      const stored = await provider.uploadWholeObject({
        session,
        source: streamOf(payload),
        sizeBytes: payload.byteLength,
      });
      const first = await provider.deleteObject(stored.ref);
      expect(first.deleted).toBe(true);
      expect(first.alreadyAbsent).toBe(false);
      const second = await provider.deleteObject(stored.ref);
      expect(second.deleted).toBe(false);
      expect(second.alreadyAbsent).toBe(true);
      await expectAppError(provider.getMetadata(stored.ref), 'NOT_FOUND');
    });

    it('enforces the declared per-object ceiling', async () => {
      const limit = provider.capabilities.maxObjectSizeBytes;
      if (limit === null) return; // provider documents no ceiling: nothing to assert
      await expectAppError(provider.initiateUpload(uploadInput(limit + 1)), 'PAYLOAD_TOO_LARGE');
    });
  });
}
