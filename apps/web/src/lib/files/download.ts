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
 * This is a ceiling, not a promise: the request is time-boxed (see
 * {@link DOWNLOAD_WINDOW_BUDGET_MS}), so a slow object simply fills less of it before the client
 * stops reading and continues from wherever it got to. A fast object fills it and needs fewer
 * round trips.
 */
export const DOWNLOAD_WINDOW_BYTES = 64 * 1024 * 1024;

/**
 * How long a single ranged request may run before the client stops reading and keeps what arrived.
 *
 * The edge proxy in front of the API cuts a request at ~100 s and answers Cloudflare `524`. A
 * document the storage provider has not cached yet can stream far slower than any fixed byte
 * window assumes - which is exactly how an 862 MiB download died on its first 64 MiB window. A time
 * box inverts the trade: every request finishes well inside the edge timeout, whatever reached the
 * client is a contiguous prefix of the file, and the next request continues from there. A download
 * therefore always makes forward progress, however poor the throughput.
 */
export const DOWNLOAD_WINDOW_BUDGET_MS = 30_000;

/** Attempts per window, including the first. A ranged GET is idempotent, so a retry is safe. */
const DOWNLOAD_WINDOW_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15_000;

/** Exponential backoff with jitter, so a recovering origin is not hammered in lockstep. */
function retryDelay(attempt: number, baseMs: number): number {
  const grown = Math.min(baseMs * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  return Math.round(grown * (0.7 + Math.random() * 0.6));
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Waits `ms`, rejecting promptly if the download was cancelled meanwhile. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface DownloadOptions {
  /** Override the request window ceiling. Only tests need this; production uses the constant. */
  windowBytes?: number;
  /** Override the per-request time budget. Only tests need this; production uses the constant. */
  windowBudgetMs?: number;
  /** Override the retry backoff base. Only tests need this; production uses the constant. */
  retryBaseDelayMs?: number;
}

/** The file shape a download needs. `sizeBytes` may be unknown; then a single request is used. */
export type DownloadTarget = { id: string; filename: string; sizeBytes?: number };

/** A read that produced a chunk, a read that finished, or a read the time budget ran out on. */
type ReadOutcome = { done: boolean; value?: Uint8Array<ArrayBuffer> } | 'budget';

/**
 * Reads one chunk, giving up with `'budget'` when `deadlineAt` passes first.
 *
 * A non-finite deadline means "no budget" (used for a whole-object fallback, which cannot be
 * resumed and so must be read to the end). The caller's `signal` still cancels it promptly.
 */
function readBefore(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (outcome: ReadOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = (): void => fail(abortError());

    const remaining = deadlineAt - Date.now();
    if (Number.isFinite(remaining)) {
      if (remaining <= 0) {
        settle('budget');
        return;
      }
      timer = setTimeout(() => settle('budget'), remaining);
    }
    if (signal?.aborted) {
      fail(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader
      .read()
      .then(
        (result) =>
          settle(
            result.value === undefined
              ? { done: result.done }
              : { done: false, value: result.value },
          ),
        fail,
      );
  });
}

/**
 * Writes a `206` body to the sink until it ends or the budget passes, returning the byte count.
 *
 * A read that fails *after* some bytes landed is not treated as an error: those bytes are the start
 * of the requested range, so the caller advances by them and asks for the rest. Only a failure that
 * delivered nothing is rethrown, so the retry loop can try the same offset again.
 */
async function pumpWindowBody(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const body = response.body;
  if (body === null) throw new NetworkError('The download response had no body.');
  const reader = body.getReader();
  let written = 0;
  try {
    for (;;) {
      let outcome: ReadOutcome;
      try {
        outcome = await readBefore(reader, deadlineAt, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (written > 0) return written;
        throw error;
      }
      if (outcome === 'budget') return written;
      if (outcome.done) return written;
      if (outcome.value !== undefined) {
        await writer.write(outcome.value);
        written += outcome.value.byteLength;
      }
    }
  } finally {
    // Stop the network side; the response is not reused once a window is done or abandoned.
    await reader.cancel().catch(() => undefined);
  }
}

/** Writes an entire (unranged) body, used when a server ignores `Range` and sends the object. */
async function pipeWholeBody(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const body = response.body;
  if (body === null) throw new NetworkError('The download response had no body.');
  const reader = body.getReader();
  try {
    for (;;) {
      const outcome = await readBefore(reader, Number.POSITIVE_INFINITY, signal);
      if (outcome === 'budget' || outcome.done) return;
      if (outcome.value !== undefined) await writer.write(outcome.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The window that starts at `offset`, clamped to the object. */
function windowAt(offset: number, total: number, windowBytes: number): ByteRange {
  return { start: offset, endInclusive: Math.min(offset + windowBytes, total) - 1 };
}

interface WindowResult {
  /** Bytes written for this window. */
  written: number;
  /** True when the server ignored `Range` and the whole object was written instead. */
  whole: boolean;
}

/**
 * Copies one window, retrying a transient failure with backoff.
 *
 * Each attempt carries its own abort controller so the time budget can cut a slow or stalled
 * response; the bytes read before that cut are returned as progress. The first window may come back
 * `200` instead of `206` if a (proxy, server) pair ignored `Range`; that whole body is written and
 * reported, so the caller finishes. Once a window has been written from a range, a later
 * whole-object answer would corrupt the file, so it is refused rather than appended.
 */
async function copyWindow(
  client: ApiClient,
  fileId: string,
  range: ByteRange,
  writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>,
  budgetMs: number,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<WindowResult> {
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const deadlineAt = Date.now() + budgetMs;
    let budgetFired = false;
    const timer = setTimeout(() => {
      budgetFired = true;
      controller.abort();
    }, budgetMs);
    const onOuterAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const response = await client.openContent(fileId, { range, signal: controller.signal });
      if (response.status !== 206) {
        if (range.start !== 0) {
          throw new NetworkError(
            'The server stopped honouring range requests during the download.',
          );
        }
        // An unranged body cannot be resumed, so it is read without a budget.
        clearTimeout(timer);
        await pipeWholeBody(response, writer, signal);
        return { written: 0, whole: true };
      }
      const written = await pumpWindowBody(response, writer, deadlineAt, signal);
      if (written === 0) throw new NetworkError('The download window delivered no bytes.');
      return { written, whole: false };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      // Retry only what the network can recover from: our own budget abort, or an edge 5xx/429. A
      // failure to write to disk is deliberately excluded - re-requesting would duplicate bytes.
      const timedOut = budgetFired && error instanceof DOMException && error.name === 'AbortError';
      if (attempt >= DOWNLOAD_WINDOW_ATTEMPTS || !(timedOut || isTransientFailure(error))) {
        throw error;
      }
      await wait(retryDelay(attempt, retryBaseDelayMs), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** Copies the object to a writable sink window by window, advancing by the bytes actually written. */
async function copyInWindows(
  client: ApiClient,
  file: DownloadTarget,
  writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>,
  windowBytes: number,
  budgetMs: number,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const total = file.sizeBytes;
  if (total === undefined || total <= 0) {
    const response = await client.openContent(file.id, signal ? { signal } : {});
    await pipeWholeBody(response, writer, signal);
    return;
  }

  let offset = 0;
  while (offset < total) {
    const result = await copyWindow(
      client,
      file.id,
      windowAt(offset, total, windowBytes),
      writer,
      budgetMs,
      retryBaseDelayMs,
      signal,
    );
    if (result.whole) return;
    offset += result.written;
  }
}

/** Streams the object to disk window by window, closing the writable when it is complete. */
async function writeInWindows(
  client: ApiClient,
  file: DownloadTarget,
  writable: WritableStream<Uint8Array<ArrayBuffer>>,
  windowBytes: number,
  budgetMs: number,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await copyInWindows(client, file, writer, windowBytes, budgetMs, retryBaseDelayMs, signal);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

/** Fetches the object window by window and returns the pieces to assemble into one Blob. */
async function fetchInWindows(
  client: ApiClient,
  file: DownloadTarget,
  windowBytes: number,
  budgetMs: number,
  retryBaseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const writable = new WritableStream<Uint8Array<ArrayBuffer>>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  const writer = writable.getWriter();
  try {
    await copyInWindows(client, file, writer, windowBytes, budgetMs, retryBaseDelayMs, signal);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
  return chunks;
}

export async function downloadFileContent(
  client: ApiClient,
  file: DownloadTarget,
  signal?: AbortSignal,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const windowBytes = options.windowBytes ?? DOWNLOAD_WINDOW_BYTES;
  const budgetMs = options.windowBudgetMs ?? DOWNLOAD_WINDOW_BUDGET_MS;
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
      await writeInWindows(client, file, writable, windowBytes, budgetMs, retryBaseDelayMs, signal);
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return { kind: 'saved', filename: handle.name ?? file.filename, streamed: true };
  }

  const blob = new Blob(
    await fetchInWindows(client, file, windowBytes, budgetMs, retryBaseDelayMs, signal),
  );
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
