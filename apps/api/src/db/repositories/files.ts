import type { FileState, FileVisibility, ScanState } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';
import type { FileEntity } from '../entities.js';
import { translateWriteError } from '../errors.js';
import { toPage } from '../../pagination.js';
import type { CursorPosition } from '../../pagination.js';
import { parseByteCount, parseNullableTimestamp, parseTimestamp } from '../parse.js';

/**
 * File metadata.
 *
 * Nothing here decides authorization — the caller does, from the authenticated principal — and
 * nothing here exposes bytes. What it does enforce is that a read is scoped by `owner_key`, that
 * a state change is expressed as a transition from a known state (so two concurrent writers cannot
 * both "win"), and that soft deletion is a state rather than a missing row.
 *
 * Note what is *not* selected: `deletion_token_hash` and, more importantly, anything from
 * `storage_objects`. Provider references live in that table and are read only by the storage
 * layer, so a metadata read cannot leak one by accident.
 */

interface FileRow {
  id: string;
  ownerKind: 'user' | 'anonymous';
  ownerKey: string;
  ownerUserId: string | null;
  ownerSessionId: string | null;
  folderId: string | null;
  originalFilename: string;
  sizeBytes: string | number;
  mimeType: string;
  detectedMimeType: string | null;
  visibility: FileVisibility;
  status: FileState;
  scanState: ScanState;
  checksumSha256: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  deletedAt: Date | null;
  scannedAt: Date | null;
}

function toFile(row: FileRow): FileEntity {
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    ownerKey: row.ownerKey,
    ownerUserId: row.ownerUserId,
    ownerSessionId: row.ownerSessionId,
    folderId: row.folderId,
    originalFilename: row.originalFilename,
    sizeBytes: parseByteCount(row.sizeBytes, 'files.size_bytes'),
    mimeType: row.mimeType,
    detectedMimeType: row.detectedMimeType,
    visibility: row.visibility,
    state: row.status,
    scanState: row.scanState,
    checksumSha256: row.checksumSha256,
    createdAt: parseTimestamp(row.createdAt, 'files.created_at'),
    updatedAt: parseTimestamp(row.updatedAt, 'files.updated_at'),
    expiresAt: parseNullableTimestamp(row.expiresAt, 'files.expires_at'),
    deletedAt: parseNullableTimestamp(row.deletedAt, 'files.deleted_at'),
    scannedAt: parseNullableTimestamp(row.scannedAt, 'files.scanned_at'),
  };
}

export interface FileOwner {
  readonly ownerKey: string;
  readonly ownerUserId: string | null;
  readonly ownerSessionId: string | null;
}

/**
 * Reads a file by id, scoped to an owner.
 *
 * The owner scope is part of the query rather than a check afterwards: a caller that has not been
 * authenticated as this owner gets `null`, exactly as it would for an id that does not exist. That
 * is what makes a cross-owner probe indistinguishable from a typo.
 */
export async function findFileById(
  sql: SqlExecutor,
  fileId: string,
  ownerKey: string,
): Promise<FileEntity | null> {
  const rows = await sql<FileRow[]>`
    select id,
           case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
           owner_key as "ownerKey", owner_user_id as "ownerUserId",
           owner_session_id as "ownerSessionId", folder_id as "folderId",
           original_filename as "originalFilename", size_bytes as "sizeBytes",
           mime_type as "mimeType", detected_mime_type as "detectedMimeType",
           visibility, status, scan_state as "scanState", checksum_sha256 as "checksumSha256",
           created_at as "createdAt", updated_at as "updatedAt", expires_at as "expiresAt",
           deleted_at as "deletedAt", scanned_at as "scannedAt"
      from files
     where id = ${fileId} and owner_key = ${ownerKey}
  `;
  const row = rows[0];
  return row === undefined ? null : toFile(row);
}

/**
 * Reads a file by id without an owner scope, for the paths that authorize by a credential instead
 * of an identity — resolving a share link, for example. Callers of this function MUST make an
 * explicit authorization decision; it deliberately reveals whether the row exists.
 */
export async function findFileByIdForAccessCheck(
  sql: SqlExecutor,
  fileId: string,
): Promise<FileEntity | null> {
  const rows = await sql<FileRow[]>`
    select id,
           case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
           owner_key as "ownerKey", owner_user_id as "ownerUserId",
           owner_session_id as "ownerSessionId", folder_id as "folderId",
           original_filename as "originalFilename", size_bytes as "sizeBytes",
           mime_type as "mimeType", detected_mime_type as "detectedMimeType",
           visibility, status, scan_state as "scanState", checksum_sha256 as "checksumSha256",
           created_at as "createdAt", updated_at as "updatedAt", expires_at as "expiresAt",
           deleted_at as "deletedAt", scanned_at as "scannedAt"
      from files
     where id = ${fileId}
  `;
  const row = rows[0];
  return row === undefined ? null : toFile(row);
}

/**
 * A row that can be paginated. `cursorAt` is the exact `created_at` (microseconds preserved) used
 * to build the next cursor; see `pagination.ts`. It is selected only by the list query and never
 * reaches the entity.
 */
interface ListFileRow extends FileRow {
  cursorAt: string;
}

export interface ListFilesOptions {
  readonly scope: 'any' | 'root' | 'folder';
  readonly folderId?: string;
  /** Page size. One extra row is fetched internally to detect a following page. */
  readonly limit: number;
  readonly before?: CursorPosition | undefined;
}

export interface FilePage {
  readonly items: FileEntity[];
  readonly nextCursor: string | null;
}

export async function listFiles(
  sql: SqlExecutor,
  ownerKey: string,
  options: ListFilesOptions,
): Promise<FilePage> {
  const folderId = options.folderId ?? null;
  const cursorCreatedAt = options.before?.createdAt ?? null;
  const cursorId = options.before?.id ?? null;

  const rows = await sql<ListFileRow[]>`
    select id,
           case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
           owner_key as "ownerKey", owner_user_id as "ownerUserId",
           owner_session_id as "ownerSessionId", folder_id as "folderId",
           original_filename as "originalFilename", size_bytes as "sizeBytes",
           mime_type as "mimeType", detected_mime_type as "detectedMimeType",
           visibility, status, scan_state as "scanState", checksum_sha256 as "checksumSha256",
           created_at as "createdAt", updated_at as "updatedAt", expires_at as "expiresAt",
           deleted_at as "deletedAt", scanned_at as "scannedAt",
           to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
      from files
     where owner_key = ${ownerKey}
       and deleted_at is null
       and case ${options.scope}::text
             when 'any' then true
             when 'root' then folder_id is null
             else folder_id = ${folderId}
           end
       and (${cursorCreatedAt}::timestamptz is null
            or (created_at, id) < (${cursorCreatedAt}, ${cursorId}::text))
     order by created_at desc, id desc
     limit ${options.limit + 1}
  `;

  const page = toPage(rows, options.limit);
  return { items: page.items.map(toFile), nextCursor: page.nextCursor };
}

/**
 * Creates the metadata row for a file that is about to be uploaded.
 *
 * A row starts in `pending_upload` — the database default — and owns no bytes. The quota hold that
 * covers it is created separately (see `quota.ts`), because the two must be able to fail
 * independently: a metadata row with no hold is inert, while a hold with no row could not be
 * released by file id.
 */
export async function createFile(
  sql: SqlExecutor,
  input: {
    id: string;
    owner: FileOwner;
    folderId: string | null;
    originalFilename: string;
    sizeBytes: number;
    mimeType: string;
    visibility: FileVisibility;
    checksumSha256: string | null;
    expiresAt: Date | null;
  },
): Promise<FileEntity> {
  try {
    const rows = await sql<FileRow[]>`
      insert into files (id, owner_user_id, owner_session_id, folder_id, original_filename,
                         size_bytes, mime_type, visibility, checksum_sha256, expires_at)
      values (${input.id}, ${input.owner.ownerUserId}, ${input.owner.ownerSessionId},
              ${input.folderId}, ${input.originalFilename}, ${input.sizeBytes},
              ${input.mimeType}, ${input.visibility}, ${input.checksumSha256}, ${input.expiresAt})
      returning id,
                case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
                owner_key as "ownerKey", owner_user_id as "ownerUserId",
                owner_session_id as "ownerSessionId", folder_id as "folderId",
                original_filename as "originalFilename", size_bytes as "sizeBytes",
                mime_type as "mimeType", detected_mime_type as "detectedMimeType",
                visibility, status, scan_state as "scanState", checksum_sha256 as "checksumSha256",
                created_at as "createdAt", updated_at as "updatedAt", expires_at as "expiresAt",
                deleted_at as "deletedAt", scanned_at as "scannedAt"
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('file insert returned no row');
    return toFile(row);
  } catch (error) {
    throw translateWriteError(error, 'The file record could not be created.');
  }
}

/**
 * Applies a state transition, conditioned on the state the caller believed the file was in.
 *
 * This is compare-and-set, and it is what makes the transition table real under concurrency: if a
 * scanner and a delete request race, the loser's update matches no row and reports `null` instead
 * of overwriting a state the caller never saw. Callers pass the transition they validated with
 * `assertTransition` from the shared package.
 */
export async function applyFileTransition(
  sql: SqlExecutor,
  input: {
    fileId: string;
    ownerKey: string;
    from: FileState;
    to: FileState;
    scanState?: ScanState;
    detectedMimeType?: string | null;
    scannedAt?: Date | null;
  },
): Promise<FileEntity | null> {
  try {
    const rows = await sql<FileRow[]>`
      update files
         set status = ${input.to},
             scan_state = coalesce(${input.scanState ?? null}, scan_state),
             detected_mime_type = coalesce(${input.detectedMimeType ?? null}, detected_mime_type),
             scanned_at = coalesce(${input.scannedAt ?? null}, scanned_at),
             deleted_at = case when ${input.to}::text in ('deleting', 'deleted') then coalesce(deleted_at, now()) else deleted_at end
       where id = ${input.fileId}
         and owner_key = ${input.ownerKey}
         and status = ${input.from}
      returning id,
                case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
                owner_key as "ownerKey", owner_user_id as "ownerUserId",
                owner_session_id as "ownerSessionId", folder_id as "folderId",
                original_filename as "originalFilename", size_bytes as "sizeBytes",
                mime_type as "mimeType", detected_mime_type as "detectedMimeType",
                visibility, status, scan_state as "scanState", checksum_sha256 as "checksumSha256",
                created_at as "createdAt", updated_at as "updatedAt", expires_at as "expiresAt",
                deleted_at as "deletedAt", scanned_at as "scannedAt"
    `;
    const row = rows[0];
    return row === undefined ? null : toFile(row);
  } catch (error) {
    throw translateWriteError(error, 'The file state could not be updated.');
  }
}

export async function countFilesForOwner(sql: SqlExecutor, ownerKey: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as "count"
      from files
     where owner_key = ${ownerKey} and deleted_at is null
  `;
  return rows[0]?.count ?? 0;
}
