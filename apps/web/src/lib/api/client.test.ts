import { describe, expect, it, vi } from 'vitest';
import { API_PREFIX } from '@opendrive/shared';
import { ApiClient, PART_IDLE_TIMEOUT_MS } from './client.js';
import { ApiError, ContractError, NetworkError, NETWORK_FAILURE_MESSAGE } from './errors.js';
import {
  createFakeServer,
  createFakeXhr,
  defaultRoutes,
  fileFixture,
  problem,
  type FakeResponse,
  type FakeRoute,
  type FakeServer,
} from '../../test/fakeServer.js';

/**
 * The API client is the one place a credential is attached and the one place a server response is
 * turned into something the interface can reason about. These tests use the fake server (real
 * fetch semantics, controlled answers) so they exercise the actual request path.
 */
const UPLOAD_ID = `upl_${'1'.repeat(26)}`;
const FILE_ID = `file_${'2'.repeat(26)}`;

function clientFor(
  server: FakeServer,
  options: {
    token?: string | null;
    refresh?: () => Promise<string | null>;
    onAuthFailure?: () => void;
  } = {},
) {
  let token = options.token ?? null;
  const client = new ApiClient({
    credential: {
      token: () => token,
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
    },
    baseUrl: '',
    fetchImpl: server.fetch,
    xhrFactory: createFakeXhr(server.handleSync),
    ...(options.onAuthFailure === undefined ? {} : { onAuthFailure: options.onAuthFailure }),
  });
  return {
    client,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

describe('ApiClient credentials', () => {
  it('sends the bearer credential in the header and never in the URL', async () => {
    const server = createFakeServer(defaultRoutes());
    const { client } = clientFor(server, { token: 'ods_supersecret' });

    await client.listFiles({ limit: 10 });

    const call = server.calls[0];
    expect(call?.headers.authorization).toBe('Bearer ods_supersecret');
    expect(call?.path).toBe(`${API_PREFIX}/files`);
    expect(call?.path).not.toContain('supersecret');
    expect(call?.query.toString()).toBe('limit=10');
  });

  it('sends no authorization header when there is no credential', async () => {
    const server = createFakeServer(defaultRoutes());
    const { client } = clientFor(server);

    await client.listFiles({});

    expect(server.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('retries exactly once with a refreshed token after a 401', async () => {
    const server = createFakeServer([
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: (request) =>
          request.headers.authorization === 'Bearer fresh'
            ? { status: 200, body: { items: [fileFixture()], nextCursor: null } }
            : problem(401, 'UNAUTHORIZED', 'The access token is expired.'),
      },
    ]);
    const { client, setToken } = clientFor(server, {
      token: 'stale',
      refresh: async () => {
        setToken('fresh');
        return 'fresh';
      },
    });

    const page = await client.listFiles({});
    expect(page.items).toHaveLength(1);
    expect(server.calls.map((call) => call.headers.authorization)).toEqual([
      'Bearer stale',
      'Bearer fresh',
    ]);
  });

  it('tells the session layer when a 401 survives the refresh, and still reports the problem', async () => {
    const server = createFakeServer([
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: () => problem(401, 'UNAUTHORIZED', 'The access token is expired.'),
      },
    ]);
    const onAuthFailure = vi.fn();
    const { client } = clientFor(server, {
      token: 'stale',
      refresh: async () => 'stale',
      onAuthFailure,
    });

    await expect(client.listFiles({})).rejects.toBeInstanceOf(ApiError);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    // One original attempt plus one retry: a mutating call is never retried more than once.
    expect(server.calls).toHaveLength(2);
  });
});

describe('ApiClient failure mapping', () => {
  it('keeps the machine-readable parts of a problem response', async () => {
    const server = createFakeServer([
      {
        method: 'DELETE',
        path: /\/files\//,
        respond: () =>
          problem(409, 'FILE_NOT_SERVABLE', 'This file is quarantined and cannot be served.'),
      },
    ]);
    const { client } = clientFor(server, { token: 'token' });

    const failure = await client.deleteFile(FILE_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 409,
      code: 'FILE_NOT_SERVABLE',
      detail: 'This file is quarantined and cannot be served.',
    });
  });

  it('does not invent a code for a body this build cannot read', async () => {
    const server = createFakeServer([
      {
        method: 'GET',
        path: `${API_PREFIX}/limits`,
        respond: () => ({ status: 503, body: '<html>nginx</html>' }),
      },
    ]);
    const { client } = clientFor(server, { token: 'token' });

    const failure = await client.limits().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: 'UNEXPECTED_RESPONSE' });
  });

  it('rejects a response that does not match the published contract', async () => {
    const server = createFakeServer([
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: () => ({
          status: 200,
          body: { items: [{ id: 'not-a-file-id' }], nextCursor: null },
        }),
      },
    ]);
    const { client } = clientFor(server, { token: 'token' });

    await expect(client.listFiles({})).rejects.toBeInstanceOf(ContractError);
  });

  it('reports a transport failure as a network failure rather than as a server answer', async () => {
    const failing = new ApiClient({
      credential: { token: () => 'token' },
      baseUrl: '',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(failing.listFiles({})).rejects.toMatchObject({
      // The message is the sentence a person reads, never the string the engine produced — here
      // "fetch failed", in Chromium "Failed to fetch". The match also pins the failure as a
      // network failure rather than a server answer that never arrived.
      name: 'NetworkError',
      message: NETWORK_FAILURE_MESSAGE,
    });
  });

  it('reads the readiness body even when the API answers 503', async () => {
    const degraded = {
      status: 'degraded',
      checkedAt: '2026-10-12T10:00:00.000Z',
      dependencies: [
        {
          name: 'storage',
          status: 'not_configured',
          required: true,
          detail: 'no provider configured',
        },
      ],
    };
    const server = createFakeServer([
      { method: 'GET', path: '/readyz', respond: () => ({ status: 503, body: degraded }) },
    ]);
    const { client } = clientFor(server, { token: 'token' });

    await expect(client.readiness()).resolves.toMatchObject({ status: 'degraded' });
  });
});

describe('ApiClient upload parts', () => {
  const partRoute = (respond: FakeRoute['respond']): FakeRoute => ({
    method: 'PUT',
    path: /^\/api\/v1\/uploads\/upl_[0-9a-z]+\/parts\/\d+$/,
    respond,
  });

  it('sends the part through XMLHttpRequest, with the checksum header and honest progress', async () => {
    const seen: { request: Parameters<FakeRoute['respond']>[0] }[] = [];
    const server = createFakeServer([
      partRoute((request) => {
        seen.push({ request });
        return { status: 200, body: { partNumber: 1, receivedBytes: 2048 } };
      }),
    ]);
    const { client } = clientFor(server, { token: 'token' });
    const progress = vi.fn();
    const body = new Blob(['x'.repeat(2048)]);

    const result = await client.uploadPart({
      uploadId: UPLOAD_ID,
      partNumber: 1,
      body,
      checksumSha256: 'a'.repeat(64),
      onProgress: progress,
    });

    expect(result).toEqual({ partNumber: 1, receivedBytes: 2048 });
    expect(seen[0]?.request.headers['authorization']).toBe('Bearer token');
    expect(seen[0]?.request.headers['content-type']).toBe('application/octet-stream');
    expect(seen[0]?.request.headers['x-part-checksum-sha256']).toBe('a'.repeat(64));
    expect(progress).toHaveBeenCalledWith(2048, 2048);
  });

  it('surfaces a refused part as the API problem, not as a successful part', async () => {
    const server = createFakeServer([
      partRoute(() =>
        problem(413, 'PAYLOAD_TOO_LARGE', 'That part is larger than this deployment accepts.'),
      ),
    ]);
    const { client } = clientFor(server, { token: 'token' });

    const failure = await client
      .uploadPart({ uploadId: UPLOAD_ID, partNumber: 1, body: new Blob(['x']) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses to send a part for an already-aborted upload', async () => {
    const server = createFakeServer([
      partRoute(() => ({ status: 200, body: { partNumber: 1, receivedBytes: 1 } })),
    ]);
    const { client } = clientFor(server, { token: 'token' });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.uploadPart({
        uploadId: UPLOAD_ID,
        partNumber: 1,
        body: new Blob(['x']),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.calls).toHaveLength(0);
  });

  it('aborts a part that stops moving, so the caller can retry it', async () => {
    vi.useFakeTimers();
    try {
      let release: ((response: FakeResponse) => void) | undefined;
      const server = createFakeServer([
        partRoute(
          () =>
            new Promise<FakeResponse>((resolve) => {
              release = resolve;
            }),
        ),
      ]);
      const client = new ApiClient({
        credential: { token: () => 'token' },
        baseUrl: '',
        fetchImpl: server.fetch,
        xhrFactory: createFakeXhr(server.handleAsync),
      });

      const outcome = client
        .uploadPart({ uploadId: UPLOAD_ID, partNumber: 1, body: new Blob(['x']) })
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(PART_IDLE_TIMEOUT_MS);
      await expect(outcome).resolves.toBeInstanceOf(NetworkError);

      release?.({ status: 200, body: { partNumber: 1, receivedBytes: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ApiClient upload completion', () => {
  const completeRoute = (respond: FakeRoute['respond']): FakeRoute => ({
    method: 'POST',
    path: /^\/api\/v1\/uploads\/upl_[0-9a-z]+\/complete$/,
    respond,
  });

  it('returns the file when finalization finishes inside the request', async () => {
    const server = createFakeServer([
      completeRoute(() => ({ status: 200, body: { file: fileFixture() } })),
    ]);
    const { client } = clientFor(server, { token: 'token' });

    const outcome = await client.completeUpload(UPLOAD_ID);
    expect(outcome).toEqual({ status: 'ready', file: fileFixture() });
  });

  it('reports processing on 202 and lets the caller poll to the file', async () => {
    let call = 0;
    const server = createFakeServer([
      completeRoute(() => {
        call += 1;
        return call === 1
          ? {
              status: 202,
              body: { uploadId: UPLOAD_ID, fileId: FILE_ID, state: 'processing' },
            }
          : { status: 200, body: { file: fileFixture({ id: FILE_ID }) } };
      }),
    ]);
    const { client } = clientFor(server, { token: 'token' });

    const first = await client.completeUpload(UPLOAD_ID);
    expect(first).toEqual({ status: 'processing', uploadId: UPLOAD_ID, fileId: FILE_ID });

    const second = await client.completeUpload(UPLOAD_ID);
    expect(second).toEqual({ status: 'ready', file: fileFixture({ id: FILE_ID }) });
    expect(server.calls).toHaveLength(2);
  });

  it('rejects a 202 body that does not match the accepted contract', async () => {
    const server = createFakeServer([completeRoute(() => ({ status: 202, body: { nope: true } }))]);
    const { client } = clientFor(server, { token: 'token' });

    await expect(client.completeUpload(UPLOAD_ID)).rejects.toBeInstanceOf(ContractError);
  });

  it('treats an empty completion body as a transient failure, not a contract error', async () => {
    const server = createFakeServer([completeRoute(() => ({ status: 200, text: '' }))]);
    const { client } = clientFor(server, { token: 'token' });

    await expect(client.completeUpload(UPLOAD_ID)).rejects.toBeInstanceOf(NetworkError);
  });

  it('surfaces a failed completion as the API problem', async () => {
    const server = createFakeServer([
      completeRoute(() => problem(503, 'STORAGE_UNAVAILABLE', 'Storage is unavailable.')),
    ]);
    const { client } = clientFor(server, { token: 'token' });

    const failure = await client.completeUpload(UPLOAD_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
  });
});
