import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import type { Density, ViewMode } from '../lib/prefs.js';

/**
 * The toolbar above the file list.
 *
 * Every control here is either a view preference (local, harmless) or an action whose
 * prerequisites have already been checked. Upload is disabled with the reason attached, rather
 * than hidden, so the person can see that the capability exists and what is blocking it.
 */
export function FileToolbar({
  view,
  density,
  onView,
  onDensity,
  onUpload,
  canUpload,
  uploadBlocker,
  onNewFolder,
  filter,
  onFilter,
  selectedCount,
  bulkActions,
  onRefresh,
  busy,
}: {
  view: ViewMode;
  density: Density;
  onView: (view: ViewMode) => void;
  onDensity: (density: Density) => void;
  onUpload: () => void;
  canUpload: boolean;
  uploadBlocker: string | null;
  onNewFolder: () => void;
  filter: string;
  onFilter: (value: string) => void;
  selectedCount: number;
  bulkActions: ReactNode;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <div className="toolbar" role="group" aria-label="File actions">
      <div className="toolbar__primary">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onUpload}
          disabled={!canUpload}
          title={
            canUpload
              ? 'Upload files into this folder'
              : (uploadBlocker ?? 'Uploads are unavailable')
          }
        >
          <Icon name="upload" size={16} />
          Upload files
        </button>
        <button type="button" className="btn" onClick={onNewFolder}>
          <Icon name="folder-plus" size={16} />
          New folder
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onRefresh}
          aria-label="Refresh this folder"
          disabled={busy}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>

      {selectedCount > 0 && (
        <div className="toolbar__selection" role="status">
          <span className="toolbar__count">{selectedCount} selected</span>
          {bulkActions}
        </div>
      )}

      <div className="spacer" />

      <label className="toolbar__filter">
        <Icon name="search" size={15} />
        <span className="visually-hidden">Filter the files on this page</span>
        <input
          type="search"
          className="input"
          placeholder="Filter this page…"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
        />
      </label>

      <div className="toolbar__views" role="group" aria-label="View">
        <button
          type="button"
          className={`btn btn--icon${view === 'list' ? ' btn--primary' : ''}`}
          aria-pressed={view === 'list'}
          onClick={() => onView('list')}
          title="List view"
        >
          <Icon name="list" size={16} />
          <span className="visually-hidden">List view</span>
        </button>
        <button
          type="button"
          className={`btn btn--icon${view === 'grid' ? ' btn--primary' : ''}`}
          aria-pressed={view === 'grid'}
          onClick={() => onView('grid')}
          title="Grid view"
        >
          <Icon name="grid" size={16} />
          <span className="visually-hidden">Grid view</span>
        </button>
      </div>

      <button
        type="button"
        className="btn"
        onClick={() => onDensity(density === 'compact' ? 'comfortable' : 'compact')}
        aria-pressed={density === 'compact'}
        title="Row density"
      >
        {density === 'compact' ? 'Compact' : 'Comfortable'}
      </button>
    </div>
  );
}
