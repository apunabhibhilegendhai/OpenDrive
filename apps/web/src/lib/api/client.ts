import {
  API_PREFIX,
  SHARE_TOKEN_HEADER,
  UPLOAD_PART_CHECKSUM_HEADER,
  anonymousSessionResponseSchema,
  apiKeyPageSchema,
  completeUploadAcceptedSchema,
  completeUploadResponseSchema,
  createdApiKeyRecordSchema,
  createdShareRecordSchema,
  filePageSchema,
  fileRecordSchema,
  folderPageSchema,
  folderRecordSchema,
  healthResponseSchema,
  initiateUploadResponseSchema,
  limitsResponseSchema,
  meResponseSchema,
  readinessResponseSchema,
  resolveShareResponseSchema,
  uploadPartResponseSchema,
  uploadStatusResponseSchema,
} from '@opendrive/shared';
import type {
  ApiKeyRecord,
  CreateFolderRequest,
  CreateShareRequest,
  FileRecord,
  FolderRecord,
  HealthResponse,
  InitiateUploadRequest,
  InitiateUploadResponse,
  LimitsResponse,
  MeResponse,
  ReadinessResponse,
  ResolveShareResponse,
  UploadStatusResponse,
  UpdateFolderRequest,
} from '@opendrive/shared';
import { ApiError, ContractError, NetworkError, problemFrom } from './errors.js';

/**
 * The single typed client for the OpenDrive API.
 *
 * Two rules govern it:
 *   1. Responses are parsed through the shared schemas. A server/client drift becomes an
 *      explicit "unexpected response" state instead of `undefined` rendered into the page.
 *   2. The credential travels in the `Authorization` header only — never in a URL, a query
 *      string, a log line or an error message.
 */

/** Anything that can answer "what credential should this request carry". */
export interface CredentialSource {
  /** Current bearer credential, or null when the caller is signed out. */
  token(): string | null;
  /**
   * Called once after a 401. Returning a fresh credential allows exactly one retry; returning
   * null means the session is gone and the error is surfaced.
   */
  refresh?(): Promise<string | null>;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type Schema<T> = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
};

/** Build-time override; an empty value means "same-origin relative paths" (the Vite proxy). */
const configuredBaseUrl: unknown = import.meta.env.VITE_API_BASE_URL;
export const API_BASE_URL: string =
  typeof configuredBaseUrl === 'string' ? configuredBaseUrl.replace(/\/+$/, '') : '';

export interface ApiClientOptions {
  credential: CredentialSource;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Factory for the request object used to send a part.
   *
   * Part uploads need `XMLHttpRequest` because `fetch` cannot report upload progress; making the
   * object injectable is what lets the real part path be exercised in tests without a network.
   */
  xhrFactory?: () => XMLHttpRequest;
  /**
   * Called once when a request is refused with `401` *after* the single refresh attempt, i.e.
   * when the credential itself is dead rather than merely stale. The session layer uses this to
   * drop the credential and return to sign-in, so every screen behaves the same way instead of
   * each one inventing its own expiry handling.
   */
  onAuthFailure?: () => void;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Outcome of finalizing an upload.
 *
 * `ready` carries the servable file. `processing` means the server is still assembling/sending the
 * object in the background; the caller should poll `completeUpload` with the same upload id until
 * it resolves `ready`.
 */
export type CompleteUploadOutcome =
  | { status: 'ready'; file: FileRecord }
  | { status: 'processing'; uploadId: string; fileId: string };

export class ApiClient {
  readonly #credential: CredentialSource;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #xhr: () => XMLHttpRequest;
  readonly #onAuthFailure: (() => void) | undefined;

  constructor(options: ApiClientOptions) {
    this.#credential = options.credential;
    this.#baseUrl = options.baseUrl ?? API_BASE_URL;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#xhr = options.xhrFactory ?? (() => new XMLHttpRequest());
    this.#onAuthFailure = options.onAuthFailure;
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  #authHeaders(): Record<string, string> {
    const token = this.#credential.token();
    return token === null ? {} : { authorization: `Bearer ${token}` };
  }

  async #send(path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.#authHeaders(),
      ...options.headers,
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      body = JSON.stringify(options.body);
    }

    try {
      return await this.#fetch(this.#url(path), {
        method: options.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError(error instanceof Error ? error.message : 'network error');
    }
  }

  /**
   * One request with validation and a single, safe 401 retry.
   *
   * The retry is safe because a 401 means the request was refused before it did anything; a
   * mutating call is never retried on any other failure.
   */
  async request<T>(
    path: string,
    schema: Schema<T>,
    options: RequestOptions = {},
    allowRetry = true,
  ): Promise<T> {
    let response = await this.#send(path, options);

    if (response.status === 401 && allowRetry && this.#credential.refresh !== undefined) {
      const refreshed = await this.#credential.refresh();
      if (refreshed !== null) {
        response = await this.#send(path, options);
      }
    }

    const payload = await readJson(response);
    if (response.status === 401) {
      this.#onAuthFailure?.();
    }
    if (!response.ok) {
      throw problemFrom(response.status, payload);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ContractError(
        response.status,
        parsed.error.issues[0]?.message ?? 'The response does not match the published contract.',
      );
    }
    return parsed.data;
  }

  /** System ----------------------------------------------------------------- */

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request('/healthz', healthResponseSchema, { ...(signal ? { signal } : {}) });
  }

  /** Readiness answers 503 while degraded; the body is still the authoritative answer. */
  async readiness(signal?: AbortSignal): Promise<ReadinessResponse> {
    const response = await this.#send('/readyz', { ...(signal ? { signal } : {}) });
    const payload = await readJson(response);
    const parsed = readinessResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw problemFrom(response.status, payload);
    }
    return parsed.data;
  }

  limits(signal?: AbortSignal): Promise<LimitsResponse> {
    return this.request(`${API_PREFIX}/limits`, limitsResponseSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  me(signal?: AbortSignal): Promise<MeResponse> {
    return this.request(`${API_PREFIX}/me`, meResponseSchema, { ...(signal ? { signal } : {}) });
  }

  /** Files ------------------------------------------------------------------ */

  listFiles(
    query: { folder?: string; limit?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<Page<FileRecord>> {
    const params = new URLSearchParams();
    if (query.folder !== undefined) params.set('folder', query.folder);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return this.request(`${API_PREFIX}/files${suffix}`, filePageSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  getFile(fileId: string, signal?: AbortSignal): Promise<FileRecord> {
    return this.request(`${API_PREFIX}/files/${fileId}`, fileRecordSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  /** Owner deletion. */
  deleteFile(fileId: string, signal?: AbortSignal): Promise<void> {
    return this.request(`${API_PREFIX}/files/${fileId}`, emptySchema, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  /** Anonymous deletion: the issuing credential's one-time token travels in its own header. */
  deleteFileWithToken(fileId: string, deletionToken: string, signal?: AbortSignal): Promise<void> {
    return this.request(`${API_PREFIX}/files/${fileId}`, emptySchema, {
      method: 'DELETE',
      headers: { 'x-deletion-token': deletionToken },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Content download. Returns the raw response so the caller can stream it to disk where the
   * browser supports it, instead of buffering the object in memory here.
   */
  async openContent(fileId: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.#send(`${API_PREFIX}/files/${fileId}/content`, {
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw problemFrom(response.status, await readJson(response));
    }
    return response;
  }

  /** Folders ---------------------------------------------------------------- */

  listFolders(
    query: { parent?: string | null; limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<Page<FolderRecord>> {
    const params = new URLSearchParams();
    if (query.parent === null) params.set('parent', 'root');
    else if (typeof query.parent === 'string') params.set('parent', query.parent);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return this.request(`${API_PREFIX}/folders${suffix}`, folderPageSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  createFolder(body: CreateFolderRequest, signal?: AbortSignal): Promise<FolderRecord> {
    return this.request(`${API_PREFIX}/folders`, folderRecordSchema, {
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  updateFolder(
    folderId: string,
    body: UpdateFolderRequest,
    signal?: AbortSignal,
  ): Promise<FolderRecord> {
    return this.request(`${API_PREFIX}/folders/${folderId}`, folderRecordSchema, {
      method: 'PATCH',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  deleteFolder(folderId: string, signal?: AbortSignal): Promise<void> {
    return this.request(`${API_PREFIX}/folders/${folderId}`, emptySchema, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  /** Uploads ---------------------------------------------------------------- */

  initiateUpload(
    body: InitiateUploadRequest,
    signal?: AbortSignal,
  ): Promise<InitiateUploadResponse> {
    return this.request(`${API_PREFIX}/uploads`, initiateUploadResponseSchema, {
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  uploadStatus(uploadId: string, signal?: AbortSignal): Promise<UploadStatusResponse> {
    return this.request(`${API_PREFIX}/uploads/${uploadId}`, uploadStatusResponseSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Finalize an upload.
   *
   * Small objects finalize inside the request and answer `200` with the file. Large ones assemble
   * and send in the background and answer `202`; the caller polls this same call until it answers
   * `200`. The operation is idempotent, so polling never starts a second send.
   */
  async completeUpload(uploadId: string, signal?: AbortSignal): Promise<CompleteUploadOutcome> {
    const response = await this.#send(`${API_PREFIX}/uploads/${uploadId}/complete`, {
      method: 'POST',
      body: {},
      ...(signal ? { signal } : {}),
    });
    const payload = await readJson(response);
    if (response.status === 202) {
      const accepted = completeUploadAcceptedSchema.safeParse(payload);
      if (!accepted.success) {
        throw new ContractError(
          response.status,
          'The accepted response does not match the published contract.',
        );
      }
      return {
        status: 'processing',
        uploadId: accepted.data.uploadId,
        fileId: accepted.data.fileId,
      };
    }
    if (response.status === 401) {
      this.#onAuthFailure?.();
    }
    if (!response.ok) {
      throw problemFrom(response.status, payload);
    }
    const parsed = completeUploadResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ContractError(
        response.status,
        parsed.error.issues[0]?.message ?? 'The response does not match the published contract.',
      );
    }
    return { status: 'ready', file: parsed.data.file };
  }

  abortUpload(uploadId: string, signal?: AbortSignal): Promise<void> {
    return this.request(`${API_PREFIX}/uploads/${uploadId}`, emptySchema, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Send one part.
   *
   * Uses XMLHttpRequest because `fetch` cannot report upload progress, and honest progress is
   * the point: the number shown is bytes the browser has actually handed to the socket. The
   * part body is the raw bytes, so the checksum rides in its own header.
   */
  async uploadPart(input: {
    uploadId: string;
    partNumber: number;
    body: Blob;
    checksumSha256?: string;
    signal?: AbortSignal;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  }): Promise<{ partNumber: number; receivedBytes: number; checksumSha256?: string }> {
    const url = this.#url(`${API_PREFIX}/uploads/${input.uploadId}/parts/${input.partNumber}`);
    return await new Promise((resolve, reject) => {
      const request = this.#xhr();
      request.open('PUT', url, true);
      request.setRequestHeader('accept', 'application/json');
      request.setRequestHeader('content-type', 'application/octet-stream');
      const token = this.#credential.token();
      if (token !== null) request.setRequestHeader('authorization', `Bearer ${token}`);
      if (input.checksumSha256 !== undefined) {
        request.setRequestHeader(UPLOAD_PART_CHECKSUM_HEADER, input.checksumSha256);
      }

      const onAbort = () => request.abort();
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        input.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (input.onProgress !== undefined) {
        request.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) input.onProgress?.(event.loaded, event.total);
        });
      }

      const cleanup = () => input.signal?.removeEventListener('abort', onAbort);

      request.addEventListener('load', () => {
        cleanup();
        const payload = parseJsonText(request.responseText);
        if (request.status === 401) {
          this.#onAuthFailure?.();
        }
        if (request.status < 200 || request.status >= 300) {
          reject(problemFrom(request.status, payload));
          return;
        }
        const parsed = uploadPartResponseSchema.safeParse(payload);
        if (!parsed.success) {
          reject(
            new ContractError(request.status, 'The part response does not match the contract.'),
          );
          return;
        }
        resolve(parsed.data);
      });
      request.addEventListener('error', () => {
        cleanup();
        reject(new NetworkError('The part upload failed before the server answered.'));
      });
      request.addEventListener('abort', () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      });

      request.send(input.body);
    });
  }

  /** Shares ----------------------------------------------------------------- */

  createShare(body: CreateShareRequest, signal?: AbortSignal) {
    return this.request(`${API_PREFIX}/shares`, createdShareRecordSchema, {
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  revokeShare(shareId: string, signal?: AbortSignal): Promise<void> {
    return this.request(`${API_PREFIX}/shares/${shareId}`, emptySchema, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  /** Resolving a link needs no account; the token is the credential. */
  resolveShare(shareToken: string, signal?: AbortSignal): Promise<ResolveShareResponse> {
    return this.request(`${API_PREFIX}/shares/resolve`, resolveShareResponseSchema, {
      method: 'POST',
      headers: { [SHARE_TOKEN_HEADER]: shareToken },
      ...(signal ? { signal } : {}),
    });
  }

  /** API keys --------------------------------------------------------------- */

  listApiKeys(
    query: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<Page<ApiKeyRecord>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return this.request(`${API_PREFIX}/api-keys${suffix}`, apiKeyPageSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  createApiKey(body: { name: string; scopes: string[]; expiresAt: string | null }) {
    return this.request(`${API_PREFIX}/api-keys`, createdApiKeyRecordSchema, {
      method: 'POST',
      body,
    });
  }

  revokeApiKey(keyId: string): Promise<void> {
    return this.request(`${API_PREFIX}/api-keys/${keyId}`, emptySchema, { method: 'DELETE' });
  }

  /** Anonymous sessions ----------------------------------------------------- */

  createAnonymousSession(signal?: AbortSignal) {
    return this.request(`${API_PREFIX}/anonymous-sessions`, anonymousSessionResponseSchema, {
      method: 'POST',
      body: {},
      ...(signal ? { signal } : {}),
    });
  }
}

const emptySchema: Schema<undefined> = {
  safeParse: (value: unknown) => {
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    ) {
      return { success: true, data: undefined };
    }
    // A DELETE without a body legitimately answers with nothing; anything else is unexpected.
    return { success: false, error: { issues: [{ message: 'Expected an empty response body.' }] } };
  },
};

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonText(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export { ApiError, ContractError, NetworkError, problemFrom };
