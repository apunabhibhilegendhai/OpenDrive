import type { FileRecord } from '@opendrive/shared';

/**
 * One place that decides how a file's state is worded and coloured, so a list row, a grid tile
 * and the inspector can never disagree about what a file's state is.
 *
 * State is always expressed as a word plus a colour, never by colour alone.
 */
export function fileStatusTag(file: Pick<FileRecord, 'status' | 'scanState'>): {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'plain';
} {
  // A scan verdict outranks the file state: an infected or unscannable object must never read
  // as an ordinary healthy upload, whatever the row says.
  if (file.scanState === 'infected') return { label: 'infected', tone: 'danger' };
  if (file.scanState === 'error') return { label: 'scan error', tone: 'danger' };

  switch (file.status) {
    case 'ready':
      return { label: 'ready', tone: 'ok' };
    case 'uploaded':
      return file.scanState === 'pending'
        ? { label: 'scan pending', tone: 'warn' }
        : { label: 'uploaded', tone: 'info' };
    case 'uploading':
      return { label: 'uploading', tone: 'info' };
    case 'pending_upload':
      return { label: 'pending', tone: 'plain' };
    case 'scanning':
      return { label: 'scanning', tone: 'info' };
    case 'failed':
      return { label: 'failed', tone: 'danger' };
    case 'deleting':
      return { label: 'deleting', tone: 'warn' };
    case 'deleted':
      return { label: 'deleted', tone: 'plain' };
    default:
      return { label: String(file.status), tone: 'plain' };
  }
}

/**
 * Whether the API will serve this file's bytes right now.
 *
 * Mirrors the server's `isServable`: `ready`, or `uploaded` while scanning is disabled — and
 * never a file whose scan verdict is infected or failed, because an error is not a pass.
 */
export function isDownloadable(file: Pick<FileRecord, 'status' | 'scanState'>): boolean {
  if (file.scanState === 'infected' || file.scanState === 'error') return false;
  return file.status === 'ready' || file.status === 'uploaded';
}

export function formatWhen(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
