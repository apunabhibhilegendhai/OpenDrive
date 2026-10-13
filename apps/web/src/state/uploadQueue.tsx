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
import { NetworkError, describeFailure, isApiError, isAuthFailure } from '../lib/api/errors.js';
import type { ApiClient } from '../lib/api/client.js';
import { useApi, useSession } from '../lib/auth/session.js';
import { sha256HexOfBlob } from '../lib/upload/checksum.js';
import { planForFile } from '../lib/upload/plan.js';

/**
 * The upload queue.
 *
 * One file at a time, part by part, with the numbers a person can trust:
 *
 *   * `uploadedBytes` counts bytes the browser has handed to the socket for accepted parts.
 *     There is no easing, no interpolation and no advance past what was sent.
 *   * `ready` is only ever set after `POST /uploads/:id/complete` answers, because that is the
 *     point at which the object exists. Before that the state is `finalizing`.
 *   * `failed` and `aborted` say which happened and why; nothing is silently retried, because
 *     the API has no idempotency contract for a completed upload.
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

/** Statuses worth retrying: the edge answered, but the origin did not serve the part. */
const RETRYABLE_PART_STATUSES = new Set([500, 502, 503, 504]);
const PART_RETRY_ATTEMPTS = 3;
const PART_RETRY_DELAY_MS = 1000;

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
  retryDelayMs: number = PART_RETRY_DELAY_MS,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await api.uploadPart(params);
      return;
    } catch (error) {
      if (signal.aborted || isAuthFailure(error)) throw error;
      if (attempt > 1 && isApiError(error) && error.status === 409) return;
      const transient =
        error instanceof NetworkError ||
        (isApiError(error) && RETRYABLE_PART_STATUSES.has(error.status));
      if (!transient || attempt >= PART_RETRY_ATTEMPTS) throw error;
      await wait(retryDelayMs, signal);
    }
  }
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
  const nextId = useRef(1);

  const patch = useCallback((localId: string, changes: Partial<UploadItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === localId ? { ...item, ...changes } : item)),
    );
  }, []);

  const enqueue = useCallback((incoming: File[], folderId: string | null) => {
    const additions: UploadItem[] = incoming.map((file) => {
      const id = `up_${nextId.current}`;
      nextId.current += 1;
      files.current.set(id, file);
      return {
        id,
        name: file.name,
        sizeBytes: file.size,
        mimeType: file.type === '' ? 'application/octet-stream' : file.type,
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
  }, []);

  /** Run one item to a terminal state. */
  const run = useCallback(
    async (item: UploadItem) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      const file = files.current.get(item.id);
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
        patch(item.id, {
          uploadId: initiated.uploadId,
          fileId: initiated.fileId,
          phase: 'uploading',
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

        let uploadedBytes = 0;
        for (const part of partsPlan.parts) {
          const blob = file.slice(part.start, part.end);
          const checksum = await sha256HexOfBlob(blob);
          await uploadPartWithRetry(
            api,
            {
              uploadId: initiated.uploadId,
              partNumber: part.partNumber,
              body: blob,
              ...(checksum === undefined ? {} : { checksumSha256: checksum }),
              signal: controller.signal,
              onProgress: (sent) => {
                patch(item.id, { uploadedBytes: uploadedBytes + sent });
              },
            },
            controller.signal,
          );
          uploadedBytes = part.end;
          patch(item.id, { uploadedBytes });
        }

        patch(item.id, { phase: 'finalizing' });
        let completed = await api.completeUpload(initiated.uploadId, controller.signal);
        // A large object is assembled and sent on the server after the last part, so complete
        // answers `processing` and the file appears a little later; poll until it is ready.
        while (completed.status === 'processing') {
          patch(item.id, { uploadId: completed.uploadId, fileId: completed.fileId });
          await waitForFinalize(controller.signal);
          completed = await api.completeUpload(completed.uploadId, controller.signal);
        }
        patch(item.id, {
          phase: 'ready',
          fileId: completed.file.id,
          uploadedBytes: item.sizeBytes,
        });
        files.current.delete(item.id);
        onUploadCompleted?.(completed.file.id);
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === 'AbortError') {
          patch(item.id, { phase: 'aborted' });
          return;
        }
        patch(item.id, { phase: 'failed', error: describeFailure(failure) });
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [api, limits, onUploadCompleted, patch, rememberDeletionToken],
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
  useEffect(() => {
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    };
  }, [epoch]);

  const cancel = useCallback(
    (localId: string) => {
      const item = items.find((candidate) => candidate.id === localId);
      if (item === undefined) return;
      const controller = controllers.current.get(localId);
      if (controller !== undefined) {
        controller.abort();
      }
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
    () => ({ items, busy, enqueue, cancel, dismiss, clearFinished }),
    [items, busy, enqueue, cancel, dismiss, clearFinished],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}
