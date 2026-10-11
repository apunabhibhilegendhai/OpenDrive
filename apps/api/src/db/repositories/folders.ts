import type { SqlExecutor } from '../client.js';
import type { FolderEntity } from '../entities.js';
import { translateWriteError } from '../errors.js';
import { toPage } from '../../pagination.js';
import type { CursorPosition } from '../../pagination.js';
import { parseNullableTimestamp, parseTimestamp } from '../parse.js';

/**
 * Folders.
 *
 * Ownership is expressed through the same `owner_key` the database uses, so a folder query is
 * scoped by the principal the request was authenticated as — never by a folder id alone. Every
 * mutation takes `ownerKey` and includes it in the WHERE clause: an update that cannot see the row
 * updates nothing, which is the behaviour we want for a cross-owner attempt.
 *
 * The tree rules are the database's: composite foreign keys reject a parent owned by someone
 * else, and the guard trigger rejects a cycle or excessive depth. This module translates those
 * refusals into API problems rather than re-implementing them.
 */

interface FolderRow {
  id: string;
  ownerKind: 'user' | 'anonymous';
  ownerKey: string;
  ownerUserId: string | null;
  ownerSessionId: string | null;
  parentId: string | null;
  name: string;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function toFolder(row: FolderRow): FolderEntity {
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    ownerKey: row.ownerKey,
    ownerUserId: row.ownerUserId,
    ownerSessionId: row.ownerSessionId,
    parentId: row.parentId,
    name: row.name,
    depth: row.depth,
    createdAt: parseTimestamp(row.createdAt, 'folders.created_at'),
    updatedAt: parseTimestamp(row.updatedAt, 'folders.updated_at'),
    deletedAt: parseNullableTimestamp(row.deletedAt, 'folders.deleted_at'),
  };
}

export interface FolderOwner {
  readonly ownerKey: string;
  readonly ownerUserId: string | null;
  readonly ownerSessionId: string | null;
}

export async function findFolderById(
  sql: SqlExecutor,
  folderId: string,
  ownerKey: string,
): Promise<FolderEntity | null> {
  const rows = await sql<FolderRow[]>`
    select id,
           case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
           owner_key as "ownerKey", owner_user_id as "ownerUserId",
           owner_session_id as "ownerSessionId", parent_id as "parentId", name, depth,
           created_at as "createdAt", updated_at as "updatedAt", deleted_at as "deletedAt"
      from folders
     where id = ${folderId} and owner_key = ${ownerKey} and deleted_at is null
  `;
  const row = rows[0];
  return row === undefined ? null : toFolder(row);
}

/** A row that can be paginated; see `pagination.ts` and `ListFileRow` for the rationale. */
interface ListFolderRow extends FolderRow {
  cursorAt: string;
}

export interface ListFoldersOptions {
  /** `any` lists the whole tree, `root` only the top level, `folder` the children of one folder. */
  readonly scope: 'any' | 'root' | 'folder';
  readonly folderId?: string;
  /** Page size. One extra row is fetched internally to detect a following page. */
  readonly limit: number;
  readonly before?: CursorPosition | undefined;
}

export interface FolderPage {
  readonly items: FolderEntity[];
  readonly nextCursor: string | null;
}

/**
 * Keyset pagination on `(created_at, id)`. An offset would drift as rows are inserted and would
 * let a caller walk the whole table cheaply; a cursor cannot skip past a row it has not seen.
 */
export async function listFolders(
  sql: SqlExecutor,
  ownerKey: string,
  options: ListFoldersOptions,
): Promise<FolderPage> {
  const folderId = options.folderId ?? null;
  const cursorCreatedAt = options.before?.createdAt ?? null;
  const cursorId = options.before?.id ?? null;

  const rows = await sql<ListFolderRow[]>`
    select id,
           case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
           owner_key as "ownerKey", owner_user_id as "ownerUserId",
           owner_session_id as "ownerSessionId", parent_id as "parentId", name, depth,
           created_at as "createdAt", updated_at as "updatedAt", deleted_at as "deletedAt",
           to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
      from folders
     where owner_key = ${ownerKey}
       and deleted_at is null
       and case ${options.scope}::text
             when 'any' then true
             when 'root' then parent_id is null
             else parent_id = ${folderId}
           end
       and (${cursorCreatedAt}::timestamptz is null
            or (created_at, id) < (${cursorCreatedAt}, ${cursorId}::text))
     order by created_at desc, id desc
     limit ${options.limit + 1}
  `;

  const page = toPage(rows, options.limit);
  return { items: page.items.map(toFolder), nextCursor: page.nextCursor };
}

export async function createFolder(
  sql: SqlExecutor,
  input: {
    id: string;
    owner: FolderOwner;
    parentId: string | null;
    name: string;
  },
): Promise<FolderEntity> {
  try {
    const rows = await sql<FolderRow[]>`
      insert into folders (id, owner_user_id, owner_session_id, parent_id, name)
      values (${input.id}, ${input.owner.ownerUserId}, ${input.owner.ownerSessionId},
              ${input.parentId}, ${input.name})
      returning id,
                case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
                owner_key as "ownerKey", owner_user_id as "ownerUserId",
                owner_session_id as "ownerSessionId", parent_id as "parentId", name, depth,
                created_at as "createdAt", updated_at as "updatedAt", deleted_at as "deletedAt"
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('folder insert returned no row');
    return toFolder(row);
  } catch (error) {
    throw translateWriteError(error, 'The folder could not be created.');
  }
}

export async function renameFolder(
  sql: SqlExecutor,
  input: { folderId: string; ownerKey: string; name: string },
): Promise<FolderEntity | null> {
  try {
    const rows = await sql<FolderRow[]>`
      update folders
         set name = ${input.name}
       where id = ${input.folderId} and owner_key = ${input.ownerKey} and deleted_at is null
      returning id,
                case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
                owner_key as "ownerKey", owner_user_id as "ownerUserId",
                owner_session_id as "ownerSessionId", parent_id as "parentId", name, depth,
                created_at as "createdAt", updated_at as "updatedAt", deleted_at as "deletedAt"
    `;
    const row = rows[0];
    return row === undefined ? null : toFolder(row);
  } catch (error) {
    throw translateWriteError(error, 'The folder could not be renamed.');
  }
}

/**
 * Moves a folder. `parentId = null` moves it to the root.
 *
 * Depth for the moved folder and its whole subtree is recomputed by the database trigger, so a
 * caller cannot leave a stale `depth` behind by forgetting to fix it up.
 */
export async function moveFolder(
  sql: SqlExecutor,
  input: { folderId: string; ownerKey: string; parentId: string | null },
): Promise<FolderEntity | null> {
  try {
    const rows = await sql<FolderRow[]>`
      update folders
         set parent_id = ${input.parentId}
       where id = ${input.folderId} and owner_key = ${input.ownerKey} and deleted_at is null
      returning id,
                case when owner_user_id is null then 'anonymous' else 'user' end as "ownerKind",
                owner_key as "ownerKey", owner_user_id as "ownerUserId",
                owner_session_id as "ownerSessionId", parent_id as "parentId", name, depth,
                created_at as "createdAt", updated_at as "updatedAt", deleted_at as "deletedAt"
    `;
    const row = rows[0];
    return row === undefined ? null : toFolder(row);
  } catch (error) {
    throw translateWriteError(error, 'The folder could not be moved.');
  }
}

/**
 * Soft-deletes an empty folder.
 *
 * "Empty" is checked inside the same statement, so a concurrent insert into the folder cannot slip
 * between the check and the write: the condition and the update are one snapshot. A folder with
 * live children is left alone and the caller is told the folder is not empty — never silently
 * cascaded, because a delete that removes files nobody named is how data disappears.
 */
export async function softDeleteFolder(
  sql: SqlExecutor,
  input: { folderId: string; ownerKey: string },
): Promise<'deleted' | 'not_found' | 'not_empty'> {
  const existing = await findFolderById(sql, input.folderId, input.ownerKey);
  if (existing === null) return 'not_found';

  const rows = await sql<{ id: string }[]>`
    update folders f
       set deleted_at = now()
     where f.id = ${input.folderId}
       and f.owner_key = ${input.ownerKey}
       and f.deleted_at is null
       and not exists (
         select 1 from folders c
          where c.parent_id = f.id and c.deleted_at is null
       )
       and not exists (
         select 1 from files x
          where x.folder_id = f.id and x.deleted_at is null
       )
    returning f.id
  `;
  return rows.length > 0 ? 'deleted' : 'not_empty';
}
