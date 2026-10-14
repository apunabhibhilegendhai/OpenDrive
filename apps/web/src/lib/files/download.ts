import type { ByteRange } from '@opendrive/shared';
import type { ApiClient } from '../api/client.js';
import { NetworkError, isTransientFailure } from '../api/errors.js';

/**
 * Save a file's bytes.
 *
 * Where the browser exposes the File System Access API, the object is fetched in bounded windows
 * and each window is written straight to disk: a multi-gigabyte download neither sits in memory
 * nor depends on one long-lived request that an edge proxy will cut, and a window that fails
 * transiently is retried rather than restarting the whole file. Everywhere else the response is
 * buffered into a Blob and handed to the browser; that is a real limitation of the platform and
 * it is stated rather than hidden.
 */
export type DownloadOutcome =
  { kind: 'saved'; filename: string; streamed: boolean } | { kind: 'cancelled' };

/**
 * How much of an object one ranged request asks for.
 *
 * Chosen to stay well inside an edge proxy's request window: the content route used to stream a
 * whole object in one response, which for a ~862 MiB file exceeded Cloudflare's ~100 s origin
 * timeout and surfaced as a `524`. A bounded window is a request that always finishes.
 */
export const DOWNLOAD_WINDOW_BYTES = 64 * 1024 * 1024;

/** Attempts per window, including the first. A ranged GET is idempotent, so a retry is safe. */
const DOWNLOAD_WINDOW_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15_000;

/** Exponential backoff with jitter, so a recovering origin is not hammered in lockstep. */
function retryDelay(attempt: number, baseMs: number): number {
  const grown = Math.min(baseMs * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  return Math.round(grown * (0.7 + Math.random() * 0.6));
}

/** Waits `ms`, rejecting promptly if the download was cancelled meanwhile. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface DownloadOptions {
  /** Override the request window size. Only tests need this; production uses the constant. */
  windowBytes?: number;
  /** Override the retry backoff base. Only tests need this; production uses the constant. */
  retryBaseDelayMs?: number;
}

/** The file shape a download needs. `sizeBytes` may be unknown; then a single request is used. */
export type DownloadTarget = { id: string; filename: string; sizeBytes?: number };

/** One ranged request, retrying a transient failure with backoff. */
async function openWindow(
  client: ApiClient,
  fileId: string,
  range: ByteRange,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.openContent(fileId, {
        range,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted || attempt >= DOWNLOAD_WINDOW_ATTEMPTS || !isTransientFailure(error)) {
        throw error;
      }
      await wait(retryDelay(attempt, retryBaseDelayMs), signal);
    }
  }
}

/** The window that starts at `offset`, clamped to the object. */
function windowAt(offset: number, total: number, windowBytes: number): ByteRange {
  return { start: offset, endInclusive: Math.min(offset + windowBytes, total) - 1 };
}

/**
 * Copies the object to a writable sink window by window.
 *
 * The first window may come back `200` instead of `206` if a (proxy, server) pair ignored the
 * `Range` header; that is handled honestly by writing the whole body and finishing. Once a window
 * has been written from a range, a later whole-object answer would corrupt the file, so it is
 * refused rather than appended.
 */
async function writeInWindows(
  client: ApiClient,
  file: DownloadTarget,
  writable: WritableStream<Uint8Array>,
  windowBytes: number,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const total = file.sizeBytes;
  if (total === undefined || total <= 0) {
    const response = await client.openContent(file.id, signal ? { signal } : {});
    if (response.body === null) throw new NetworkError('The download response had no body.');
    await response.body.pipeTo(writable);
    return;
  }

  let offset = 0;
  while (offset < total) {
    const response = await openWindow(
      client,
      file.id,
      windowAt(offset, total, windowBytes),
      retryBaseDelayMs,
      signal,
    );
    if (response.body === null) throw new NetworkError('The download response had no body.');
    if (response.status !== 206) {
      if (offset !== 0) {
        throw new NetworkError('The server stopped honouring range requests during the download.');
      }
      // The server ignored `Range` and sent the whole object; write it and finish.
      await response.body.pipeTo(writable);
      return;
    }
    await response.body.pipeTo(writable, { preventClose: true });
    offset += windowBytes;
  }
  await writable.close();
}

/** Fetches the object window by window and returns the pieces to assemble into one Blob. */
async function fetchInWindows(
  client: ApiClient,
  file: DownloadTarget,
  windowBytes: number,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<BlobPart[]> {
  const total = file.sizeBytes;
  if (total === undefined || total <= 0) {
    const response = await client.openContent(file.id, signal ? { signal } : {});
    return [await response.blob()];
  }

  const parts: BlobPart[] = [];
  let offset = 0;
  while (offset < total) {
    const response = await openWindow(
      client,
      file.id,
      windowAt(offset, total, windowBytes),
      retryBaseDelayMs,
      signal,
    );
    const blob = await response.blob();
    if (response.status !== 206) {
      if (offset !== 0) {
        throw new NetworkError('The server stopped honouring range requests during the download.');
      }
      return [blob];
    }
    parts.push(blob);
    offset += windowBytes;
  }
  return parts;
}

export async function downloadFileContent(
  client: ApiClient,
  file: DownloadTarget,
  signal?: AbortSignal,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const windowBytes = options.windowBytes ?? DOWNLOAD_WINDOW_BYTES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  const picker = saveFilePicker();

  if (picker !== undefined) {
    const handle = await picker({ suggestedName: file.filename }).catch((error: unknown) => {
      // The picker closes with AbortError when the person cancels: that is not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    });
    if (handle === null) return { kind: 'cancelled' };
    const writable = await handle.createWritable();
    try {
      await writeInWindows(client, file, writable, windowBytes, retryBaseDelayMs, signal);
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return { kind: 'saved', filename: handle.name ?? file.filename, streamed: true };
  }

  const blob = new Blob(await fetchInWindows(client, file, windowBytes, retryBaseDelayMs, signal));
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { kind: 'saved', filename: file.filename, streamed: false };
}

export function saveFilePicker():
  ((options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>) | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.showSaveFilePicker;
}

/** True where the browser can stream a download straight to disk instead of buffering it. */
export function supportsSaveFilePicker(): boolean {
  return saveFilePicker() !== undefined;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  }
}
