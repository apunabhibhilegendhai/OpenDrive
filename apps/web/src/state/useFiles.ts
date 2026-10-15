import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileRecord, FolderRecord } from '@opendrive/shared';
import { describeFailure } from '../lib/api/errors.js';
import { useApi, useSession } from '../lib/auth/session.js';

/**
 * File and folder data access.
 *
 * Every hook depends on the session `epoch`, so a sign-out or an account switch discards the
 * previous principal's rows rather than leaving them on screen. A folder change aborts the
 * in-flight request, so a slow answer for folder A can never populate folder B.
 */

export const PAGE_SIZE = 50;

export interface FileListState {
  files: FileRecord[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
  reload: () => void;
  loadMore: () => void;
}

export function useFileList(folderId: string | null): FileListState {
  const api = useApi();
  const { epoch } = useSession();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  /**
   * Which listing a response belongs to. A new generation is taken whenever the folder, the
   * principal or the reload token changes, so a page that arrives after the drive has moved on is
   * dropped instead of being appended to rows it does not belong with.
   */
  const generationRef = useRef(0);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    setStatus('loading');
    setError(null);
    setFiles([]);
    setNextCursor(null);

    void (async () => {
      try {
        const page = await api.listFiles(
          { limit: PAGE_SIZE, ...(folderId === null ? { folder: 'root' } : { folder: folderId }) },
          controller.signal,
        );
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setFiles(page.items);
        setNextCursor(page.nextCursor);
        setStatus('ready');
      } catch (failure) {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setError(describeFailure(failure));
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [api, folderId, epoch, reloadToken]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (nextCursor === null || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await api.listFiles({
          limit: PAGE_SIZE,
          ...(folderId === null ? { folder: 'root' } : { folder: folderId }),
          cursor: nextCursor,
        });
        // The folder, the account or the reload may have changed while this page was in flight.
        // Appending it now would mix a listing this screen no longer represents into the current
        // one, and on an account switch that listing belongs to the previous account.
        if (generation !== generationRef.current) return;
        setFiles((current) => [...current, ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (failure) {
        if (generation !== generationRef.current) return;
        setError(describeFailure(failure));
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [api, folderId, nextCursor, loadingMore]);

  return {
    files,
    status,
    error,
    nextCursor,
    loadingMore,
    reload,
    loadMore,
  };
}

export interface FolderIndex {
  folders: FolderRecord[];
  byId: Map<string, FolderRecord>;
  status: 'loading' | 'ready' | 'error';
  /** Ancestors of a folder, outermost first. Empty when the folder is not in the index. */
  trail: (folderId: string | null) => FolderRecord[];
  reload: () => void;
}

const MAX_INDEX_PAGES = 5;
const INDEX_PAGE_SIZE = 100;

/**
 * The whole folder tree, paged.
 *
 * The API exposes one folder at a time for navigation and the whole tree when `parent` is
 * omitted; the tree is what breadcrumbs need, because there is no single-folder endpoint.
 * The index is capped at five pages and simply stops there — a name that is missing from the
 * index renders as a short id rather than as a wrong name.
 */
export function useFolderIndex(): FolderIndex {
  const api = useApi();
  const { epoch } = useSession();
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setStatus('loading');
    void (async () => {
      const collected: FolderRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
        try {
          const result = await api.listFolders(
            { limit: INDEX_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
            controller.signal,
          );
          collected.push(...result.items);
          if (result.nextCursor === null) break;
          cursor = result.nextCursor;
        } catch {
          if (!cancelled) setStatus(collected.length > 0 ? 'ready' : 'error');
          return;
        }
      }
      if (cancelled) return;
      setFolders(collected);
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, epoch, reloadToken]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const byId = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);

  const trail = useCallback(
    (folderId: string | null): FolderRecord[] => {
      if (folderId === null) return [];
      const chain: FolderRecord[] = [];
      let current = byId.get(folderId);
      let guard = 0;
      while (current !== undefined && guard < 40) {
        chain.unshift(current);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
        guard += 1;
      }
      return chain;
    },
    [byId],
  );

  return {
    folders,
    byId,
    status,
    trail,
    reload,
  };
}
