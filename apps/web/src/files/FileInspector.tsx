import type { FileRecord } from '@opendrive/shared';
import { Icon } from '../components/Icon.js';
import type { ApiClient } from '../lib/api/client.js';
import { formatBytes } from '../lib/format.js';
import { isDownloadable, formatTimestamp } from './presentation.js';
import { styleForMime } from '../lib/files/kind.js';
import { FilePreview } from './FilePreview.js';

/**
 * The inspector — "field notes" on one file.
 *
 * It shows exactly the metadata the API returned and nothing else: no invented thumbnails, no
 * assumed properties, no action the API cannot perform. Rename and move are listed as
 * unavailable, with the reason, because a person will look for them and a missing button is
 * less honest than a disabled one that explains itself.
 */
export function FileInspector({
  api,
  file,
  folderPath,
  onClose,
  onDownload,
  onDelete,
  onShare,
  onRevokeShare,
  downloadsBusy,
  shares,
  anonymous,
}: {
  api: ApiClient;
  file: FileRecord;
  folderPath: string;
  onClose: () => void;
  onDownload: (file: FileRecord) => void;
  onDelete: (file: FileRecord) => void;
  onShare: (file: FileRecord) => void;
  onRevokeShare: (shareId: string) => void;
  downloadsBusy: boolean;
  shares: { id: string; kind: string; downloadCount: number; expiresAt: string | null }[];
  anonymous: boolean;
}) {
  const downloadable = isDownloadable(file);
  const style = styleForMime(file.mimeType);

  return (
    <aside className="inspector" aria-label={`Details for ${file.filename}`}>
      <header className="inspector__head">
        <span className="label">Field notes</span>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onClose}
          aria-label="Close details"
        >
          <Icon name="close" />
        </button>
      </header>

      <h3 className="inspector__name" title={file.filename}>
        {file.filename}
      </h3>
      <p className="inspector__family" style={{ color: `var(${style.token})` }}>
        {style.label} · {file.mimeType}
      </p>

      {downloadable && <FilePreview api={api} file={file} />}

      <dl className="inspector__facts">
        <div>
          <dt>Size</dt>
          <dd className="mono">{formatBytes(file.sizeBytes)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            <span className="tag tag--plain">{file.status}</span>
            {file.scanState !== 'clean' && file.scanState !== 'not_scanned' && (
              <span className="tag tag--warn">scan: {file.scanState}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Visibility</dt>
          <dd>{file.visibility}</dd>
        </div>
        <div>
          <dt>Folder</dt>
          <dd>{folderPath}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{formatTimestamp(file.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatTimestamp(file.updatedAt)}</dd>
        </div>
        <div>
          <dt>Checksum</dt>
          <dd className="mono inspector__hash" title={file.checksumSha256 ?? 'not recorded'}>
            {file.checksumSha256 ?? 'not recorded'}
          </dd>
        </div>
      </dl>

      <div className="inspector__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => onDownload(file)}
          disabled={!downloadable || downloadsBusy}
          title={
            downloadable
              ? 'Download this file'
              : `A file in state "${file.status}" has no readable object.`
          }
        >
          <Icon name="download" size={16} />
          Download
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onShare(file)}
          disabled={!downloadable}
          title={downloadable ? 'Create a share link' : 'Only a servable file can be shared'}
        >
          <Icon name="link" size={16} />
          Create link
        </button>
        <button type="button" className="btn btn--danger" onClick={() => onDelete(file)}>
          <Icon name="trash" size={16} />
          Delete
        </button>
      </div>

      {!downloadable && (
        <p className="inspector__note">
          <Icon name="alert" size={14} />
          The API will not serve bytes for a file in this state, so download and sharing are
          disabled here rather than failing later.
        </p>
      )}

      {shares.length > 0 && (
        <section className="inspector__shares">
          <h4 className="label">Links created in this tab</h4>
          <ul className="inspector__share-list">
            {shares.map((share) => (
              <li key={share.id}>
                <span className="mono">{share.kind}</span>
                <span className="dim">
                  {share.downloadCount} download{share.downloadCount === 1 ? '' : 's'}
                  {share.expiresAt === null ? '' : ` · expires ${formatTimestamp(share.expiresAt)}`}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => onRevokeShare(share.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          <p className="inspector__note">
            The API does not expose a list of existing share links, so this list only contains links
            created in this tab during this session.
          </p>
        </section>
      )}

      <section className="inspector__unavailable">
        <h4 className="label">Not available yet</h4>
        <ul>
          <li>Rename or move this file — the API has no metadata update route for files.</li>
          {anonymous && <li>Account features — an anonymous session cannot hold API keys.</li>}
        </ul>
      </section>
    </aside>
  );
}
