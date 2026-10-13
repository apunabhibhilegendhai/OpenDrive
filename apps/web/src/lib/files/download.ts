import type { ApiClient } from '../api/client.js';

/**
 * Save a file's bytes.
 *
 * Where the browser exposes the File System Access API, the response body is piped straight to
 * disk, so a large object never has to be held in memory. Everywhere else the response is
 * buffered into a Blob and handed to the browser; that is a real limitation of the platform and
 * it is stated rather than hidden.
 */
export type DownloadOutcome =
  { kind: 'saved'; filename: string; streamed: boolean } | { kind: 'cancelled' };

export async function downloadFileContent(
  client: ApiClient,
  file: { id: string; filename: string },
  signal?: AbortSignal,
): Promise<DownloadOutcome> {
  const response = await client.openContent(file.id, signal);
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
      if (response.body !== null) {
        await response.body.pipeTo(writable);
      } else {
        await writable.write(await response.blob());
        await writable.close();
      }
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return { kind: 'saved', filename: handle.name ?? file.filename, streamed: true };
  }

  const blob = await response.blob();
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
