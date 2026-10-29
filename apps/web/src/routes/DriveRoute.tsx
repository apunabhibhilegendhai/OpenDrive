import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { CreatedShareRecord, FileRecord, FolderRecord } from '@opendrive/shared';
import { CompassRose } from '../assets/CompassRose.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import type { Command } from '../components/CommandPalette.js';
import type { MenuItem } from '../components/Menu.js';
import { Shell, type Crumb } from '../shell/Shell.js';
import { EmptyState } from '../files/EmptyState.js';
import { FileGrid } from '../files/FileGrid.js';
import { FileInspector } from '../files/FileInspector.js';
import { FileTable } from '../files/FileTable.js';
import { FileToolbar } from '../files/FileToolbar.js';
import { ShareDialog } from '../shares/ShareDialog.js';
import { DropOverlay } from '../upload/DropOverlay.js';
import { useApi, useSession } from '../lib/auth/session.js';
import { describeFailure } from '../lib/api/errors.js';
import { downloadFileContent } from '../lib/files/download.js';
import { formatBytes } from '../lib/format.js';
import { planForFile } from '../lib/upload/plan.js';
import { usePrefs } from '../state/prefs.js';
import { useSystem } from '../state/system.js';
import { useFileList, useFolderIndex } from '../state/useFiles.js';
import { useSelection } from '../state/useSelection.js';
import { useToasts } from '../components/ToastRegion.js';
import { useUploadQueue } from '../state/uploadQueue.js';

/**
 * My Drive.
 *
 * The folder is part of the URL (`?folder=`), so back, forward and a bookmark all land on the
 * folder they name. The listing, the subfolders and the breadcrumb trail come from the API; the
 * only client-side filtering is the deliberate "this page" filter, labelled as such.
 */
export function DriveRoute() {
  const api = useApi();
  const { state, epoch } = useSession();
  const system = useSystem();
  const { prefs, setPrefs } = usePrefs();
  const queue = useUploadQueue();
  const { notify } = useToasts();

  const [searchParams, setSearchParams] = useSearchParams();
  const folderId = searchParams.get('folder');

  const list = useFileList(folderId);
  const index = useFolderIndex();
  const [subfolders, setSubfolders] = useState<FolderRecord[]>([]);
  const [filter, setFilter] = useState('');
  const [inspected, setInspected] = useState<FileRecord | null>(null);
  const [shareTarget, setShareTarget] = useState<FileRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloadsBusy, setDownloadsBusy] = useState(false);
  const [sessionShares, setSessionShares] = useState<Record<string, CreatedShareRecord[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const orderedIds = useMemo(() => list.files.map((file) => file.id), [list.files]);
  const selection = useSelection(orderedIds);

  // A finished upload is a new file with server-side metadata: re-read the listing so the row
  // that appears is the API's answer, not the tab's optimistic guess.
  const readyUploads = queue.items.filter((item) => item.phase === 'ready').length;
  useEffect(() => {
    if (readyUploads === 0) return;
    list.reload();
    index.reload();
  }, [readyUploads, list.reload, index.reload]);

  // Subfolders of the folder currently open — an authoritative API listing, not the tree index.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const page = await api.listFolders(
          { parent: folderId ?? null, limit: 100 },
          controller.signal,
        );
        if (!cancelled) setSubfolders(page.items);
      } catch {
        if (!cancelled) setSubfolders([]);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, folderId, epoch, index.folders.length]);

  // Identity changes must not leave a previous user's rows selected or inspected.
  useEffect(() => {
    selection.clear();
    setInspected(null);
    setShareTarget(null);
    setDeleteTarget(null);
    setFilter('');
  }, [epoch, folderId, selection.clear]);

  const trail = index.trail(folderId);
  const folderLabel = trail.length === 0 ? 'My Drive' : (trail[trail.length - 1]?.name ?? 'Folder');
  const folderPath =
    trail.length === 0
      ? 'My Drive'
      : `My Drive / ${trail.map((folder) => folder.name).join(' / ')}`;

  const crumbs: Crumb[] = [
    { label: 'My Drive', to: '/drive' },
    ...trail.map((folder) => ({ label: folder.name, to: `/drive?folder=${folder.id}` })),
  ];

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return list.files;
    return list.files.filter((file) => file.filename.toLowerCase().includes(needle));
  }, [list.files, filter]);

  const navigateTo = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams();
      if (id !== null) next.set('folder', id);
      setSearchParams(next);
    },
    [setSearchParams],
  );

  const handleDownload = useCallback(
    async (file: FileRecord) => {
      setDownloadsBusy(true);
      try {
        const outcome = await downloadFileContent(api, file, undefined, { preferDelivery: true });
        if (outcome.kind === 'cancelled') return;
        notify(
          outcome.streamed
            ? `Saved ${outcome.filename} to disk.`
            : `Downloaded ${outcome.filename} (buffered in memory by this browser).`,
          'success',
        );
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === 'AbortError') return;
        notify(describeFailure(failure), 'danger');
      } finally {
        setDownloadsBusy(false);
      }
    },
    [api, notify],
  );

  const confirmDelete = useCallback(async () => {
    const file = deleteTarget;
    if (file === null) return;
    setBusy(true);
    try {
      if (state.kind === 'anonymous') {
        const token = state.deletionTokens[file.id];
        if (token === undefined) {
          notify(
            'This session has no deletion token for that file, so it cannot be removed from here.',
            'danger',
          );
          return;
        }
        await api.deleteFileWithToken(file.id, token);
      } else {
        await api.deleteFile(file.id);
      }
      notify(`${file.filename} deleted. OpenDrive no longer serves it.`, 'success');
      setDeleteTarget(null);
      setInspected(null);
      list.reload();
      index.reload();
    } catch (failure) {
      notify(describeFailure(failure), 'danger');
    } finally {
      setBusy(false);
    }
  }, [api, deleteTarget, index, list, notify, state]);

  const onFiles = useCallback(
    (files: File[]) => {
      if (!system.canUpload) {
        notify(system.uploadBlocker ?? 'Uploads are unavailable.', 'danger');
        return;
      }
      const accepted: File[] = [];
      for (const file of files) {
        if (system.limits === null) {
          accepted.push(file);
          continue;
        }
        const plan = planForFile(file.size, system.limits);
        if (plan.ok) accepted.push(file);
        else notify(`${file.name}: ${plan.reason}`, 'danger');
      }
      if (accepted.length > 0) {
        void queue.enqueue(accepted, folderId);
        notify(
          accepted.length === 1 ? 'Upload started.' : `${accepted.length} uploads queued.`,
          'info',
        );
      }
    },
    [folderId, notify, queue, system.canUpload, system.limits, system.uploadBlocker],
  );

  const createFolder = useCallback(async () => {
    const name = folderName.trim();
    if (name === '') return;
    setBusy(true);
    try {
      await api.createFolder({ name, parentId: folderId });
      notify(`Folder "${name}" created.`, 'success');
      setFolderDialogOpen(false);
      setFolderName('');
      index.reload();
      setSubfolders((current) => current);
      const page = await api.listFolders({ parent: folderId ?? null, limit: 100 });
      setSubfolders(page.items);
    } catch (failure) {
      notify(describeFailure(failure), 'danger');
    } finally {
      setBusy(false);
    }
  }, [api, folderId, folderName, index, notify]);

  const actionsFor = useCallback(
    (file: FileRecord): MenuItem[] => [
      {
        id: 'download',
        label: 'Download',
        icon: 'download',
        onSelect: () => void handleDownload(file),
      },
      {
        id: 'share',
        label: 'Create link',
        icon: 'link',
        onSelect: () => setShareTarget(file),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash',
        danger: true,
        onSelect: () => setDeleteTarget(file),
      },
      { id: 'open', label: 'Details', icon: 'info', onSelect: () => setInspected(file) },
    ],
    [handleDownload],
  );

  const bulkDelete = useCallback(async () => {
    const targets = selection.ordered
      .map((id) => list.files.find((file) => file.id === id))
      .filter((file): file is FileRecord => file !== undefined);
    if (targets.length === 0) return;
    setBusy(true);
    const results: string[] = [];
    for (const file of targets) {
      try {
        if (state.kind === 'anonymous') {
          const token = state.deletionTokens[file.id];
          if (token === undefined) {
            results.push(`${file.filename}: no deletion token in this session`);
            continue;
          }
          await api.deleteFileWithToken(file.id, token);
        } else {
          await api.deleteFile(file.id);
        }
        results.push(`${file.filename}: deleted`);
      } catch (failure) {
        results.push(`${file.filename}: ${describeFailure(failure)}`);
      }
    }
    setBusy(false);
    const failures = results.filter((line) => !line.endsWith(': deleted'));
    notify(
      failures.length === 0
        ? `${targets.length} files deleted.`
        : `${targets.length - failures.length} of ${targets.length} deleted. ${failures.join('; ')}`,
      failures.length === 0 ? 'success' : 'danger',
    );
    selection.clear();
    list.reload();
    index.reload();
  }, [api, index, list, notify, selection, state]);

  const extraCommands = useMemo<Command[]>(() => {
    const commands: Command[] = [
      {
        id: 'drive.upload',
        label: 'Upload files into this folder',
        icon: 'upload',
        keywords: 'add send',
        run: () => fileInputRef.current?.click(),
      },
      {
        id: 'drive.newfolder',
        label: 'New folder',
        icon: 'folder-plus',
        run: () => setFolderDialogOpen(true),
      },
      {
        id: 'drive.view.list',
        label: 'Switch to list view',
        icon: 'list',
        run: () => setPrefs({ ...prefs, view: 'list' }),
      },
      {
        id: 'drive.view.grid',
        label: 'Switch to grid view',
        icon: 'grid',
        run: () => setPrefs({ ...prefs, view: 'grid' }),
      },
      {
        id: 'drive.density',
        label: prefs.density === 'compact' ? 'Use comfortable rows' : 'Use compact rows',
        icon: 'list',
        run: () =>
          setPrefs({ ...prefs, density: prefs.density === 'compact' ? 'comfortable' : 'compact' }),
      },
      {
        id: 'drive.selectall',
        label: 'Select every file on this page',
        icon: 'check',
        run: selection.selectAll,
      },
      { id: 'drive.refresh', label: 'Refresh this folder', icon: 'refresh', run: list.reload },
      {
        id: 'drive.up',
        label: 'Go up one folder',
        icon: 'chevron-right',
        run: () => navigateTo(trail.length > 1 ? (trail[trail.length - 2]?.id ?? null) : null),
      },
    ];
    if (!system.canUpload) {
      return commands.map((command) =>
        command.id === 'drive.upload'
          ? {
              ...command,
              hint: 'storage unavailable',
              run: () => notify(system.uploadBlocker ?? 'Uploads are unavailable.', 'danger'),
            }
          : command,
      );
    }
    return commands;
  }, [
    list.reload,
    navigateTo,
    notify,
    prefs,
    selection.selectAll,
    setPrefs,
    system.canUpload,
    system.uploadBlocker,
    trail,
  ]);

  const inspectorShares = inspected === null ? [] : (sessionShares[inspected.id] ?? []);

  return (
    <Shell title={folderLabel} crumbs={crumbs} extraCommands={extraCommands}>
      <DropOverlay
        enabled={system.canUpload}
        folderLabel={folderLabel}
        maxFileSizeBytes={system.limits?.maxFileSizeBytes ?? null}
        onFiles={onFiles}
      />

      <header className="pagehead ink-in">
        <div className="pagehead__title">
          <CompassRose variant="watermark" size={148} title={null} bearing={-24} />
          <span className="pagehead__serial">
            {trail.length === 0
              ? 'Chart 00 · root'
              : `Chart ${String(trail.length).padStart(2, '0')} · depth ${trail.length}`}
          </span>
          <h1>{folderLabel}</h1>
          <p className="pagehead__meta">
            {list.status === 'ready'
              ? `${visible.length}${filter.trim() === '' ? '' : ` of ${list.files.length}`} file${visible.length === 1 ? '' : 's'}${list.nextCursor === null ? '' : ' (more available)'}`
              : 'Reading the manifest…'}
          </p>
        </div>
      </header>

      <FileToolbar
        view={prefs.view}
        density={prefs.density}
        onView={(view) => setPrefs({ ...prefs, view })}
        onDensity={(density) => setPrefs({ ...prefs, density })}
        onUpload={() => fileInputRef.current?.click()}
        canUpload={system.canUpload}
        uploadBlocker={system.uploadBlocker}
        onNewFolder={() => setFolderDialogOpen(true)}
        filter={filter}
        onFilter={setFilter}
        selectedCount={selection.count}
        onRefresh={list.reload}
        busy={list.status === 'loading'}
        bulkActions={
          <>
            <button type="button" className="btn" onClick={() => void bulkDelete()} disabled={busy}>
              <Icon name="trash" size={15} />
              Delete selected
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                const targets = selection.ordered
                  .map((id) => list.files.find((file) => file.id === id))
                  .filter((file): file is FileRecord => file !== undefined);
                void (async () => {
                  for (const file of targets) await handleDownload(file);
                })();
              }}
              disabled={downloadsBusy}
            >
              <Icon name="download" size={15} />
              Download selected
            </button>
            <button type="button" className="btn btn--ghost" onClick={selection.clear}>
              Clear
            </button>
          </>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="visually-hidden"
        aria-label="Choose files to upload"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          onFiles(files);
        }}
      />

      {subfolders.length > 0 && (
        <nav className="folders" aria-label="Folders in this folder">
          <ul className="folders__list">
            {subfolders.map((folder) => (
              <li key={folder.id}>
                <button type="button" className="folderchip" onClick={() => navigateTo(folder.id)}>
                  <Icon name="folder" size={15} />
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {folderId !== null && (
        <button
          type="button"
          className="btn btn--ghost uplevel"
          onClick={() =>
            navigateTo(trail.length > 1 ? (trail[trail.length - 2]?.id ?? null) : null)
          }
        >
          <Icon name="chevron-right" size={15} className="uplevel__icon" />
          Up one folder
        </button>
      )}

      {list.status === 'loading' && (
        <EmptyState
          kind="loading"
          title="Loading files"
          detail="Asking the API what this credential owns."
        />
      )}

      {list.status === 'error' && (
        <EmptyState
          kind="error"
          title="This folder could not be loaded"
          detail={list.error ?? 'The API refused the request.'}
          onRetry={list.reload}
        />
      )}

      {list.status === 'ready' && list.files.length === 0 && (
        <EmptyState
          kind="empty"
          title={folderLabel === 'My Drive' ? 'Your drive is empty' : 'This folder is empty'}
          detail={
            system.canUpload
              ? 'Upload a file to start charting this drive. Files stay private until you create a link.'
              : (system.uploadBlocker ?? 'Uploads are unavailable in this deployment.')
          }
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={!system.canUpload}
            >
              <Icon name="upload" size={16} />
              Upload files
            </button>
          }
        />
      )}

      {list.status === 'ready' && list.files.length > 0 && visible.length === 0 && (
        <EmptyState
          kind="filtered"
          title="Nothing on this page matches that filter"
          detail={`The filter searches only the ${list.files.length} files loaded here, because the API has no server-side search yet.`}
          action={
            <button type="button" className="btn" onClick={() => setFilter('')}>
              Clear the filter
            </button>
          }
        />
      )}

      {visible.length > 0 && (
        <div
          className={`browser browser--${prefs.density} ink-in`}
          style={{ '--ink-order': 1 } as React.CSSProperties}
        >
          {prefs.view === 'list' ? (
            <FileTable
              files={visible}
              selected={selection.isSelected}
              onSelect={selection.select}
              onOpen={setInspected}
              actionsFor={actionsFor}
              onLoadMore={list.loadMore}
              hasMore={list.nextCursor !== null}
              loadingMore={list.loadingMore}
            />
          ) : (
            <FileGrid
              files={visible}
              selected={selection.isSelected}
              onSelect={selection.select}
              onOpen={setInspected}
              actionsFor={actionsFor}
              onLoadMore={list.loadMore}
              hasMore={list.nextCursor !== null}
              loadingMore={list.loadingMore}
            />
          )}
        </div>
      )}

      {inspected !== null && (
        <FileInspector
          api={api}
          file={inspected}
          folderPath={folderPath}
          onClose={() => setInspected(null)}
          onDownload={(file) => void handleDownload(file)}
          onDelete={(file) => setDeleteTarget(file)}
          onShare={(file) => setShareTarget(file)}
          onRevokeShare={(shareId) => {
            void (async () => {
              try {
                await api.revokeShare(shareId);
                notify('Link revoked. It stops resolving on the next request.', 'success');
                setSessionShares((current) => ({
                  ...current,
                  [inspected.id]: (current[inspected.id] ?? []).filter(
                    (share) => share.id !== shareId,
                  ),
                }));
              } catch (failure) {
                notify(describeFailure(failure), 'danger');
              }
            })();
          }}
          downloadsBusy={downloadsBusy}
          shares={inspectorShares}
          anonymous={state.kind === 'anonymous'}
        />
      )}

      <ShareDialog
        file={shareTarget}
        open={shareTarget !== null}
        onClose={() => setShareTarget(null)}
        onCreated={(share) => {
          setSessionShares((current) => ({
            ...current,
            [share.fileId]: [...(current[share.fileId] ?? []), share],
          }));
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.filename ?? 'this file'}?`}
        consequence={
          <>
            OpenDrive stops serving this file and it disappears from your drive. The storage
            provider is Telegram in this deployment, which does not guarantee that every copy is
            erased there, so treat this as removing access rather than guaranteed destruction.
          </>
        }
        confirmLabel="Delete file"
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={folderDialogOpen}
        title="New folder"
        consequence="Folders are private to this account and can nest up to 32 levels."
        confirmLabel={busy ? 'Creating…' : 'Create folder'}
        busy={busy}
        onConfirm={() => void createFolder()}
        onCancel={() => {
          setFolderDialogOpen(false);
          setFolderName('');
        }}
      >
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="Charts"
            maxLength={255}
          />
        </label>
      </ConfirmDialog>

      {queue.items.length === 0 && system.canUpload && system.limits !== null && (
        <p className="drivehint">
          <Icon name="info" size={14} />
          This deployment accepts files up to {formatBytes(system.limits.maxFileSizeBytes)} per file
          in parts of {formatBytes(system.limits.chunkSizeBytes)}.
          {system.limits.maxFileSizeVerified
            ? ' The ceiling has been verified against the storage provider.'
            : ' That ceiling is configured, not yet verified against the provider, so a large upload may still be refused.'}
        </p>
      )}
    </Shell>
  );
}
