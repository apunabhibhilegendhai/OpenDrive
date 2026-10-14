import type { ShareKind, ShareStatus } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';
import type { ShareEntity } from '../entities.js';
import { translateWriteError } from '../errors.js';
import { parseNullableTimestamp, parseTimestamp } from '../parse.js';

/**
 * Share links.
 *
 * The token is a bearer credential, so the only thing stored — and the only thing looked up — is
 * its SHA-256 digest. `token_hash` is unique, which makes resolution a single index hit and means
 * two identical tokens cannot both exist.
 *
 * Resolution deliberately returns revoked and expired rows: the decision belongs to
 * `resolveShareLink` in the shared package, which checks status, expiry, allowance and the file's
 * current state together. Filtering in SQL would hide the reason from the audit trail.
 */

interface ShareRow {
  id: string;
  fileId: string;
  kind: ShareKind;
  status: ShareStatus;
  tokenHash: string;
  createdBy: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

function toShare(row: ShareRow): ShareEntity {
  return {
    id: row.id,
    fileId: row.fileId,
    kind: row.kind,
    status: row.status,
    tokenHash: row.tokenHash,
    createdBy: row.createdBy,
    maxDownloads: row.maxDownloads,
    downloadCount: row.downloadCount,
    createdAt: parseTimestamp(row.createdAt, 'shares.created_at'),
    expiresAt: parseNullableTimestamp(row.expiresAt, 'shares.expires_at'),
    revokedAt: parseNullableTimestamp(row.revokedAt, 'shares.revoked_at'),
  };
}

export async function insertShare(
  sql: SqlExecutor,
  input: {
    id: string;
    fileId: string;
    kind: ShareKind;
    tokenHash: string;
    createdBy: string | null;
    maxDownloads: number | null;
    expiresAt: Date | null;
  },
): Promise<ShareEntity> {
  try {
    const rows = await sql<ShareRow[]>`
      insert into shares (id, file_id, kind, token_hash, created_by, max_downloads, expires_at)
      values (${input.id}, ${input.fileId}, ${input.kind}, ${input.tokenHash},
              ${input.createdBy}, ${input.maxDownloads}, ${input.expiresAt})
      returning id, file_id as "fileId", kind, status, token_hash as "tokenHash",
                created_by as "createdBy", max_downloads as "maxDownloads",
                download_count as "downloadCount", created_at as "createdAt",
                expires_at as "expiresAt", revoked_at as "revokedAt"
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('share insert returned no row');
    return toShare(row);
  } catch (error) {
    throw translateWriteError(error, 'The share link could not be created.');
  }
}

export async function findShareByTokenHash(
  sql: SqlExecutor,
  tokenHash: string,
): Promise<ShareEntity | null> {
  const rows = await sql<ShareRow[]>`
    select id, file_id as "fileId", kind, status, token_hash as "tokenHash",
           created_by as "createdBy", max_downloads as "maxDownloads",
           download_count as "downloadCount", created_at as "createdAt",
           expires_at as "expiresAt", revoked_at as "revokedAt"
      from shares
     where token_hash = ${tokenHash}
  `;
  const row = rows[0];
  return row === undefined ? null : toShare(row);
}

export async function listSharesForFile(sql: SqlExecutor, fileId: string): Promise<ShareEntity[]> {
  const rows = await sql<ShareRow[]>`
    select id, file_id as "fileId", kind, status, token_hash as "tokenHash",
           created_by as "createdBy", max_downloads as "maxDownloads",
           download_count as "downloadCount", created_at as "createdAt",
           expires_at as "expiresAt", revoked_at as "revokedAt"
      from shares
     where file_id = ${fileId}
     order by created_at desc
  `;
  return rows.map(toShare);
}

/**
 * Revokes a share link by id, scoped to the owner of the file it points at.
 *
 * `status` and `revoked_at` are written together because the table's consistency check requires
 * it, and the owner join is what stops one user from revoking another user's link. Returns false
 * when nothing matched, which the caller reports as "not found" — not as "already revoked".
 */
export async function revokeShare(
  sql: SqlExecutor,
  input: { shareId: string; ownerUserId: string | null; ownerSessionId: string | null },
): Promise<ShareEntity | null> {
  try {
    const rows = await sql<ShareRow[]>`
      update shares s
         set status = 'revoked', revoked_at = now()
        from files f
       where s.id = ${input.shareId}
         and f.id = s.file_id
         and ((f.owner_user_id is not null and f.owner_user_id = ${input.ownerUserId}::uuid)
              or (f.owner_session_id is not null and f.owner_session_id = ${input.ownerSessionId}::text))
         and s.revoked_at is null
      returning s.id, s.file_id as "fileId", s.kind, s.status, s.token_hash as "tokenHash",
                s.created_by as "createdBy", s.max_downloads as "maxDownloads",
                s.download_count as "downloadCount", s.created_at as "createdAt",
                s.expires_at as "expiresAt", s.revoked_at as "revokedAt"
    `;
    const row = rows[0];
    return row === undefined ? null : toShare(row);
  } catch (error) {
    throw translateWriteError(error, 'The share link could not be revoked.');
  }
}

/**
 * Counts one open against a link, atomically, and refuses past its allowance.
 *
 * The public landing page resolves the link (status, expiry, file state) a moment before calling
 * this, so the allowance itself is enforced *here*, as part of the write: two requests that both
 * read the last free slot cannot both increment it. Returns the new count, or `null` when nothing
 * matched — revoked, expired, or already at its cap by the time the row was locked. The caller
 * answers a `null` with the same refusal it gives a dead link, so a race cannot become a free open.
 */
export async function countShareOpen(sql: SqlExecutor, shareId: string): Promise<number | null> {
  try {
    const rows = await sql<{ downloadCount: number }[]>`
      update shares
         set download_count = download_count + 1
       where id = ${shareId}
         and status = 'active'
         and revoked_at is null
         and (expires_at is null or expires_at > now())
         and (max_downloads is null or download_count < max_downloads)
      returning download_count as "downloadCount"
    `;
    const row = rows[0];
    return row === undefined ? null : row.downloadCount;
  } catch (error) {
    throw translateWriteError(error, 'The share link could not be counted.');
  }
}
