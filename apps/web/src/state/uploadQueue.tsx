import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LimitsResponse } from '@opendrive/shared';
import {
  describeFailure,
  isApiError,
  isAuthFailure,
  isTransientFailure,
} from '../lib/api/errors.js';
import type { ApiClient, CompleteUploadOutcome } from '../lib/api/client.js';
import { useApi, useSession } from '../lib/auth/session.js';
import { sha256HexOfBlob } from '../lib/upload/checksum.js';
import { planForFile } from '../lib/upload/plan.js';
import {
  deleteSession,
  fileFingerprint,
  loadSession,
  saveSession,
} from '../lib/upload/sessionStore.js';

/** Best-effort MIME guess when the browser reports an empty type, keyed to the file extension. */
function guessMimeTypeFromFilename(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'ts':
    case 'm2ts':
    case 'mts':
    case 'm2t':
      return 'video/mp2t';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'ogv':
    case 'ogg':
      return 'video/ogg';
    case 'mov':
      return 'video/quicktime';
    case 'avi':
      return 'video/x-msvideo';
    case 'mkv':
      return 'video/x-matroska';
    case 'mpg':
    case 'mpeg':
      return 'video/mpeg';
    case '3gp':
      return 'video/3gpp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * The upload queue.
 *
 * One file at a time, part by part, with the numbers a person can trust:
 *
 *   * `uploadedBytes` counts bytes the browser has handed to the socket for accepted parts.
 *     There is no easing, no interpolation and no advance past what was sent.
 *   * `ready` is only ever set after `POST /uploads/:id/complete` answers, because that is the
 *     point at which the object exists. Before that the state is `finalizing`.
 *   * `failed` and `aborted` say which happened and why. A part send and the finalize call are
 *     both idempotent, so those are retried through a transient edge failure — but nothing is
 *     retried blindly, and an upload never advances past bytes the server has not accepted.
 *
 * Aborting calls the real `DELETE /uploads/:id`; if that call fails, the item says so instead
 * of pretending the upload was cancelled cleanly.
 */
export type UploadPhase = 'queued' | 'uploading' | 'finalizing' | 'ready' | 'failed' | 'aborted';

export interface UploadItem {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  folderId: string | null;
  phase: UploadPhase;
  uploadedBytes: number;
  uploadId: string | null;
  fileId: string | null;
  error: string | null;
  deletionToken: string | null;
  abortFailed: boolean;
}

export interface UploadQueueValue {
  items: UploadItem[];
  busy: boolean;
  enqueue: (files: File[], folderId: string | null) => void;
  cancel: (localId: string) => void;
  retry: (localId: string) => void;
  dismiss: (localId: string) => void;
  clearFinished: () => void;
}

const UploadQueueContext = createContext<UploadQueueValue | null>(null);

/**
 * How long to wait between finalize polls. A large object is assembled and sent on the server
 * after the client's last part, so the client polls rather than holding one long request open.
 */
const FINALIZE_POLL_INTERVAL_MS = 3000;

/** Waits `ms`, rejecting promptly if the operation was cancelled meanwhile. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
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

/** Waits between finalize polls, rejecting promptly if the upload was cancelled meanwhile. */
function waitForFinalize(signal: AbortSignal): Promise<void> {
  return wait(FINALIZE_POLL_INTERVAL_MS, signal);
}

/**
 * Attempts per part, including the first send.
 *
 * A big file is many sequential long requests, so the chance that one of them meets a transient
 * edge blip grows with the size. A handful of retries with backoff turns "the upload died at part
 * five" into a couple of extra seconds.
 */
export const PART_RETRY_ATTEMPTS = 6;
const PART_RETRY_BASE_DELAY_MS = 1000;
const PART_RETRY_MAX_DELAY_MS = 15_000;

/** Rounds over the part list: a part that exhausts its retries resumes from server progress. */
const MAX_PART_ROUNDS = 3;

/**
 * Maximum parts uploaded concurrently.
 *
 * The API allows 600 parts/min (10/sec). With 4-8 concurrent we saturate typical connections
 * without hitting the limit. Cloudflare Tunnel + browser HTTP/2 multiplexing handles this well.
 */
export const UPLOAD_CONCURRENCY = 6;
export const MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;

export function concurrencyForParts(
  parts: readonly { sizeBytes: number }[],
  cap: number = UPLOAD_CONCURRENCY,
): number {
  if (parts.length === 0) return Math.max(1, cap);
  const minSize = Math.min(...parts.map((part) => part.sizeBytes));
  const byBudget = Math.floor(MAX_IN_FLIGHT_BYTES / Math.max(1, minSize));
  return Math.max(1, Math.min(cap, byBudget));
}

/** Attempts for a finalize poll, which is idempotent and therefore always safe to repeat. */
export const FINALIZE_RETRY_ATTEMPTS = 6;

/** Exponential backoff with jitter, so a recovering origin is not hammered in lockstep. */
function retryDelay(baseMs: number, attempt: number): number {
  if (baseMs <= 0) return 0;
  const grown = Math.min(baseMs * 2 ** (attempt - 1), PART_RETRY_MAX_DELAY_MS);
  return Math.round(grown * (0.7 + Math.random() * 0.6));
}

/**
 * A simple semaphore for limiting concurrent async operations.
 */
class Semaphore {
  #permits: number;
  #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return;
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  release(): void {
    this.#permits += 1;
    const next = this.#waiters.shift();
    if (next !== undefined) {
      this.#permits -= 1;
      next();
    }
  }
}

/**
 * Sends one part, retrying a transient failure.
 *
 * A retry keeps the same part number. If the failed attempt actually stored the part — a response
 * lost after the bytes landed — the server answers 409 (duplicate); that is treated as success,
 * because re-sending an identical part is exactly the idempotent case and failing the whole upload
 * over it would be worse. Every other failure (a refused size, a validation error) is final.
 */
export async function uploadPartWithRetry(
  api: ApiClient,
  params: Parameters<ApiClient['uploadPart']>[0],
  signal: AbortSignal,
  retryBaseDelayMs: number = PART_RETRY_BASE_DELAY_MS,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await api.uploadPart(params);
      return;
    } catch (error) {
      if (signal.aborted || isAuthFailure(error)) throw error;
      if (attempt > 1 && isApiError(error) && error.status === 409) return;
      if (!isTransientFailure(error) || attempt >= PART_RETRY_ATTEMPTS) throw error;
      await wait(retryDelay(retryBaseDelayMs, attempt), signal);
    }
  }
}

/**
 * Finalizes an upload, tolerating a transient failure on the way.
 *
 * `POST .../complete` is idempotent, so a lost response or a momentary 5xx must not fail an upload
 * whose bytes are already all on disk server-side. The queue calls this on every finalize poll.
 */
export async function completeUploadWithRetry(
  api: ApiClient,
  uploadId: string,
  signal: AbortSignal,
  retryBaseDelayMs: number = PART_RETRY_BASE_DELAY_MS,
): Promise<CompleteUploadOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.completeUpload(uploadId, signal);
    } catch (error) {
      if (signal.aborted || isAuthFailure(error)) throw error;
      if (!isTransientFailure(error) || attempt >= FINALIZE_RETRY_ATTEMPTS) throw error;
      await wait(retryDelay(retryBaseDelayMs, attempt), signal);
    }
  }
}

/** One part to send: its number, its length, its bytes and its checksum, when one was computed. */
export interface UploadPartToSend {
  readonly partNumber: number;
  readonly sizeBytes: number;
  readonly blob: Blob;
  readonly checksum?: string | (() => Promise<string | undefined>);
}

/**
 * Sends every part of one object: bounded concurrency, a retry per part, and a round across the
 * parts that exhaust theirs.
 *
 * Exported for the same reason `uploadPartWithRetry` is: the behaviour worth proving is not
 * decoration. A part that runs out of attempts is *re-sent in the next round* instead of being
 * quietly skipped and the object finalized with a hole in it, and the number handed to
 * `onProgress` is the sum of what has been confirmed plus what is in flight, so it can never step
 * backwards when a late part lands after an early one.
 *
 * `retryBaseDelayMs`, `concurrency` and `maxRounds` are injectable so a test can exercise all of
 * that without waiting a minute. Returns the bytes the server confirmed.
 */
export async function transferParts(options: {
  api: ApiClient;
  uploadId: string;
  parts: readonly UploadPartToSend[];
  signal: AbortSignal;
  onProgress?: (uploadedBytes: number) => void;
  concurrency?: number;
  retryBaseDelayMs?: number;
  maxRounds?: number;
  partsReceived?: readonly number[];
}): Promise<number> {
  const concurrency = options.concurrency ?? concurrencyForParts(options.parts, UPLOAD_CONCURRENCY);
  const retryBaseDelayMs = options.retryBaseDelayMs ?? PART_RETRY_BASE_DELAY_MS;
  const maxRounds = options.maxRounds ?? MAX_PART_ROUNDS;
  const totalBytes = options.parts.reduce((total, part) => total + part.sizeBytes, 0);

  /** Per-round claim state, plus the error that makes a round final rather than retryable. */
  type SendState = { claimed: boolean; fatalError?: Error };
  const parts: (UploadPartToSend & SendState)[] = options.parts.map((part) => ({
    ...part,
    claimed: false,
  }));

  const receivedParts = new Set<number>(options.partsReceived ?? []);
  // Bytes confirmed by the server, and — separately — what each part still in flight has handed to
  // the socket. Several parts are in the air at once, so the reported figure has to be the sum of
  // both; reporting only whichever part spoke last makes it jump backwards.
  const inFlightBytes = new Map<number, number>();
  let confirmedBytes = options.partsReceived === undefined
    ? 0
    : options.parts.reduce(
        (total, part) => total + (options.partsReceived!.includes(part.partNumber) ? part.sizeBytes : 0),
        0,
      );
  const report = (): void => {
    let inFlight = 0;
    for (const sent of inFlightBytes.values()) inFlight += sent;
    options.onProgress?.(Math.min(totalBytes, confirmedBytes + inFlight));
  };

  const hashSemaphore = new Semaphore(1);
  const checksumCache = new Map<number, string | undefined>();
  async function resolveChecksum(part: UploadPartToSend): Promise<string | undefined> {
    if (part.checksum === undefined) return undefined;
    if (typeof part.checksum !== 'function') return part.checksum;
    if (checksumCache.has(part.partNumber)) return checksumCache.get(part.partNumber);
    await hashSemaphore.acquire();
    try {
      if (!checksumCache.has(part.partNumber)) {
        checksumCache.set(part.partNumber, await part.checksum());
      }
      return checksumCache.get(part.partNumber);
    } finally {
      hashSemaphore.release();
    }
  }


  const semaphore = new Semaphore(concurrency);
  report();

  for (let round = 1; ; round += 1) {
    const missing = parts.filter((part) => !receivedParts.has(part.partNumber));
    if (missing.length === 0) break;
    // Parts are retried across rounds, so the claim flags from the previous round have to be
    // cleared. Leaving them set means every worker immediately finds nothing left to do: the round
    // ends having sent nothing, and the upload is finalized with parts still missing.
    for (const part of missing) part.claimed = false;

    let resuming = false;
    let fatalSeen = false;

    const workers = Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
      while (true) {
        const part = missing.find((candidate) => !candidate.claimed);
        if (part === undefined) break;
        part.claimed = true;

        await semaphore.acquire();
        try {
          if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          await uploadPartWithRetry(
            options.api,
            {
              uploadId: options.uploadId,
              partNumber: part.partNumber,
              body: part.blob,
              ...(part.checksum === undefined ? {} : { checksumSha256: await resolveChecksum(part) }),
              signal: options.signal,
              onProgress: (sent) => {
                // Held per part number, so it adds to the confirmed total instead of replacing it.
                inFlightBytes.set(part.partNumber, sent);
                report();
              },
            },
            options.signal,
            retryBaseDelayMs,
          );
          // Stored: its bytes belong to the confirmed total now, and its in-flight entry is
          // retired so the next report cannot count it twice.
          inFlightBytes.delete(part.partNumber);
          receivedParts.add(part.partNumber);
          confirmedBytes += part.sizeBytes;
          report();
        } catch (error) {
          // An unconfirmed part contributes nothing to the reported total.
          inFlightBytes.delete(part.partNumber);
          report();
          // A cancel or a definitive refusal is final. So is a transient failure once the rounds
          // are spent — only then is the part out of chances.
          if (
            options.signal.aborted ||
            isAuthFailure(error) ||
            !isTransientFailure(error) ||
            round >= maxRounds
          ) {
            fatalSeen = true;
            part.fatalError = error as Error;
          } else {
            resuming = true;
          }
        } finally {
          semaphore.release();
        }
      }
    });

    await Promise.all(workers);
    if (fatalSeen) {
      const fatal = parts.find((part) => part.fatalError !== undefined);
      if (fatal !== undefined) throw fatal.fatalError!;
    }
    if (!resuming) break;

    // Some parts exhausted their attempts this round; re-check server progress before resuming, so
    // the next round neither re-sends what has already landed nor counts it twice.
    const progress = await options.api
      .uploadStatus(options.uploadId, options.signal)
      .catch(() => null);
    if (progress !== null) {
      // The server names the parts it holds, so this is an exact answer rather than a guess: a
      // part listed here is never re-sent (the provider refuses a duplicate) and a part missing
      // from it always is.
      for (const partNumber of progress.partsReceived) receivedParts.add(partNumber);
      confirmedBytes = parts.reduce(
        (total, part) => total + (receivedParts.has(part.partNumber) ? part.sizeBytes : 0),
        0,
      );
      report();
    }
    await wait(retryDelay(retryBaseDelayMs, PART_RETRY_ATTEMPTS), options.signal);
  }

  return confirmedBytes;
}

export function useUploadQueue(): UploadQueueValue {
  const value = useContext(UploadQueueContext);
  if (value === null) throw new Error('useUploadQueue must be used inside <UploadQueueProvider>');
  return value;
}

export function UploadQueueProvider({
  limits,
  onUploadCompleted,
  children,
}: {
  limits: LimitsResponse | null;
  onUploadCompleted?: (fileId: string) => void;
  children: ReactNode;
}) {
  const api = useApi();
  const { epoch, rememberDeletionToken } = useSession();
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  // Open server sessions by local item id. An upload that ends without being finalized must
  // release its session: open sessions count against the per-principal cap, so an abandoned one is
  // exactly what makes the *next* attempt answer "at most N uploads may be open at once".
  const sessions = useRef(new Map<string, string>());
  const nextId = useRef(1);

  const patch = useCallback((localId: string, changes: Partial<UploadItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === localId ? { ...item, ...changes } : item)),
    );
  }, []);

  /**
   * Releases the server-side session for an item that will not be finalized.
   *
   * An upload that ends without completing — the person cancelled it, or every retry was spent —
   * leaves a session open on the API. Open sessions count against the small per-principal cap, so
   * an abandoned one is what turns one failed attempt into a refused next attempt. Releasing here
   * is idempotent (a session already gone answers 404, which the client treats as success) and
   * best-effort: if the call fails the server still expires the session on its own.
   */
  const releaseSession = useCallback(
    (localId: string, uploadId: string | null): void => {
      if (uploadId === null) return;
      sessions.current.delete(localId);
      void api.abortUpload(uploadId).catch(() => undefined);
    },
    [api],
  );

  const enqueue = useCallback(async (incoming: File[], folderId: string | null) => {
    const additions: UploadItem[] = incoming.map((file) => {
      const id = `up_${nextId.current}`;
      nextId.current += 1;
      files.current.set(id, file);
      return {
        id,
        name: file.name,
        sizeBytes: file.size,
        mimeType: file.type === '' ? guessMimeTypeFromFilename(file.name) : file.type,
        folderId,
        phase: 'queued',
        uploadedBytes: 0,
        uploadId: null,
        fileId: null,
        error: null,
        deletionToken: null,
        abortFailed: false,
      };
    });
    setItems((current) => [...current, ...additions]);
     await Promise.all(
       additions.map(async (item, index) => {
         const file = incoming[index];
         if (file === undefined) return;
         const persisted = await loadSession(fileFingerprint(file));
         if (persisted === null) return;
         if (new Date(persisted.expiresAt).getTime() <= Date.now()) {
           await deleteSession(fileFingerprint(file));
           return;
         }
         patch(item.id, {
           uploadId: persisted.uploadId,
           fileId: persisted.fileId,
           uploadedBytes: 0,
         });
       }),
     );
  }, []);

  /** Run one item to a terminal state. */
  const run = useCallback(
    async (item: UploadItem) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      const file = files.current.get(item.id);
      let uploadId: string | null = item.uploadId;
      try {
        if (limits === null) {
          patch(item.id, { phase: 'failed', error: 'The API limits have not loaded yet.' });
          return;
        }
        if (file === undefined) {
          patch(item.id, {
            phase: 'failed',
            error: 'The file is no longer available in this tab.',
          });
          return;
        }
        const clientPlan = planForFile(item.sizeBytes, limits);
        if (!clientPlan.ok) {
          patch(item.id, { phase: 'failed', error: clientPlan.reason });
          return;
        }

        const initiated = await api.initiateUpload(
          {
            filename: item.name,
            sizeBytes: item.sizeBytes,
            mimeType: item.mimeType,
            visibility: 'private',
            folderId: item.folderId,
          },
          controller.signal,
        );
        uploadId = initiated.uploadId;
        sessions.current.set(item.id, uploadId);
        patch(item.id, {
          uploadId: initiated.uploadId,
          fileId: initiated.fileId,
          phase: 'uploading',
        });
          void saveSession({
            fingerprint: fileFingerprint(file),
            uploadId: initiated.uploadId,
            fileId: initiated.fileId,
            partSizeBytes: initiated.chunkSizeBytes,
            sizeBytes: item.sizeBytes,
            name: item.name,
            mimeType: item.mimeType,
            folderId: item.folderId,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            updatedAt: Date.now(),
          });
        if (initiated.deletionToken !== undefined) {
          patch(item.id, { deletionToken: initiated.deletionToken });
          rememberDeletionToken(initiated.fileId, initiated.deletionToken);
        }

        // The server's part size governs; it may clamp the configured one.
        const partsPlan = planForFile(item.sizeBytes, {
          ...limits,
          chunkSizeBytes: initiated.chunkSizeBytes,
        });
        if (!partsPlan.ok) {
          patch(item.id, { phase: 'failed', error: partsPlan.reason });
          return;
        }

        // Prepare all part blobs and checksums up front so retries don't recompute them.
        const partData: UploadPartToSend[] = await Promise.all(
          partsPlan.parts.map(async (part) => {
            const blob = file.slice(part.start, part.end);
            const checksum = await sha256HexOfBlob(blob);
            return { partNumber: part.partNumber, sizeBytes: part.sizeBytes, blob, checksum };
          }),
        );

        // Sending the parts is one extracted, tested unit: bounded concurrency, a retry per part,
        // and a round over the parts that exhaust theirs. It reports bytes the server confirmed
        // plus bytes in flight, so the row never shows more or less than has really been sent.
        await transferParts({
          api,
          uploadId: initiated.uploadId,
          parts: partData,
          signal: controller.signal,
          onProgress: (uploadedBytes) => patch(item.id, { uploadedBytes }),
        });

        patch(item.id, { phase: 'finalizing' });
        let completed = await completeUploadWithRetry(api, initiated.uploadId, controller.signal);
        // A large object is assembled and sent on the server after the last part, so complete
        // answers `processing` and the file appears a little later; poll until it is ready.
        while (completed.status === 'processing') {
          patch(item.id, { uploadId: completed.uploadId, fileId: completed.fileId });
          await waitForFinalize(controller.signal);
          completed = await completeUploadWithRetry(api, completed.uploadId, controller.signal);
        }
        patch(item.id, {
          phase: 'ready',
          fileId: completed.file.id,
          uploadedBytes: item.sizeBytes,
        });
          void deleteSession(fileFingerprint(file));
        files.current.delete(item.id);
        sessions.current.delete(item.id);
        onUploadCompleted?.(completed.file.id);
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === 'AbortError') {
          // A user cancel (`cancel`) or a teardown releases the session itself; the run must not
          // race it with a second release.
          patch(item.id, { phase: 'aborted' });
          return;
        }
        // Every attempt was spent, so this session will never finalize on its own. Release it
        // before reporting the outcome, so the next attempt is not refused by this session.
        releaseSession(item.id, uploadId);
        patch(item.id, { phase: 'failed', error: describeFailure(failure) });
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [api, limits, onUploadCompleted, patch, releaseSession, rememberDeletionToken],
  );

  // The pump: one active upload, started whenever the queue has work and nothing is running.
  useEffect(() => {
    const busy = items.some((item) => item.phase === 'uploading' || item.phase === 'finalizing');
    if (busy) return;
    const next = items.find((item) => item.phase === 'queued');
    if (next === undefined) return;
    void run(next);
  }, [items, run]);

  // A sign-out or account switch discards the queue: the next principal must not inherit it.
  // Any session still open is released too, so the next principal does not start out already
  // holding this one's abandoned sessions against its own cap.
  useEffect(() => {
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      for (const uploadId of sessions.current.values()) {
        void api.abortUpload(uploadId).catch(() => undefined);
      }
      sessions.current.clear();
    };
  }, [epoch, api]);

  const cancel = useCallback(
    (localId: string) => {
      const item = items.find((candidate) => candidate.id === localId);
      if (item === undefined) return;
      const controller = controllers.current.get(localId);
      if (controller !== undefined) {
        controller.abort();
      }
      sessions.current.delete(localId);
      if (item.uploadId !== null && item.phase !== 'ready') {
        void api.abortUpload(item.uploadId).catch(() => {
          patch(localId, {
            phase: 'aborted',
            abortFailed: true,
            error:
              'The cancel request did not reach the API; the session may still be open server-side.',
          });
        });
      }
      if (controller === undefined) patch(localId, { phase: 'aborted' });
      files.current.delete(localId);
    },
    [api, items, patch],
  );

   const retry = useCallback(
     (localId: string) => {
       const item = items.find((candidate) => candidate.id === localId);
       if (item === undefined || item.phase !== 'failed') return;
       if (!files.current.has(localId)) {
         patch(localId, {
           error: 'The file is no longer available in this tab; pick it again to resume.',
         });
         return;
       }
       patch(localId, { phase: 'queued', error: null });
     },
     [items, patch],
   );

  const dismiss = useCallback((localId: string) => {
    files.current.delete(localId);
    setItems((current) => current.filter((item) => item.id !== localId));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((current) =>
      current.filter(
        (item) => item.phase !== 'ready' && item.phase !== 'aborted' && item.phase !== 'failed',
      ),
    );
  }, []);

  const busy = items.some((item) => item.phase === 'uploading' || item.phase === 'finalizing');

  const value = useMemo<UploadQueueValue>(
    () => ({ items, busy, enqueue, cancel, retry, dismiss, clearFinished }),
    [items, busy, enqueue, cancel, retry, dismiss, clearFinished],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}
