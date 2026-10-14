import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../lib/api/errors.js';
import type { ApiClient, CompleteUploadOutcome } from '../lib/api/client.js';
import {
  FINALIZE_RETRY_ATTEMPTS,
  PART_RETRY_ATTEMPTS,
  completeUploadWithRetry,
  uploadPartWithRetry,
} from './uploadQueue.js';

type PartParams = Parameters<ApiClient['uploadPart']>[0];

const UPLOAD_ID = 'upl_00000000000000000000000001';

const params = {
  uploadId: UPLOAD_ID,
  partNumber: 1,
  body: new Blob(['x']),
} as unknown as PartParams;

function fakeApi(results: (Error | 'ok')[]): { api: ApiClient; calls: { count: number } } {
  const calls = { count: 0 };
  const api = {
    uploadPart: async () => {
      const result = results[calls.count];
      calls.count += 1;
      if (result === 'ok') return { partNumber: 1, receivedBytes: 1 };
      throw result ?? new Error('unexpected attempt');
    },
  } as unknown as ApiClient;
  return { api, calls };
}

function apiError(status: number, code: string): ApiError {
  return new ApiError({ status, code, detail: 'failure' });
}

const signal = new AbortController().signal;

describe('uploadPartWithRetry', () => {
  it('sends once and returns when the part is accepted', async () => {
    const { api, calls } = fakeApi(['ok']);
    await uploadPartWithRetry(api, params, signal, 0);
    expect(calls.count).toBe(1);
  });

  it('retries a transient 502 and succeeds', async () => {
    const { api, calls } = fakeApi([apiError(502, 'STORAGE_UNAVAILABLE'), 'ok']);
    await uploadPartWithRetry(api, params, signal, 0);
    expect(calls.count).toBe(2);
  });

  it('retries a rate limit and succeeds', async () => {
    const { api, calls } = fakeApi([apiError(429, 'RATE_LIMITED'), 'ok']);
    await uploadPartWithRetry(api, params, signal, 0);
    expect(calls.count).toBe(2);
  });

  it('retries a network failure and succeeds', async () => {
    const { api, calls } = fakeApi([new NetworkError('offline'), 'ok']);
    await uploadPartWithRetry(api, params, signal, 0);
    expect(calls.count).toBe(2);
  });

  it('treats a 409 on a retry as success, since the part is already stored', async () => {
    const { api, calls } = fakeApi([
      apiError(502, 'STORAGE_UNAVAILABLE'),
      apiError(409, 'CONFLICT'),
    ]);
    await expect(uploadPartWithRetry(api, params, signal, 0)).resolves.toBeUndefined();
    expect(calls.count).toBe(2);
  });

  it('does not retry a 409 on the first attempt', async () => {
    const { api, calls } = fakeApi([apiError(409, 'CONFLICT')]);
    await expect(uploadPartWithRetry(api, params, signal, 0)).rejects.toMatchObject({
      status: 409,
    });
    expect(calls.count).toBe(1);
  });

  it('does not retry a refused part size', async () => {
    const { api, calls } = fakeApi([apiError(413, 'PAYLOAD_TOO_LARGE')]);
    await expect(uploadPartWithRetry(api, params, signal, 0)).rejects.toMatchObject({
      status: 413,
    });
    expect(calls.count).toBe(1);
  });

  it('gives up once every transient attempt is spent', async () => {
    const attempts = Array.from({ length: PART_RETRY_ATTEMPTS }, () =>
      apiError(503, 'STORAGE_UNAVAILABLE'),
    );
    const { api, calls } = fakeApi(attempts);
    await expect(uploadPartWithRetry(api, params, signal, 0)).rejects.toMatchObject({
      status: 503,
    });
    expect(calls.count).toBe(PART_RETRY_ATTEMPTS);
  });

  it('stops retrying once the signal is cancelled', async () => {
    const controller = new AbortController();
    const { api, calls } = fakeApi([apiError(502, 'STORAGE_UNAVAILABLE'), 'ok']);
    controller.abort();
    await expect(uploadPartWithRetry(api, params, controller.signal, 0)).rejects.toMatchObject({
      status: 502,
    });
    expect(calls.count).toBe(1);
  });
});

const processing: CompleteUploadOutcome = {
  status: 'processing',
  uploadId: UPLOAD_ID,
  fileId: 'file_00000000000000000000000001',
};

function fakeCompletion(results: (Error | CompleteUploadOutcome)[]): {
  api: ApiClient;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const api = {
    completeUpload: async () => {
      const result = results[calls.count];
      calls.count += 1;
      if (result === undefined) throw new Error('unexpected attempt');
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('completeUploadWithRetry', () => {
  it('retries a transient 503 and returns the outcome', async () => {
    const { api, calls } = fakeCompletion([apiError(503, 'STORAGE_UNAVAILABLE'), processing]);
    await expect(completeUploadWithRetry(api, UPLOAD_ID, signal, 0)).resolves.toEqual(processing);
    expect(calls.count).toBe(2);
  });

  it('gives up once every transient attempt is spent', async () => {
    const attempts = Array.from({ length: FINALIZE_RETRY_ATTEMPTS }, () =>
      apiError(502, 'STORAGE_UNAVAILABLE'),
    );
    const { api, calls } = fakeCompletion(attempts);
    await expect(completeUploadWithRetry(api, UPLOAD_ID, signal, 0)).rejects.toMatchObject({
      status: 502,
    });
    expect(calls.count).toBe(FINALIZE_RETRY_ATTEMPTS);
  });

  it('does not retry a definitive failure', async () => {
    const { api, calls } = fakeCompletion([apiError(404, 'NOT_FOUND')]);
    await expect(completeUploadWithRetry(api, UPLOAD_ID, signal, 0)).rejects.toMatchObject({
      status: 404,
    });
    expect(calls.count).toBe(1);
  });
});
