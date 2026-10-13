import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../lib/api/errors.js';
import type { ApiClient } from '../lib/api/client.js';
import { uploadPartWithRetry } from './uploadQueue.js';

type PartParams = Parameters<ApiClient['uploadPart']>[0];

const params = {
  uploadId: 'upl_00000000000000000000000001',
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

  it('gives up after the third transient failure', async () => {
    const { api, calls } = fakeApi([
      apiError(503, 'STORAGE_UNAVAILABLE'),
      apiError(503, 'STORAGE_UNAVAILABLE'),
      apiError(503, 'STORAGE_UNAVAILABLE'),
    ]);
    await expect(uploadPartWithRetry(api, params, signal, 0)).rejects.toMatchObject({
      status: 503,
    });
    expect(calls.count).toBe(3);
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
