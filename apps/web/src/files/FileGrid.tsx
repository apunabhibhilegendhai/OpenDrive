import type { FileRecord } from '@opendrive/shared';
import { PosterFrame } from '../assets/PosterFrame.js';
import { Icon } from '../components/Icon.js';
import { Menu, type MenuItem } from '../components/Menu.js';
import { formatBytes } from '../lib/format.js';
import { FileTypeGlyph } from './FileTypeGlyph.js';
import { fileStatusTag, formatWhen } from './presentation.js';

/** A file's own state, as the printed-plate tone. Never an invented rating. */
const PLATE_TONE = {
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
  info: 'accent',
  plain: 'plain',
} as const;

/**
 * The grid view.
 *
 * Tiles keep one size regardless of the file, so a folder reads as a chart of like objects
 * rather than a ragged mosaic. The name is the loudest element on the tile; the stamp carries
 * the type and the state is a word, not a colour.
 */
export function FileGrid({
  files,
  selected,
  onSelect,
  onOpen,
  actionsFor,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  files: FileRecord[];
  selected: (id: string) => boolean;
  onSelect: (id: string, modifiers: { shift?: boolean; toggle?: boolean }) => void;
  onOpen: (file: FileRecord) => void;
  actionsFor: (file: FileRecord) => MenuItem[];
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
}) {
  return (
    <div className="gridwrap">
      <ul className="filegrid">
        {files.map((file, index) => {
          const status = fileStatusTag(file);
          return (
            <li
              key={file.id}
              className={`tile tile--stamp${selected(file.id) ? ' tile--selected' : ''}`}
              style={{ '--ink-order': index % 8 } as React.CSSProperties}
              onMouseDown={(event) => {
                if (event.target instanceof HTMLInputElement) return;
                onSelect(file.id, {
                  shift: event.shiftKey,
                  toggle: event.ctrlKey || event.metaKey,
                });
              }}
            >
              <PosterFrame stamp={status.label} tone={PLATE_TONE[status.tone]}>
                <div className="tile__top">
                  <input
                    type="checkbox"
                    checked={selected(file.id)}
                    aria-label={`Select ${file.filename}`}
                    onChange={() => onSelect(file.id, { toggle: true })}
                  />
                  <div className="spacer" />
                  <Menu label={`Actions for ${file.filename}`} items={actionsFor(file)} />
                </div>
                <button
                  type="button"
                  className="tile__open"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(file);
                  }}
                >
                  <FileTypeGlyph mimeType={file.mimeType} size={44} />
                  <span className="tile__name" title={file.filename}>
                    {file.filename}
                  </span>
                </button>
                <dl className="tile__meta">
                  <div>
                    <dt className="visually-hidden">Size</dt>
                    <dd className="mono">{formatBytes(file.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt className="visually-hidden">Added</dt>
                    <dd className="dim">{formatWhen(file.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="visually-hidden">State</dt>
                    <dd>
                      <span className={`tag tag--${status.tone}`}>{status.label}</span>
                    </dd>
                  </div>
                </dl>
              </PosterFrame>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div className="tablewrap__more">
          <button type="button" className="btn" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more files'}
          </button>
        </div>
      )}
      <p className="tablewrap__note">
        <Icon name="info" size={14} />
        Tiles show the metadata the API returns. There are no thumbnails: this deployment has no
        preview pipeline, so nothing pretends to render one.
      </p>
    </div>
  );
}
