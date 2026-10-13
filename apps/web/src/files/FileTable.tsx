import type { FileRecord } from '@opendrive/shared';
import { Icon } from '../components/Icon.js';
import { Menu, type MenuItem } from '../components/Menu.js';
import { formatBytes } from '../lib/format.js';
import { FileTypeGlyph } from './FileTypeGlyph.js';
import { fileStatusTag, formatWhen } from './presentation.js';

/**
 * The information-dense list view.
 *
 * A real table with a caption, so screen readers get the column relationships. The filename is
 * the strongest text in the row; everything else is metadata at a lower weight. Selection is a
 * checkbox (keyboard-reachable) and shift-click extends a range.
 */
export function FileTable({
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
  const allSelected = files.length > 0 && files.every((file) => selected(file.id));

  return (
    <div className="tablewrap">
      <table className="filetable">
        <caption className="visually-hidden">
          Files in this folder. Use the checkbox column to select files, and the file name to open
          details.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="filetable__pick">
              <input
                type="checkbox"
                aria-label={allSelected ? 'Clear selection' : 'Select all files on this page'}
                checked={allSelected}
                onChange={() => {
                  for (const file of files) {
                    if (allSelected ? selected(file.id) : !selected(file.id)) {
                      onSelect(file.id, { toggle: true });
                    }
                  }
                }}
              />
            </th>
            <th scope="col">Name</th>
            <th scope="col" className="filetable__col-type">
              Type
            </th>
            <th scope="col" className="filetable__col-size">
              Size
            </th>
            <th scope="col" className="filetable__col-state">
              State
            </th>
            <th scope="col" className="filetable__col-when">
              Added
            </th>
            <th scope="col" className="filetable__col-actions">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => {
            const status = fileStatusTag(file);
            return (
              <tr
                key={file.id}
                className={selected(file.id) ? 'filetable__row--selected' : undefined}
                onMouseDown={(event) => {
                  if (event.target instanceof HTMLInputElement) return;
                  onSelect(file.id, {
                    shift: event.shiftKey,
                    toggle: event.ctrlKey || event.metaKey,
                  });
                }}
              >
                <td className="filetable__pick">
                  <input
                    type="checkbox"
                    checked={selected(file.id)}
                    aria-label={`Select ${file.filename}`}
                    onChange={() => onSelect(file.id, { toggle: true })}
                  />
                </td>
                <th scope="row" className="filetable__name-cell">
                  <button
                    type="button"
                    className="filetable__name"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(file);
                    }}
                    title={file.filename}
                  >
                    <FileTypeGlyph mimeType={file.mimeType} size={30} />
                    <span className="filetable__name-text">{file.filename}</span>
                  </button>
                </th>
                <td className="filetable__col-type mono dim">{file.mimeType}</td>
                <td className="filetable__col-size mono">{formatBytes(file.sizeBytes)}</td>
                <td className="filetable__col-state">
                  <span className={`tag tag--${status.tone}`}>{status.label}</span>
                </td>
                <td className="filetable__col-when dim">{formatWhen(file.createdAt)}</td>
                <td className="filetable__col-actions">
                  <Menu label={`Actions for ${file.filename}`} items={actionsFor(file)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore && (
        <div className="tablewrap__more">
          <button type="button" className="btn" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more files'}
          </button>
        </div>
      )}
      <p className="tablewrap__note">
        <Icon name="info" size={14} />
        Files are listed newest first. Sorting and server-side search are not part of this API yet,
        so the filter above narrows only what has been loaded.
      </p>
    </div>
  );
}
