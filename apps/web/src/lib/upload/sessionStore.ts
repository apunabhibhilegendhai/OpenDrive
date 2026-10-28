/**
 * Client-side persistence of in-flight upload sessions.
 *
 * The server is still the source of truth for which parts it holds; this store only remembers
 * the session id (and a file fingerprint) so that an upload interrupted by a closed tab or a
 * crashed browser can be resumed when the same file is picked again. Bytes are never stored
 * here — only metadata.
 */

export interface PersistedUploadSession {
  fingerprint: string;
  uploadId: string;
  fileId: string;
  partSizeBytes: number;
  sizeBytes: number;
  name: string;
  mimeType: string;
  folderId: string | null;
  expiresAt: string;
  updatedAt: number;
}

const DB_NAME = 'opendrive-uploads';
const STORE_NAME = 'sessions';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export function fileFingerprint(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export async function loadSession(fingerprint: string): Promise<PersistedUploadSession | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(fingerprint);
      req.onsuccess = () => resolve((req.result as PersistedUploadSession | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveSession(record: PersistedUploadSession): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function deleteSession(fingerprint: string): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(fingerprint);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function listSessions(): Promise<PersistedUploadSession[]> {
  const db = await openDb();
  if (db === null) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as PersistedUploadSession[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}