import type {
  FileRecord,
  FolderRecord,
  LimitsResponse,
  ReadinessResponse,
} from '@opendrive/shared';

/**
 * A fake OpenDrive API.
 *
 * It answers the real routes with real shapes (parsed against the shared schemas by the client
 * under test), records every request, and can be told to fail a specific route with a specific
 * problem body. That is the boundary the tests mock: the HTTP layer, not the components.
 */
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  uploadProgress?: (sent: number, total: number) => void;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Raw response text, for endpoints whose body is not JSON (file content). */
  text?: string;
  contentType?: string;
}

export interface FakeRoute {
  method: string;
  path: string | RegExp;
  /**
   * Answer a request. Returning a promise holds the request open, which is how a test can observe
   * (and act on) an in-flight transfer instead of racing a response that lands in the same tick.
   */
  respond: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;
}

export interface FakeServer {
  fetch: typeof fetch;
  calls: FakeRequest[];
  routes: FakeRoute[];
  /** Synchronous entry point used by the fake XMLHttpRequest for part uploads. */
  handleSync: (request: FakeRequest) => FakeResponse;
  /** Full entry point, including deferred routes. */
  handleAsync: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;
  /** Replace the handler for a route, e.g. to make the next list answer 503. */
  override(method: string, path: string | RegExp, respond: FakeRoute['respond']): void;
  failWith(
    method: string,
    path: string | RegExp,
    status: number,
    code: string,
    detail: string,
  ): void;
}

function match(route: FakeRoute, request: FakeRequest): boolean {
  if (route.method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (typeof route.path === 'string') return route.path === request.path;
  return route.path.test(request.path);
}

export function problem(status: number, code: string, detail: string): FakeResponse {
  return {
    status,
    body: {
      type: `https://opendrive.test/problems/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      code,
    },
  };
}

export function createFakeServer(routes: FakeRoute[]): FakeServer {
  const calls: FakeRequest[] = [];
  const table = [...routes];

  const handle = (request: FakeRequest): FakeResponse | Promise<FakeResponse> => {
    calls.push(request);
    const route = table.find((candidate) => match(candidate, request));
    if (route === undefined) {
      return problem(404, 'NOT_FOUND', `No fake route for ${request.method} ${request.path}`);
    }
    return route.respond(request);
  };

  /** The synchronous view, for the fake XMLHttpRequest: a deferred route cannot answer it. */
  const handleSync = (request: FakeRequest): FakeResponse => {
    const outcome = handle(request);
    if (outcome instanceof Promise) {
      throw new Error(
        `The route for ${request.method} ${request.path} is deferred and cannot answer a part upload synchronously.`,
      );
    }
    return outcome;
  };

  // A signal can be aborted while the handler is awaiting, so it is re-read through a function
  // rather than narrowed once: `fetch` must reject when the caller gave up, exactly as it does.
  const wasAborted = (signal: AbortSignal | null | undefined): boolean => signal?.aborted === true;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (wasAborted(init?.signal)) throw new DOMException('Aborted', 'AbortError');
    // The client builds relative paths when no base URL is configured; the fake server plays the
    // role the browser plays for a real one, resolving them against a loopback origin.
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://localhost');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: unknown;
    if (typeof init?.body === 'string' && init.body !== '') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const response = await handle({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    });
    if (wasAborted(init?.signal)) throw new DOMException('Aborted', 'AbortError');
    return new Response(
      response.text ?? (response.body === undefined ? null : JSON.stringify(response.body)),
      {
        status: response.status,
        headers: { 'content-type': response.contentType ?? 'application/json' },
      },
    );
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    routes: table,
    handleSync,
    handleAsync: handle,
    override(method, path, respond) {
      const index = table.findIndex(
        (route) =>
          route.method === method && match(route, { method, path: String(path) } as FakeRequest),
      );
      const next: FakeRoute = { method, path, respond };
      if (index === -1) table.unshift(next);
      else table[index] = next;
    },
    failWith(method, path, status, code, detail) {
      this.override(method, path, () => problem(status, code, detail));
    },
  };
}

/* Fixtures ------------------------------------------------------------------ */

export function fileFixture(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 'file_00000000000000000000000001',
    owner: { kind: 'user' },
    folderId: null,
    filename: 'chart.png',
    sizeBytes: 4096,
    mimeType: 'image/png',
    detectedMimeType: 'image/png',
    visibility: 'private',
    status: 'ready',
    scanState: 'not_scanned',
    checksumSha256: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

export function folderFixture(overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id: 'fold_00000000000000000000000001',
    owner: { kind: 'user' },
    parentId: null,
    name: 'Charts',
    depth: 0,
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    ...overrides,
  };
}

export function limitsFixture(overrides: Partial<LimitsResponse> = {}): LimitsResponse {
  return {
    maxFileSizeBytes: 5 * 1024 ** 3,
    maxFileSizeVerified: false,
    chunkSizeBytes: 8 * 1024 ** 2,
    minChunkSizeBytes: 1024 ** 2,
    maxChunkSizeBytes: 2_000_000_000,
    maxPartsPerUpload: 10_000,
    anonymousUploadsPerDay: 10,
    registeredUploadsPerDay: 1000,
    malwareScanEnabled: false,
    ...overrides,
  };
}

export function readinessFixture(storage: 'ok' | 'not_configured' = 'ok'): ReadinessResponse {
  return {
    status: storage === 'ok' ? 'ready' : 'degraded',
    checkedAt: '2026-10-12T10:00:00.000Z',
    dependencies: [
      {
        name: 'postgres',
        status: storage === 'ok' ? 'ok' : 'unavailable',
        required: true,
        detail: 'reachable',
      },
      { name: 'redis', status: 'not_configured', required: false, detail: 'not configured' },
      {
        name: 'storage',
        status: storage,
        required: true,
        detail: storage === 'ok' ? 'telegram-experimental attached' : 'no provider configured',
      },
      { name: 'auth', status: 'ok', required: true, detail: 'JWKS reachable' },
    ],
  };
}

export function meFixture(overrides: { principalKind?: 'user' | 'anonymous' } = {}) {
  const kind = overrides.principalKind ?? 'user';
  return {
    identity: {
      principalKind: kind,
      userId: kind === 'user' ? '11111111-1111-4111-8111-111111111111' : null,
      sessionId: kind === 'anonymous' ? 'sess_00000000000000000000000001' : null,
      displayName: null,
      accountStatus: 'active',
      credentialExpiresAt: null,
      scopes: ['files:read', 'files:write', 'shares:write', 'account:read'],
      apiKeyId: null,
      apiKeyPrefix: null,
    },
    quota: {
      principalKind: kind,
      accountStatus: 'active',
      limits: {
        storageBytes: 5_368_709_120,
        maxFileSizeBytes: 5_368_709_120,
        maxFiles: kind === 'user' ? 100_000 : 200,
        uploadBytesPerDay: 10_737_418_240,
        downloadBytesPerDay: 21_474_836_480,
        fileExpiresAfterHours: kind === 'user' ? null : 168,
      },
      usage: {
        storageBytes: 4096,
        storedBytes: 4096,
        heldBytes: 0,
        storedFiles: 1,
        uploadBytesToday: 4096,
        downloadBytesToday: 0,
      },
      remaining: {
        storageBytes: 5_368_705_024,
        files: kind === 'user' ? 99_999 : 199,
        uploadBytesToday: 10_737_414_144,
        downloadBytesToday: 21_474_836_480,
      },
    },
  };
}

/** The default route set: enough of the API for the drive, status and account screens. */
export function defaultRoutes(
  options: {
    files?: FileRecord[];
    folders?: FolderRecord[];
    storage?: 'ok' | 'not_configured';
    meKind?: 'user' | 'anonymous';
    limits?: Partial<LimitsResponse>;
  } = {},
): FakeRoute[] {
  const files = options.files ?? [fileFixture()];
  const folders = options.folders ?? [];

  return [
    {
      method: 'GET',
      path: '/healthz',
      respond: () => ({
        status: 200,
        body: {
          status: 'ok',
          service: 'opendrive-api',
          version: '0.1.0',
          apiVersion: 'v1',
          uptimeSeconds: 120,
          timestamp: '2026-10-12T10:00:00.000Z',
        },
      }),
    },
    {
      method: 'GET',
      path: '/readyz',
      respond: () => ({ status: 200, body: readinessFixture(options.storage ?? 'ok') }),
    },
    {
      method: 'GET',
      path: '/api/v1/limits',
      respond: () => ({ status: 200, body: limitsFixture(options.limits) }),
    },
    {
      method: 'GET',
      path: '/api/v1/me',
      respond: () => ({ status: 200, body: meFixture({ principalKind: options.meKind }) }),
    },
    {
      method: 'GET',
      path: '/api/v1/files',
      respond: (request) => {
        const folder = request.query.get('folder');
        const filtered = files.filter((file) =>
          folder === null
            ? true
            : folder === 'root'
              ? file.folderId === null
              : file.folderId === folder,
        );
        return { status: 200, body: { items: filtered, nextCursor: null } };
      },
    },
    {
      method: 'GET',
      path: '/api/v1/folders',
      respond: () => ({ status: 200, body: { items: folders, nextCursor: null } }),
    },
    {
      method: 'POST',
      path: '/api/v1/anonymous-sessions',
      respond: () => ({
        status: 201,
        body: {
          sessionId: 'sess_00000000000000000000000002',
          // `ods_` plus 43 base64url characters: the shape the shared credential pattern requires.
          credential: `ods_${'a'.repeat(43)}`,
          expiresAt: '2026-10-13T10:00:00.000Z',
        },
      }),
    },
  ];
}

/**
 * A minimal XMLHttpRequest that answers part uploads through the same fake server, including a
 * progress event, so the production part path is exercised rather than stubbed out.
 */
export function createFakeXhr(
  makeResponse: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>,
): () => XMLHttpRequest {
  return () => {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const uploadListeners: Record<string, ((event: unknown) => void)[]> = {};
    const xhr = {
      status: 0,
      responseText: '',
      withCredentials: false,
      upload: {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          (uploadListeners[type] ??= []).push(listener);
        },
      },
      open(_method: string, _url: string, _async?: boolean) {
        (xhr as { method?: string }).method = _method;
        (xhr as { url?: string }).url = _url;
      },
      setRequestHeader(key: string, value: string) {
        const headers = ((xhr as { headers?: Record<string, string> }).headers ??= {});
        headers[key.toLowerCase()] = value;
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        (listeners[type] ??= []).push(listener);
      },
      abort() {
        for (const listener of listeners['abort'] ?? []) listener({});
      },
      send(body: unknown) {
        const url = new URL((xhr as { url?: string }).url ?? '/', 'http://localhost');
        const total = body instanceof Blob ? body.size : 0;
        for (const listener of uploadListeners['progress'] ?? []) {
          listener({ lengthComputable: true, loaded: total, total });
        }
        const finish = (response: FakeResponse) => {
          xhr.status = response.status;
          xhr.responseText =
            response.text ?? (response.body === undefined ? '' : JSON.stringify(response.body));
          for (const listener of listeners['load'] ?? []) listener({});
        };
        const outcome = makeResponse({
          method: (xhr as { method?: string }).method ?? 'PUT',
          path: url.pathname,
          query: url.searchParams,
          headers: (xhr as { headers?: Record<string, string> }).headers ?? {},
          body,
        });
        if (outcome instanceof Promise) {
          // A deferred route: the answer lands whenever the test says so. An abort that arrives
          // first has already settled the request, and this late answer is then ignored.
          outcome.then(finish, () => {
            for (const listener of listeners['error'] ?? []) listener({});
          });
          return;
        }
        finish(outcome);
      },
    };
    return xhr as unknown as XMLHttpRequest;
  };
}
