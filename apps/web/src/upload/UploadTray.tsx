import { useState } from 'react';
import { LogPoseDial } from '../assets/LogPoseDial.js';
import { Icon } from '../components/Icon.js';
import { useUploadQueue, type UploadItem } from '../state/uploadQueue.js';
import { formatBytes } from '../lib/format.js';

/** Real transmitted fraction. Zero when the size is unknown; there is no smoothing here. */
function progressOf(item: UploadItem): number {
  if (item.sizeBytes <= 0) return 0;
  return item.uploadedBytes / item.sizeBytes;
}

/**
 * The upload tray — "the log pose".
 *
 * Docked at the bottom so browsing continues underneath, one row per file, and every row states
 * what is true: bytes actually sent, the phase the server is in, and a recovery action. A
 * deletion token is shown exactly once, where the API issued it, and never again.
 */
export function UploadTray() {
  const { items, busy, cancel, dismiss, clearFinished } = useUploadQueue();
  const finishedCount = items.filter(
    (item) => item.phase === 'ready' || item.phase === 'aborted' || item.phase === 'failed',
  ).length;
  const activeCount = items.length - finishedCount;
  // The dial in the header tracks the transfer actually in flight, not an average of the queue.
  const lead = items.find((item) => item.phase === 'uploading' || item.phase === 'finalizing');

  return (
    <section className="tray" aria-label="Uploads">
      <header className="tray__head">
        <Icon name="upload" size={16} />
        <h2 className="tray__title">
          Transfers
          <span className="tray__count">
            {activeCount > 0 ? ` — ${activeCount} active` : ` — ${finishedCount} finished`}
          </span>
        </h2>
        <div className="spacer" />
        {lead !== undefined && (
          <LogPoseDial progress={progressOf(lead)} phase={lead.phase} size={30} />
        )}
        <span className="tray__live" role="status" aria-live="polite">
          {busy ? 'Uploading' : 'Idle'}
        </span>
        {finishedCount > 0 && (
          <button type="button" className="btn btn--ghost" onClick={clearFinished}>
            Clear finished
          </button>
        )}
      </header>
      <ul className="tray__list">
        {items.map((item) => (
          <UploadRow key={item.id} item={item} onCancel={cancel} onDismiss={dismiss} />
        ))}
      </ul>
    </section>
  );
}

function phaseCopy(item: UploadItem): string {
  const percent =
    item.sizeBytes === 0
      ? 0
      : Math.min(100, Math.round((item.uploadedBytes / item.sizeBytes) * 100));
  switch (item.phase) {
    case 'queued':
      return 'Waiting';
    case 'uploading':
      return `${percent}% — ${formatBytes(item.uploadedBytes)} of ${formatBytes(item.sizeBytes)}`;
    case 'finalizing':
      return 'Finalizing — the server is assembling the object';
    case 'ready':
      return 'Ready';
    case 'aborted':
      return item.abortFailed === true ? 'Cancel requested (not confirmed)' : 'Cancelled';
    case 'failed':
      return item.error ?? 'Failed';
  }
}

function UploadRow({
  item,
  onCancel,
  onDismiss,
}: {
  item: UploadItem;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const percent =
    item.sizeBytes === 0
      ? 0
      : Math.min(100, Math.round((item.uploadedBytes / item.sizeBytes) * 100));
  const active =
    item.phase === 'queued' || item.phase === 'uploading' || item.phase === 'finalizing';
  const tone =
    item.phase === 'ready'
      ? 'ok'
      : item.phase === 'failed'
        ? 'danger'
        : item.phase === 'aborted'
          ? 'plain'
          : 'info';

  return (
    <li className={`tray__row tray__row--${item.phase}`}>
      <div className="tray__identity">
        <LogPoseDial progress={progressOf(item)} phase={item.phase} size={44} />
        <span className="tray__text">
          <span className="tray__name" title={item.name}>
            {item.name}
          </span>
          <span className="tray__meta mono">{formatBytes(item.sizeBytes)}</span>
        </span>
      </div>

      <div className="tray__progress">
        <span className={`tag tag--${tone}`}>{item.phase}</span>
        <div
          className="bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={item.phase === 'ready' ? 100 : percent}
          aria-label={`${item.name}: ${phaseCopy(item)}`}
        >
          <span
            className={`bar__fill${item.phase === 'failed' ? ' bar__fill--danger' : ''}`}
            style={{ width: `${item.phase === 'ready' ? 100 : percent}%` }}
          />
        </div>
        <span className="tray__state">{phaseCopy(item)}</span>
      </div>

      <div className="tray__actions">
        {item.deletionToken !== null && item.phase === 'ready' && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(item.deletionToken ?? '')
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
            title="This token is shown once. Without it, only the deleting account can remove the file."
          >
            <Icon name="key" size={15} />
            {copied ? 'Token copied' : 'Copy deletion token'}
          </button>
        )}
        {active && (
          <button type="button" className="btn btn--ghost" onClick={() => onCancel(item.id)}>
            Cancel
          </button>
        )}
        {!active && (
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => onDismiss(item.id)}
            aria-label={`Dismiss ${item.name}`}
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      {item.deletionToken !== null && item.phase === 'ready' && (
        <p className="tray__warning">
          <Icon name="shield" size={14} />
          Anonymous upload: this deletion token is the only credential that can remove this file
          later. It is shown once and cannot be recovered — store it now if you need it.
        </p>
      )}
      {item.phase === 'aborted' && item.abortFailed && (
        <p className="tray__warning tray__warning--danger">
          <Icon name="alert" size={14} />
          Cancelling did not reach the API. The upload session may still exist until it expires;
          nothing here pretends otherwise.
        </p>
      )}
    </li>
  );
}
