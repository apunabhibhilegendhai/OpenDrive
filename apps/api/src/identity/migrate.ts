import { AppError, credentialDigest } from '@opendrive/shared';
import type { Sql } from '../db/client.js';
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/repositories/audit.js';
import {
  countMigratableResources,
  listAccountRootFolderNames,
  listSessionRootFolders,
  lockAnonymousSessionByCredentialHash,
  lockProfileForQuota,
  recordSessionMigration,
  releaseSessionReservations,
  renameSessionFolder,
  transferSessionOwnership,
} from '../db/repositories/migration.js';
import { readQuotaSummary } from '../db/repositories/quota.js';
import {
  assessQuota,
  decideMigration,
  planRootRenames,
  type FolderRename,
  type MigrationDecision,
} from './migration.js';
import { quotaRefusalProblem } from '../problems.js';

/**
 * Bringing an anonymous session's resources into a registered account.
 *
 * The whole transfer is one transaction over one locked session row, so it either happens once or
 * not at all. The rules it enforces are stated in `identity/migration.ts` (pure, tested) and applied
 * here; this module is the part that touches the database.
 *
 * What a caller has to prove, and what it never has to say:
 *
 *   * **Who they are** — from the credential the request was authenticated with. The account is
 *     never named in the body, and there is no field that could name another one.
 *   * **That they hold the session** — from the `ods_…` credential, compared against the stored
 *     digest in constant time. Holding that credential *is* the ownership proof for the session's
 *     data; it is the same proof the session's own routes accept. There is deliberately no second
 *     factor, because there is nothing else that could distinguish the anonymous uploader from
 *     somebody they gave the credential to.
 *
 * A session that has already been migrated answers a repeat from the recorded counts
 * (idempotent), refuses any other account without naming the one that holds it, and never hands the
 * same rows to two owners.
 */

export interface MigrationOutcome {
  readonly sessionId: string;
  readonly targetUserId: string;
  readonly migratedAt: string;
  readonly alreadyMigrated: boolean;
  readonly files: { readonly count: number; readonly bytes: number };
  readonly folders: { readonly count: number };
  readonly skippedIncompleteFiles: number;
  readonly folderRenames: readonly FolderRename[];
}

function inconsistent(): AppError {
  return new AppError('INTERNAL', {
    detail: 'The session and its migration record disagreed about their state.',
    expose: false,
  });
}

/**
 * The problem document for a refusal.
 *
 * A revoked or expired session credential is an authentication failure, exactly as it is on every
 * other route, which is why those two answer 401 rather than 409. `migrated_elsewhere` is a
 * conflict whose detail deliberately does not name the account that holds the resources: the caller
 * holds the session credential, but being told *which* account received the data is a fact about
 * somebody else's account that this route has no reason to disclose.
 */
export function migrationRefusalProblem(
  decision: Extract<MigrationDecision, { kind: 'refused' }>,
): AppError {
  switch (decision.reason) {
    case 'session_inactive':
    case 'session_expired':
      return new AppError('UNAUTHENTICATED', { detail: decision.detail });
    case 'migrated_elsewhere':
    case 'nothing_to_migrate':
      return new AppError('CONFLICT', {
        detail: decision.detail,
        context: { reason: decision.reason },
      });
    case 'record_inconsistent':
      return inconsistent();
  }
}

export async function migrateAnonymousSessionIntoAccount(
  sql: Sql,
  input: {
    /** The `ods_…` credential presented by the caller. Hashed before it is looked up. */
    readonly anonymousCredential: string;
    /** The account, from the verified request identity. Never from a body. */
    readonly targetUserId: string;
    readonly requestId: string | null;
    readonly actorIpHash: string | null;
    /** Injectable clock, so expiry behaviour is testable. */
    readonly now?: () => Date;
  },
): Promise<MigrationOutcome> {
  const now = (input.now ?? (() => new Date()))();
  const digest = await credentialDigest(input.anonymousCredential);

  return await sql.begin(async (tx) => {
    const session = await lockAnonymousSessionByCredentialHash(tx, digest);
    if (session === null) {
      throw new AppError('UNAUTHENTICATED', {
        detail: 'The anonymous session credential is not valid.',
      });
    }

    // The account's row is locked before its room is measured, so a concurrent upload cannot commit
    // between the check and the transfer. `opendrive_reserve_storage` takes the same lock.
    if (!(await lockProfileForQuota(tx, input.targetUserId))) throw inconsistent();

    const resources = await countMigratableResources(tx, session.id);
    const decision = decideMigration({
      session,
      targetUserId: input.targetUserId,
      resources,
      now,
    });

    if (decision.kind === 'refused') throw migrationRefusalProblem(decision);

    if (decision.kind === 'replay') {
      if (session.migratedAt === null) throw inconsistent();
      return {
        sessionId: session.id,
        targetUserId: input.targetUserId,
        migratedAt: session.migratedAt.toISOString(),
        alreadyMigrated: true,
        files: decision.summary.files,
        folders: decision.summary.folders,
        skippedIncompleteFiles: decision.summary.skippedIncompleteFiles,
        folderRenames: decision.summary.folderRenames,
      };
    }

    // Room is measured with the same function uploads use, so a migration can never be allowed
    // where a single file of the same size would be refused.
    const summary = await readQuotaSummary(tx, {
      ownerUserId: input.targetUserId,
      ownerSessionId: null,
    });
    if (!summary.ok) throw quotaRefusalProblem(summary.reason);
    const room = {
      remainingBytes: summary.summary.storageRemainingBytes,
      remainingFiles: summary.summary.maxFiles - summary.summary.fileCount,
    };
    const fits = assessQuota({ ...room, needed: resources });
    if (!fits.ok) {
      throw quotaRefusalProblem(
        fits.reason,
        fits.reason === 'file_count_exceeded'
          ? `This session holds ${resources.files} files and this account can hold ${room.remainingFiles} more.`
          : `This session holds ${resources.bytes} bytes and this account has ${room.remainingBytes} bytes of room.`,
      );
    }

    // Renames happen before the owner changes: the session's own names are unique among themselves,
    // so the only collisions are with names the account already has at its root.
    const renames = planRootRenames(
      await listSessionRootFolders(tx, session.id),
      await listAccountRootFolderNames(tx, input.targetUserId),
    );
    for (const rename of renames) {
      const renamed = await renameSessionFolder(tx, {
        folderId: rename.folderId,
        sessionId: session.id,
        name: rename.to,
      });
      if (!renamed) throw inconsistent();
    }

    // One statement for the whole ownership change: `folders_parent_same_owner` and
    // `files_folder_same_owner` are immediate composite keys over `owner_key`, so any split of this
    // work into separate statements leaves half the tree dangling and is refused by the database.
    // See `transferSessionOwnership` for what each part moves and why.
    const transferred = await transferSessionOwnership(tx, {
      sessionId: session.id,
      userId: input.targetUserId,
    });
    const folders = transferred.folders;
    const files = transferred.files;
    const skipped = transferred.skippedIncompleteFiles;
    await releaseSessionReservations(tx, session.id);

    const recorded = await recordSessionMigration(tx, {
      sessionId: session.id,
      userId: input.targetUserId,
      // The counts reported are the ones the statements moved, not the earlier estimate.
      files: files.count,
      bytes: files.bytes,
      folders,
      skippedFiles: skipped,
    });
    if (recorded === null || recorded.migratedAt === null) throw inconsistent();

    await recordAuditEvent(tx, {
      actorKind: 'user',
      actorUserId: input.targetUserId,
      action: AUDIT_ACTIONS.anonymousSessionMigrated,
      subjectType: 'system',
      subjectId: session.id,
      requestId: input.requestId,
      actorIpHash: input.actorIpHash,
      metadata: {
        files: files.count,
        bytes: files.bytes,
        folders,
        skippedIncompleteFiles: skipped,
        renamedFolders: renames.length,
      },
    });

    return {
      sessionId: session.id,
      targetUserId: input.targetUserId,
      migratedAt: recorded.migratedAt.toISOString(),
      alreadyMigrated: false,
      files,
      folders: { count: folders },
      skippedIncompleteFiles: skipped,
      folderRenames: renames,
    };
  });
}
