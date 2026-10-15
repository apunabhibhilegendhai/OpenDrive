import type { MigrationFolder, MigrationResources } from '../../identity/migration.js';
import type { SqlExecutor } from '../client.js';
import type { AnonymousSessionEntity } from '../entities.js';
import { parseByteCount, parseNullableTimestamp, parseTimestamp } from '../parse.js';

/**
 * Transferring an anonymous session's resources into an account.
 *
 * Every function here takes a `SqlExecutor`, so the whole transfer runs inside one transaction
 * started by the caller. That is not a convenience: ownership is expressed as `owner_key`, which is
 * a generated column on `files`, `folders`, `usage_counters` and `quota_reservations`, and it is
 * referenced by composite foreign keys (`folders_parent_same_owner`, `files_folder_same_owner`).
 * Half a transfer would leave rows whose owner and whose parent disagree, which the database
 * correctly refuses — so the transfer is all-or-nothing by construction, not by convention.
 *
 * Two lock rules make concurrent requests safe:
 *
 *   * The **session row** is locked before anything is read or moved. Two requests migrating the
 *     same session serialize here, and the second finds the record already written rather than
 *     moving the same rows twice.
 *   * The **account's profile row** is locked too, because `opendrive_reserve_storage` takes the
 *     same lock for its own quota check. Without it, an upload committed between the migration's
 *     quota check and its transfer could push the account over its limit with no refusal anywhere.
 *
 * Nothing in this module accepts a user id, a session id or an owner key from a request: the ids
 * come from a verified credential and from the locked row, and the ownership columns are written
 * from those.
 */

interface SessionRow {
  id: string;
  credentialHash: string;
  status: AnonymousSessionEntity['status'];
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  migratedAt: Date | null;
  migratedToUserId: string | null;
  migratedFileCount: number | null;
  migratedBytes: string | number | null;
  migratedFolders: number | null;
  migratedSkippedFiles: number | null;
}

function toSession(row: SessionRow): AnonymousSessionEntity {
  return {
    id: row.id,
    credentialHash: row.credentialHash,
    status: row.status,
    createdAt: parseTimestamp(row.createdAt, 'anonymous_sessions.created_at'),
    expiresAt: parseTimestamp(row.expiresAt, 'anonymous_sessions.expires_at'),
    lastUsedAt: parseNullableTimestamp(row.lastUsedAt, 'anonymous_sessions.last_used_at'),
    revokedAt: parseNullableTimestamp(row.revokedAt, 'anonymous_sessions.revoked_at'),
    migratedAt: parseNullableTimestamp(row.migratedAt, 'anonymous_sessions.migrated_at'),
    migratedToUserId: row.migratedToUserId,
    migratedFileCount: row.migratedFileCount,
    migratedBytes:
      row.migratedBytes === null
        ? null
        : parseByteCount(row.migratedBytes, 'anonymous_sessions.migrated_bytes'),
    migratedFolders: row.migratedFolders,
    migratedSkippedFiles: row.migratedSkippedFiles,
  };
}

/**
 * Reads the session for the presented credential digest, taking a write lock on the row.
 *
 * The lock is what makes "may this be migrated?" and "move it" one decision: without it two
 * concurrent requests could both decide `proceed`.
 */
export async function lockAnonymousSessionByCredentialHash(
  sql: SqlExecutor,
  credentialHash: string,
): Promise<AnonymousSessionEntity | null> {
  const rows = await sql<SessionRow[]>`
    select id, credential_hash as "credentialHash", status, created_at as "createdAt",
           expires_at as "expiresAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt",
           migrated_at as "migratedAt", migrated_to_user_id as "migratedToUserId",
           migrated_file_count as "migratedFileCount", migrated_bytes as "migratedBytes",
           migrated_folders as "migratedFolders", migrated_skipped_files as "migratedSkippedFiles"
      from anonymous_sessions
     where credential_hash = ${credentialHash}
       for update
  `;
  const row = rows[0];
  return row === undefined ? null : toSession(row);
}

/**
 * Locks the account's profile row, returning false when there is no such account.
 *
 * Reused as the serialization point against concurrent uploads (see the module comment). A missing
 * profile means the user has never used the API, which cannot happen for a request that just
 * authenticated as them — the identity layer ensures the row first — so a `false` here is a
 * server-side inconsistency the caller reports as such.
 */
export async function lockProfileForQuota(sql: SqlExecutor, userId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    select id from profiles where id = ${userId} for update
  `;
  return rows.length > 0;
}

/** What the session holds: durable files and bytes, folders, and files it can never hand over. */
export async function countMigratableResources(
  sql: SqlExecutor,
  sessionId: string,
): Promise<MigrationResources> {
  const rows = await sql<
    { files: number; bytes: string | number; incompleteFiles: number; folders: number }[]
  >`
    with live as (
      select size_bytes, status
        from files
       where owner_session_id = ${sessionId} and deleted_at is null
    )
    select
      (select count(*)::int from live where status not in ('pending_upload', 'uploading', 'failed'))
        as "files",
      (select coalesce(sum(size_bytes), 0)::bigint from live
        where status not in ('pending_upload', 'uploading', 'failed')) as "bytes",
      (select count(*)::int from live where status in ('pending_upload', 'uploading', 'failed'))
        as "incompleteFiles",
      (select count(*)::int from folders
        where owner_session_id = ${sessionId} and deleted_at is null) as "folders"
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('migration resource count returned no row');
  return {
    files: row.files,
    bytes: parseByteCount(row.bytes, 'migration.bytes'),
    folders: row.folders,
    incompleteFiles: row.incompleteFiles,
  };
}

/** The session's live root folders — the only names that can collide with the account's. */
export async function listSessionRootFolders(
  sql: SqlExecutor,
  sessionId: string,
): Promise<MigrationFolder[]> {
  const rows = await sql<{ id: string; name: string; parentId: string | null }[]>`
    select id, name, parent_id as "parentId"
      from folders
     where owner_session_id = ${sessionId} and deleted_at is null and parent_id is null
     order by id
  `;
  return rows;
}

/** Names the account already has at its root, compared case-insensitively by the database. */
export async function listAccountRootFolderNames(
  sql: SqlExecutor,
  userId: string,
): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select name
      from folders
     where owner_user_id = ${userId} and deleted_at is null and parent_id is null
  `;
  return rows.map((row) => row.name);
}

/**
 * Renames one root folder that is still owned by the session.
 *
 * Scoped by `owner_session_id`, not by the id alone: a rename that matched another principal's
 * folder would be a cross-owner write, and the scope makes that impossible even if an id is wrong.
 */
export async function renameSessionFolder(
  sql: SqlExecutor,
  input: { folderId: string; sessionId: string; name: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update folders
       set name = ${input.name}
     where id = ${input.folderId}
       and owner_session_id = ${input.sessionId}
       and deleted_at is null
    returning id
  `;
  return rows.length > 0;
}

/** What a transfer moved, counted from the rows the statements themselves touched. */
export interface OwnershipTransfer {
  readonly folders: number;
  readonly files: { readonly count: number; readonly bytes: number };
  /** Live files with no retrievable bytes, closed instead of transferred, plus detached tombstones. */
  readonly skippedIncompleteFiles: number;
}

/**
 * Moves everything the session holds into the account — **in one statement, and it has to be one**.
 *
 * The reason is not brevity. Ownership is expressed by `owner_key`, and two composite foreign keys
 * reference it: `folders_parent_same_owner` (`folders(parent_id, owner_key)`) and
 * `files_folder_same_owner` (`files(folder_id, owner_key)`). Both are immediate. Moving a folder
 * first makes every file inside it dangle (the file still carries the session's key while the
 * folder now carries the account's), and moving the files first makes them dangle against the
 * folder. There is no order that works, and `SET CONSTRAINTS DEFERRED` is unavailable because the
 * constraints are not deferrable. One statement means every set of rows changes together and the
 * checks see the finished state — which is exactly the atomicity the transfer needs.
 *
 * Five sets of rows, one per part of the two problems above:
 *
 *   1. **Live folders move.** `deleted_at is null`, so only the tree the account will see moves.
 *   2. **Durable files move**, with `deletion_token_hash` cleared. That token was the anonymous
 *      uploader's only way to manage the file, and the file now belongs to an account: a live token
 *      would let a credential issued to an anonymous session delete data the account owns. The
 *      account deletes through its own credential instead.
 *   3. **Unfinished uploads are closed**, not moved: a `pending_upload`, `uploading` or `failed` row
 *      has no retrievable object, and the credential that could resume it is about to be revoked, so
 *      nobody could ever finish it. They are detached from the folder in the same breath — their
 *      folder is becoming the account's, and a session-owned row may not reference it.
 *   4. **Soft-deleted files are detached** (`folder_id = null`) and stay the session's. They are
 *      invisible either way, and the account should not inherit tombstones it did not create.
 *   5. **Soft-deleted folders are detached** from their parent for the same reason. They cannot have
 *      live children — soft-deleting a folder requires it to be empty — so detaching the tombstone
 *      cannot leave a live row behind.
 *
 * The first two counts are read back from the rows the statement moved rather than from the earlier
 * measurement: those differ only if something changed in between, and the caller should be told what
 * happened, not what was expected.
 *
 * **The constraints are deferred for the duration of this statement and validated immediately
 * after.** Both foreign keys are `deferrable initially immediate` (see
 * `supabase/migrations/20261015000001_defer_ownership_constraints.sql`), which means every other
 * code path in this application still checks at the end of each statement, unchanged. The transfer
 * asks for deferral because no ordering of folders-before-files or files-before-folders satisfies
 * an immediate check — folder-first was refused live by `files_folder_same_owner` — and running
 * everything in one data-modifying statement only appears to work: PostgreSQL specifies no order
 * for its CTEs, so a run that passes does not make the rule hold. The `set constraints ...
 * immediate` at the end is not bookkeeping: flipping the mode back forces the check at that exact
 * point, so a transfer that left a row dangling fails here, inside the transaction, rather than at
 * commit or — worse — not at all until somebody walks the tree.
 */
export async function transferSessionOwnership(
  sql: SqlExecutor,
  input: { sessionId: string; userId: string },
): Promise<OwnershipTransfer> {
  await sql`set constraints files_folder_same_owner, folders_parent_same_owner deferred`;

  const rows = await sql<
    { folders: number; files: number; bytes: string | number; skipped: number }[]
  >`
    with moved_folders as (
      update folders
         set owner_user_id = ${input.userId}, owner_session_id = null
       where owner_session_id = ${input.sessionId}
         and deleted_at is null
      returning id
    ), moved_files as (
      update files
         set owner_user_id = ${input.userId},
             owner_session_id = null,
             deletion_token_hash = null
       where owner_session_id = ${input.sessionId}
         and deleted_at is null
         and status not in ('pending_upload', 'uploading', 'failed')
      returning size_bytes
    ), closed_files as (
      update files
         set status = 'deleted',
             deleted_at = now(),
             deletion_token_hash = null,
             folder_id = null
       where owner_session_id = ${input.sessionId}
         and deleted_at is null
         and status in ('pending_upload', 'uploading', 'failed')
      returning id
    ), detached_files as (
      update files
         set folder_id = null
       where owner_session_id = ${input.sessionId}
         and deleted_at is not null
         and folder_id is not null
      returning id
    ), detached_folders as (
      update folders
         set parent_id = null
       where owner_session_id = ${input.sessionId}
         and deleted_at is not null
         and parent_id is not null
      returning id
    )
    select
      (select count(*)::int from moved_folders) as "folders",
      (select count(*)::int from moved_files) as "files",
      (select coalesce(sum(size_bytes), 0)::bigint from moved_files) as "bytes",
      ((select count(*)::int from closed_files)
        + (select count(*)::int from detached_files)) as "skipped"
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('ownership transfer returned no row');

  // Back to the default mode, which validates every deferred check right now.
  await sql`set constraints files_folder_same_owner, folders_parent_same_owner immediate`;

  return {
    folders: row.folders,
    files: { count: row.files, bytes: parseByteCount(row.bytes, 'migration.transferredBytes') },
    skippedIncompleteFiles: row.skipped,
  };
}

/**
 * Releases every quota hold the session still carries.
 *
 * A hold exists for an upload that is expected to finish. Once the session is migrated, no upload
 * under it can finish: the credential stops working. Releasing here means the anonymous principal's
 * abandoned holds cannot sit on quota that is now the account's, and the transition honours the
 * table's own consistency rule (released implies `released_at`).
 */
export async function releaseSessionReservations(
  sql: SqlExecutor,
  sessionId: string,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update quota_reservations
       set state = 'released', released_at = now()
     where owner_session_id = ${sessionId} and state = 'held'
    returning id
  `;
  return rows.length;
}

/**
 * Writes the migration record and revokes the session, in one statement.
 *
 * The `where` clause is a compare-and-set on the state the caller decided from: `status = 'active'
 * and migrated_at is null`. Under the row lock this can only fail if the row changed underneath the
 * decision, which would be a bug rather than a race — the caller treats `null` as an internal
 * inconsistency instead of guessing.
 */
export async function recordSessionMigration(
  sql: SqlExecutor,
  input: {
    sessionId: string;
    userId: string;
    files: number;
    bytes: number;
    folders: number;
    skippedFiles: number;
  },
): Promise<AnonymousSessionEntity | null> {
  const rows = await sql<SessionRow[]>`
    update anonymous_sessions
       set status = 'revoked',
           revoked_at = now(),
           migrated_at = now(),
           migrated_to_user_id = ${input.userId},
           migrated_file_count = ${input.files},
           migrated_bytes = ${input.bytes},
           migrated_folders = ${input.folders},
           migrated_skipped_files = ${input.skippedFiles}
     where id = ${input.sessionId}
       and status = 'active'
       and migrated_at is null
    returning id, credential_hash as "credentialHash", status, created_at as "createdAt",
              expires_at as "expiresAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt",
              migrated_at as "migratedAt", migrated_to_user_id as "migratedToUserId",
              migrated_file_count as "migratedFileCount", migrated_bytes as "migratedBytes",
              migrated_folders as "migratedFolders", migrated_skipped_files as "migratedSkippedFiles"
  `;
  const row = rows[0];
  return row === undefined ? null : toSession(row);
}
