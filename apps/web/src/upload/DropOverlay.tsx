import { useEffect, useState, type DragEvent } from 'react';
import { Icon } from '../components/Icon.js';
import { formatBytes } from '../lib/format.js';

/**
 * Drop target for whole-file uploads.
 *
 * Counting drag events is the only reliable way to know when a drag has left the window, so the
 * counter guards against the overlay flickering on every child element. Dropped files go through
 * exactly the same validation as the file picker.
 */
export function DropOverlay({
  enabled,
  folderLabel,
  maxFileSizeBytes,
  onFiles,
}: {
  enabled: boolean;
  folderLabel: string;
  maxFileSizeBytes: number | null;
  onFiles: (files: File[]) => void;
}) {
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setDepth(0);
      return;
    }
    const onDragEnter = (event: DragEvent | globalThis.DragEvent) => {
      if (!('dataTransfer' in event) || event.dataTransfer === null) return;
      if (![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      setDepth((value) => value + 1);
    };
    const onDragOver = (event: globalThis.DragEvent) => {
      if (event.dataTransfer === null) return;
      if (![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
    };
    const onDragLeave = () => setDepth((value) => Math.max(0, value - 1));
    const onDrop = (event: globalThis.DragEvent) => {
      event.preventDefault();
      setDepth(0);
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [enabled]);

  if (!enabled || depth === 0) return null;

  return (
    <div
      className="dropzone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        setDepth(0);
        const dropped = [...event.dataTransfer.files];
        if (dropped.length > 0) onFiles(dropped);
      }}
    >
      <div className="dropzone__card">
        <Icon name="upload" size={26} />
        <p className="dropzone__title">Drop to upload into {folderLabel}</p>
        <p className="dropzone__note">
          {maxFileSizeBytes === null
            ? 'The deployment ceiling is still loading.'
            : `This deployment accepts files up to ${formatBytes(maxFileSizeBytes)}. Anything larger is refused before a byte moves.`}
        </p>
      </div>
    </div>
  );
}
