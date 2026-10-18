import type { DatabaseClient, Sql } from '../src/db/client.js';

/**
 * In-memory stand-in for the metadata database, for the load harness only.
 *
 * The harness must run where PostgreSQL is unavailable, yet it must still drive the real routes,
 * the real repositories and the real upload/finalize machinery. So the only thing replaced is the
 * driver: this file answers the exact query shapes the upload path issues, with the same result
 * shapes PostgreSQL returns, and nothing else. An unrecognised query throws instead of returning an
 * empty result — a silent `[]` would turn a broken harness into a pass.
 *
 * What it models (matching the migrations, for the registered-user path):
 *   - `profiles` with the schema defaults (5 GiB quota, 2 GiB max file, 100000 max files).
 *   - `files` with `owner_key` generated as `coalesce(owner_user_id, owner_session_id)`, status
 *     `pending_upload`, and the compare-and-set state transition.
 *   - `quota_reservations` with the checks `opendrive_reserve_storage` performs for a user:
 *     owner active, file exists and is owned and its recorded size matches, no live hold for the
 *     file, size within `max_file_size_bytes`, file count within `max_files`, and used + requested
 *     within `storage_quota_bytes`. Holds count toward usage, as the real function does.
 *   - `storage_objects` with one active object per file and the provider ref stored as JSON.
 *
 * What it does not model: RLS, triggers, `updated_at` maintenance beyond the writes the API makes,
 * anonymous sessions, shares, audit events, and every query not on the upload path. The integration
 * suite remains the place where the real database is exercised.
 */

const DEFAULT_STORAGE_QUOTA_BYTES = 5_368_709_120;
const DEFAULT_MAX_FILE_SIZE_BYTES = 2_147_483_648;
const DEFAULT_MAX_FILES = 100_000;

interface ProfileRow {
  id: string;
  displayName: string | null;
  status: 'active' | 'suspended' | 'closed';
  storageQuotaBytes: number;
  maxFileSizeBytes: number;
  maxFiles: number;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
}

export interface FileRow {
  id: string;
  ownerKind: 'user' | 'anonymous';
  ownerKey: string;
  ownerUserId: string | null;
  ownerSessionId: string | null;
  folderId: string | null;
  originalFilename: string;
  sizeBytes: number;
  mimeType: string;
  detectedMimeType: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  status: string;
  scanState: string | null;
  checksumSha256: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  deletedAt: Date | null;
  scannedAt: Date | null;
}

interface ReservationRow {
  id: string;
  fileId: string;
  ownerKey: string;
  bytes: number;
  state: 'held' | 'committed' | 'released';
  expiresAt: Date;
}

interface StorageObjectRow {
  id: string;
  fileId: string;
  providerRef: unknown;
  state: 'active' | 'deleted';
}

export interface MetadataStats {
  /** Queries served, so the report can state how much metadata work the run caused. */
  queries: number;
  profiledUsers: number;
  files: number;
  reservations: number;
}

export interface MetadataDouble {
  readonly sql: Sql;
  readonly client: DatabaseClient;
  readonly stats: MetadataStats;
}

export interface MetadataOptions {
  /** Overrides the schema default when a run needs more room than 5 GiB per user. */
  readonly storageQuotaBytes?: number;
}

/** Collapses a tagged-template query into one lower-cased line for shape matching. */
function normalize(strings: readonly string[]): string {
  return strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function createMetadataDouble(options: MetadataOptions = {}): MetadataDouble {
  const quota = options.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
  const profiles = new Map<string, ProfileRow>();
  const files = new Map<string, FileRow>();
  const reservations = new Map<string, ReservationRow>();
  const objectsByFile = new Map<string, StorageObjectRow>();
  const stats: MetadataStats = { queries: 0, profiledUsers: 0, files: 0, reservations: 0 };

  const now = (): Date => new Date();

  function usedBytes(ownerKey: string, excludeFileId: string | null): number {
    let used = 0;
    for (const held of reservations.values()) {
      if (held.ownerKey !== ownerKey) continue;
      if (held.state === 'released') continue;
      if (held.fileId === excludeFileId) continue;
      used += held.bytes;
    }
    return used;
  }

  function fileCount(ownerKey: string, excludeFileId: string | null): number {
    let count = 0;
    for (const file of files.values()) {
      if (file.ownerKey !== ownerKey) continue;
      if (file.id === excludeFileId) continue;
      if (file.deletedAt !== null || file.status === 'deleted') continue;
      count += 1;
    }
    return count;
  }

  function refuse(reason: string, message: string): { ok: false; reason: string; message: string } {
    return { ok: false, reason, message };
  }

  function reserve(
    reservationId: string,
    ownerUserId: string | null,
    ownerSessionId: string | null,
    fileId: string,
    bytes: number,
    ttlSeconds: number,
  ): unknown {
    if ((ownerUserId === null) === (ownerSessionId === null)) {
      return refuse('invalid_principal', 'Exactly one owner id is required.');
    }
    const ownerKey = ownerUserId ?? ownerSessionId ?? '';
    if (ownerUserId !== null) {
      const profile = profiles.get(ownerUserId);
      if (profile === undefined) return refuse('owner_unknown', 'No profile exists for this user.');
      if (profile.status !== 'active') {
        return refuse('owner_not_active', 'This account is not active.');
      }
    }
    const file = files.get(fileId);
    if (file === undefined)
      return refuse('file_not_found', 'No metadata row exists for this file.');
    if (file.ownerKey !== ownerKey) {
      return refuse('owner_mismatch', 'This file belongs to a different owner.');
    }
    if (file.deletedAt !== null || file.status === 'deleted') {
      return refuse('file_deleted', 'A deleted file cannot reserve quota.');
    }
    if (file.sizeBytes !== bytes) {
      return refuse('size_mismatch', 'The requested size does not match the recorded size.');
    }
    for (const existing of reservations.values()) {
      if (existing.fileId === fileId && existing.state === 'held' && existing.expiresAt > now()) {
        return refuse('already_reserved', 'This file already holds a live quota reservation.');
      }
    }
    const profile = ownerUserId === null ? null : profiles.get(ownerUserId);
    const storageLimit = profile?.storageQuotaBytes ?? quota;
    const maxFile = profile?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    const maxFiles = profile?.maxFiles ?? DEFAULT_MAX_FILES;
    if (bytes > maxFile) {
      return refuse('file_too_large', `A single file may be at most ${maxFile} bytes.`);
    }
    if (fileCount(ownerKey, fileId) + 1 > maxFiles) {
      return refuse('file_count_exceeded', `This account may hold at most ${maxFiles} files.`);
    }
    const used = usedBytes(ownerKey, fileId);
    if (used + bytes > storageLimit) {
      return refuse(
        'storage_quota_exceeded',
        `This upload would exceed the ${storageLimit} byte storage quota.`,
      );
    }
    const expiresAt = new Date(now().getTime() + ttlSeconds * 1000);
    const row: ReservationRow = {
      id: reservationId,
      fileId,
      ownerKey,
      bytes,
      state: 'held',
      expiresAt,
    };
    reservations.set(reservationId, row);
    stats.reservations = reservations.size;
    return {
      ok: true,
      reservationId,
      storageLimitBytes: storageLimit,
      storageUsedBytes: used,
      storageRemainingBytes: Math.max(storageLimit - used - bytes, 0),
      expiresAt: expiresAt.toISOString(),
    };
  }

  function fileRow(input: {
    id: string;
    ownerUserId: string | null;
    ownerSessionId: string | null;
    folderId: string | null;
    originalFilename: string;
    sizeBytes: number;
    mimeType: string;
    visibility: 'private' | 'unlisted' | 'public';
    checksumSha256: string | null;
    expiresAt: Date | null;
  }): FileRow {
    const at = now();
    return {
      id: input.id,
      ownerKind: input.ownerUserId === null ? 'anonymous' : 'user',
      ownerKey: input.ownerUserId ?? input.ownerSessionId ?? '',
      ownerUserId: input.ownerUserId,
      ownerSessionId: input.ownerSessionId,
      folderId: input.folderId,
      originalFilename: input.originalFilename,
      sizeBytes: Number(input.sizeBytes),
      mimeType: input.mimeType,
      detectedMimeType: null,
      visibility: input.visibility,
      status: 'pending_upload',
      scanState: null,
      checksumSha256: input.checksumSha256,
      createdAt: at,
      updatedAt: at,
      expiresAt: input.expiresAt,
      deletedAt: null,
      scannedAt: null,
    };
  }

  /**
   * Dispatches one query. Parameter order is fixed by the repository that writes the statement and
   * is documented beside each branch; a change to a repository query is meant to break this loudly.
   */
  function execute(strings: readonly string[], values: readonly unknown[]): unknown[] {
    stats.queries += 1;
    const q = normalize(strings);

    // findProfile
    if (q.startsWith('select id, display_name')) {
      const profile = profiles.get(String(values[0]));
      return profile === undefined ? [] : [{ ...profile }];
    }
    // ensureProfile: insert into profiles (id) values ($1) on conflict (id) do nothing
    if (q.startsWith('insert into profiles')) {
      const id = String(values[0]);
      if (!profiles.has(id)) {
        const at = now();
        profiles.set(id, {
          id,
          displayName: null,
          status: 'active',
          storageQuotaBytes: quota,
          maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
          maxFiles: DEFAULT_MAX_FILES,
          createdAt: at,
          updatedAt: at,
          disabledAt: null,
        });
        stats.profiledUsers = profiles.size;
      }
      return [];
    }
    // countFilesCreatedSince: $1 owner_key, $2 since
    if (q.startsWith('select count(*)::int') && q.includes('created_at >=')) {
      const ownerKey = String(values[0]);
      const since = values[1] as Date;
      let count = 0;
      for (const file of files.values()) {
        if (file.ownerKey === ownerKey && file.createdAt >= since) count += 1;
      }
      return [{ count }];
    }
    // countFilesForOwner
    if (q.startsWith('select count(*)::int')) {
      const ownerKey = String(values[0]);
      let count = 0;
      for (const file of files.values()) {
        if (file.ownerKey === ownerKey && file.deletedAt === null) count += 1;
      }
      return [{ count }];
    }
    // createFile: id, ownerUserId, ownerSessionId, folderId, filename, size, mime, visibility,
    // checksum, expiresAt
    if (q.startsWith('insert into files')) {
      const row = fileRow({
        id: String(values[0]),
        ownerUserId: (values[1] ?? null) as string | null,
        ownerSessionId: (values[2] ?? null) as string | null,
        folderId: (values[3] ?? null) as string | null,
        originalFilename: String(values[4]),
        sizeBytes: Number(values[5]),
        mimeType: String(values[6]),
        visibility: values[7] as 'private' | 'unlisted' | 'public',
        checksumSha256: (values[8] ?? null) as string | null,
        expiresAt: (values[9] ?? null) as Date | null,
      });
      files.set(row.id, row);
      stats.files = files.size;
      return [{ ...row }];
    }
    // applyFileTransition: to, scanState, detectedMime, scannedAt, to, fileId, ownerKey, from
    if (q.startsWith('update files') && q.includes('set status =')) {
      const to = String(values[0]);
      const from = String(values[7]);
      const fileId = String(values[5]);
      const ownerKey = String(values[6]);
      const row = files.get(fileId);
      if (row === undefined || row.ownerKey !== ownerKey || row.status !== from) return [];
      row.status = to;
      const scanState = values[1];
      if (typeof scanState === 'string') row.scanState = scanState;
      const detectedMime = values[2];
      if (typeof detectedMime === 'string') row.detectedMimeType = detectedMime;
      const scannedAt = values[3];
      if (scannedAt instanceof Date) row.scannedAt = scannedAt;
      if (to === 'deleting' || to === 'deleted') {
        row.deletedAt ??= now();
      }
      row.updatedAt = now();
      return [{ ...row }];
    }
    // setDeletionTokenHash — anonymous uploads only, which this harness does not drive.
    if (q.startsWith('update files') && q.includes('deletion_token_hash')) {
      return [];
    }
    // findFileById / findFileByIdForAccessCheck
    if (q.startsWith('select id,') && q.includes('from files') && q.includes('where id =')) {
      const fileId = String(values[0]);
      const row = files.get(fileId);
      if (row === undefined) return [];
      if (q.includes('owner_key =') && row.ownerKey !== String(values[1])) return [];
      return [{ ...row, cursorAt: row.createdAt.toISOString() }];
    }
    // listFiles (only used if a run asks for a listing)
    if (q.startsWith('select id,') && q.includes('to_char(created_at')) {
      const ownerKey = String(values[0]);
      const limit = Number(values[values.length - 1]);
      const rows = [...files.values()]
        .filter((file) => file.ownerKey === ownerKey && file.deletedAt === null)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, limit);
      return rows.map((row) => ({ ...row, cursorAt: row.createdAt.toISOString() }));
    }
    // reserveStorage: reservationId, ownerUserId, ownerSessionId, fileId, bytes, ttlSeconds
    if (q.startsWith('select opendrive_reserve_storage')) {
      const result = reserve(
        String(values[0]),
        (values[1] ?? null) as string | null,
        (values[2] ?? null) as string | null,
        String(values[3]),
        Number(values[4]),
        Number(values[5]),
      );
      return [{ result }];
    }
    if (q.startsWith('select opendrive_commit_reservation')) {
      const row = reservations.get(String(values[0]));
      if (row === undefined) {
        return [{ result: { ok: false, reason: 'reservation_not_found' } }];
      }
      if (row.state === 'committed') {
        return [
          {
            result: {
              ok: true,
              alreadyCommitted: true,
              fileId: row.fileId,
              committedBytes: row.bytes,
            },
          },
        ];
      }
      row.state = 'committed';
      return [
        {
          result: {
            ok: true,
            alreadyCommitted: false,
            fileId: row.fileId,
            committedBytes: row.bytes,
          },
        },
      ];
    }
    if (q.startsWith('select opendrive_release_reservation')) {
      const row = reservations.get(String(values[0]));
      if (row === undefined) {
        return [{ result: { ok: true, alreadyReleased: true, releasedBytes: 0 } }];
      }
      if (row.state === 'released') {
        return [{ result: { ok: true, alreadyReleased: true, releasedBytes: 0 } }];
      }
      const releasedBytes = row.bytes;
      row.state = 'released';
      return [{ result: { ok: true, alreadyReleased: false, releasedBytes } }];
    }
    // findActiveStorageObjectByFileId
    if (q.startsWith('select id::text as id, file_id')) {
      const row = objectsByFile.get(String(values[0]));
      if (row === undefined || row.state !== 'active') return [];
      return [{ id: row.id, fileId: row.fileId, providerRef: row.providerRef }];
    }
    // insertActiveStorageObject: id, fileId, providerId, providerRef, sizeBytes, checksum
    if (q.startsWith('insert into storage_objects')) {
      const row: StorageObjectRow = {
        id: String(values[0]),
        fileId: String(values[1]),
        providerRef: values[3],
        state: 'active',
      };
      objectsByFile.set(row.fileId, row);
      return [{ id: row.id, fileId: row.fileId, providerRef: row.providerRef }];
    }
    // findFolderById — the harness uploads to the root, so this only ever proves absence.
    if (q.includes('from folders')) return [];

    throw new Error(
      `load harness metadata double does not implement this query: ${q.slice(0, 120)}`,
    );
  }

  const tag = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> =>
    execute([...strings], values);

  // `json` is the one postgres.js helper the upload path calls (storage object ref). The single
  // cast is the seam between the real driver's type and this double; nothing else is fabricated.
  const fake = Object.assign(tag, { json: (value: unknown): unknown => value }) as unknown as Sql;

  const client: DatabaseClient = {
    sql: fake,
    configured: true,
    close: async () => {},
    requireSql: () => fake,
  };

  return { sql: fake, client, stats };
}
