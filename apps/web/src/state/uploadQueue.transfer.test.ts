import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../lib/api/client.js';
import { ApiError } from '../lib/api/errors.js';
import {
  MAX_IN_FLIGHT_BYTES,
  PART_RETRY_ATTEMPTS,
  concurrencyForParts,
  transferParts,
  type UploadPartToSend,
} from './uploadQueue.js';

/**
 * The part-transfer loop.
 *
 * These are the two behaviours that used to be wrong, and both are the kind of wrong that only
 * shows up on a big file: a part whose retries were spent was never actually re-sent (the round
 * "resumed" into a round where every part was still marked claimed, so nothing was sent and the
 * object was finalized with a hole in it), and the byte count reported mid-flight was assigned
 * from whichever part spoke last instead of summed, so it stepped backwards.
 *
 * The delays are injected as zero here, which is the only reason this can be a unit test rather
 * than a forty-second one.
 */

const UPLOAD_ID = `upl_${'1'.repeat(26)}`;
const FILE_ID = `file_${'3'.repeat(26)}`;
const signal = new AbortController().signal;

function part(partNumber: number, sizeBytes: number): UploadPartToSend {
  return {
    partNumber,
    sizeBytes,
    blob: new Blob([new Uint8Array(sizeBytes)]),
    checksum: undefined,
  };
}

function apiError(status: number, code: string): ApiError {
  return new ApiError({ status, code, detail: 'failure' });
}

interface ScriptedApi {
  api: ApiClient;
  /** Attempts made per part number. */
  attempts: number[];
  statusCalls: { count: number };
}

/** An API whose part route answers from `uploadPart`, and whose status route counts its calls. */
function scriptedApi(options: {
  uploadPart: (partNumber: number, attempt: number) => 'ok' | Error;
  /** The parts the server reports it holds, which is what a round resumes from. */
  partsReceived?: number[];
}): ScriptedApi {
  const attempts: number[] = [];
  const statusCalls = { count: 0 };
  const api = {
    async uploadPart(input: { partNumber: number }) {
      const attempt = (attempts[input.partNumber] ?? 0) + 1;
      attempts[input.partNumber] = attempt;
      const outcome = options.uploadPart(input.partNumber, attempt);
      if (outcome !== 'ok') throw outcome;
      return { partNumber: input.partNumber, receivedBytes: 1 };
    },
    async uploadStatus() {
      statusCalls.count += 1;
      return {
        uploadId: UPLOAD_ID,
        fileId: FILE_ID,
        state: 'in_progress' as const,
        chunkSizeBytes: 1024,
        expectedParts: null,
        partsReceived: options.partsReceived ?? [],
        expiresAt: '2026-10-13T00:00:00.000Z',
      };
    },
  } as unknown as ApiClient;
  return { api, attempts, statusCalls };
}

describe('transferParts — retry rounds', () => {
  it('re-sends a part in the next round instead of finalizing with a hole in the object', async () => {
    // Every attempt of part 1 fails, so its retries are spent; it must then be sent again in the
    // following round rather than silently skipped.
    const { api, attempts, statusCalls } = scriptedApi({
      uploadPart: (_partNumber, attempt) =>
        attempt <= PART_RETRY_ATTEMPTS ? apiError(503, 'STORAGE_UNAVAILABLE') : 'ok',
    });

    const confirmed = await transferParts({
      api,
      uploadId: UPLOAD_ID,
      parts: [part(1, 10)],
      signal,
      retryBaseDelayMs: 0,
    });

    expect(confirmed).toBe(10);
    expect(attempts[1]).toBe(PART_RETRY_ATTEMPTS + 1);
    // The round resumes from the server's own progress, so it asks what the server holds.
    expect(statusCalls.count).toBe(1);
  });

  it('resumes from the parts the server names, not from a count of them', async () => {
    // Parts 2 and 3 land first and part 1 fails every attempt it is given. The server reports the
    // parts it actually holds — `[2, 3]` — so part 1 is the one that must be sent again. Reading
    // that list as "the first two parts" (the shape this used to be, a bare count) would conclude
    // part 1 was stored and finalize an object with a hole in it.
    const { api, attempts, statusCalls } = scriptedApi({
      uploadPart: (partNumber, attempt) =>
        partNumber !== 1 || attempt > PART_RETRY_ATTEMPTS
          ? 'ok'
          : apiError(502, 'STORAGE_UNAVAILABLE'),
      partsReceived: [2, 3],
    });

    const confirmed = await transferParts({
      api,
      uploadId: UPLOAD_ID,
      parts: [part(1, 10), part(2, 10), part(3, 10)],
      signal,
      concurrency: 3,
      retryBaseDelayMs: 0,
    });

    expect(confirmed).toBe(30);
    expect(statusCalls.count).toBe(1);
    expect(attempts[1]).toBe(PART_RETRY_ATTEMPTS + 1);
    // The parts the server said it held are not sent again: the provider refuses a duplicate.
    expect(attempts[2]).toBe(1);
    expect(attempts[3]).toBe(1);
  });

  it('stops once the rounds are spent rather than retrying forever', async () => {
    const { api, attempts } = scriptedApi({
      uploadPart: () => apiError(503, 'STORAGE_UNAVAILABLE'),
    });

    await expect(
      transferParts({
        api,
        uploadId: UPLOAD_ID,
        parts: [part(1, 10)],
        signal,
        retryBaseDelayMs: 0,
        maxRounds: 2,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(attempts[1]).toBe(PART_RETRY_ATTEMPTS * 2);
  });

  it('does not spend another round on a definitive refusal', async () => {
    const { api, attempts, statusCalls } = scriptedApi({
      uploadPart: () => apiError(413, 'PAYLOAD_TOO_LARGE'),
    });

    await expect(
      transferParts({
        api,
        uploadId: UPLOAD_ID,
        parts: [part(1, 10)],
        signal,
        retryBaseDelayMs: 0,
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(attempts[1]).toBe(1);
    expect(statusCalls.count).toBe(0);
  });
});

describe('transferParts — part size and checksums', () => {
  it('lowers concurrency so the bytes in flight stay inside the budget', () => {
    expect(MAX_IN_FLIGHT_BYTES).toBe(32 * 1024 * 1024);
    // One 32 MiB part fills the budget, four 8 MiB parts fit, small parts use the whole cap.
    expect(concurrencyForParts([{ sizeBytes: 32 * 1024 * 1024 }])).toBe(1);
    expect(concurrencyForParts([{ sizeBytes: 8 * 1024 * 1024 }])).toBe(4);
    expect(concurrencyForParts([{ sizeBytes: 1024 }])).toBe(6);
    // The caller's cap still wins when it is lower.
    expect(concurrencyForParts([{ sizeBytes: 1024 }], 2)).toBe(2);
  });

  it('hashes a part only when it is sent, once, and never two at a time', async () => {
    const computed: number[] = [];
    let activeHashes = 0;
    let maxActiveHashes = 0;
    const seen = new Map<number, string | undefined>();
    const api = {
      async uploadPart(input: { partNumber: number; checksumSha256?: string }) {
        seen.set(input.partNumber, input.checksumSha256);
        return { partNumber: input.partNumber, receivedBytes: 10 };
      },
    } as unknown as ApiClient;

    const parts: UploadPartToSend[] = [1, 2, 3].map((partNumber) => ({
      partNumber,
      sizeBytes: 10,
      blob: new Blob([new Uint8Array(10)]),
      async checksum() {
        activeHashes += 1;
        maxActiveHashes = Math.max(maxActiveHashes, activeHashes);
        await new Promise((resolve) => setTimeout(resolve, 1));
        computed.push(partNumber);
        activeHashes -= 1;
        return `sum-${partNumber}`;
      },
    }));

    await transferParts({
      api,
      uploadId: UPLOAD_ID,
      parts,
      signal,
      concurrency: 3,
      retryBaseDelayMs: 0,
    });

    expect(computed.sort((left, right) => left - right)).toEqual([1, 2, 3]);
    // Three parts were allowed to send at once, but only one was ever hashed at a time: hashing
    // several parts in parallel is what held a whole file in memory.
    expect(maxActiveHashes).toBe(1);
    for (const partNumber of [1, 2, 3]) expect(seen.get(partNumber)).toBe(`sum-${partNumber}`);
  });

  it('does not re-hash a part when a transient failure sends it again', async () => {
    let hashes = 0;
    let calls = 0;
    const api = {
      async uploadPart(input: { partNumber: number }) {
        calls += 1;
        if (calls === 1) throw apiError(503, 'STORAGE_UNAVAILABLE');
        return { partNumber: input.partNumber, receivedBytes: 10 };
      },
    } as unknown as ApiClient;

    const confirmed = await transferParts({
      api,
      uploadId: UPLOAD_ID,
      parts: [
        {
          partNumber: 1,
          sizeBytes: 10,
          blob: new Blob([new Uint8Array(10)]),
          async checksum() {
            hashes += 1;
            return 'sum-1';
          },
        },
      ],
      signal,
      retryBaseDelayMs: 0,
    });

    expect(confirmed).toBe(10);
    expect(calls).toBe(2);
    expect(hashes).toBe(1);
  });
});

describe('transferParts — progress', () => {
  it('reports a total that only ever grows, however the parallel parts finish', async () => {
    const sizes = [10, 20, 30];
    const started: number[] = [];
    const gates = new Map<number, () => void>();
    const api = {
      async uploadPart(input: {
        partNumber: number;
        onProgress?: (sent: number, total: number) => void;
      }) {
        started.push(input.partNumber);
        const size = sizes[input.partNumber - 1] ?? 0;
        input.onProgress?.(size, size);
        await new Promise<void>((resolve) => gates.set(input.partNumber, resolve));
        return { partNumber: input.partNumber, receivedBytes: size };
      },
    } as unknown as ApiClient;

    const reported: number[] = [];
    const transfer = transferParts({
      api,
      uploadId: UPLOAD_ID,
      parts: [part(1, 10), part(2, 20), part(3, 30)],
      signal,
      concurrency: 3,
      retryBaseDelayMs: 0,
      onProgress: (uploadedBytes) => reported.push(uploadedBytes),
    });

    for (let tick = 0; tick < 50 && started.length < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(started.length).toBe(3);

    // The last part finishes first: the total must still move forward only.
    for (const partNumber of [3, 2, 1]) {
      gates.get(partNumber)?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(await transfer).toBe(60);
    expect(reported.at(-1)).toBe(60);
    expect(reported).toEqual([...reported].sort((left, right) => left - right));
    for (const value of reported) expect(value).toBeLessThanOrEqual(60);
  });

  it('does not count a part that has not been confirmed', async () => {
    const api = {
      async uploadPart(input: {
        partNumber: number;
        onProgress?: (sent: number, total: number) => void;
      }) {
        input.onProgress?.(8, 8);
        throw apiError(413, 'PAYLOAD_TOO_LARGE');
      },
    } as unknown as ApiClient;

    const reported: number[] = [];
    await expect(
      transferParts({
        api,
        uploadId: UPLOAD_ID,
        parts: [part(1, 8)],
        signal,
        retryBaseDelayMs: 0,
        onProgress: (uploadedBytes) => reported.push(uploadedBytes),
      }),
    ).rejects.toMatchObject({ status: 413 });

    expect(reported.at(-1)).toBe(0);
  });
});
