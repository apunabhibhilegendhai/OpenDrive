import {
  ANONYMOUS_CREDENTIAL_HEADER,
  ANONYMOUS_SESSION_CREDENTIAL_PATTERN,
  AppError,
  validationFailed,
} from '@opendrive/shared';
import type { RequestIdentity } from '../auth/identity.js';
import { requireSessionCredential } from '../authz.js';
import type { AnonymousSessionEntity } from '../db/entities.js';

/**
 * Bringing an anonymous session's resources into an account: the decisions, without any I/O.
 *
 * The transfer itself is a handful of statements in one transaction (see
 * `db/repositories/migration.ts`), but everything that *decides* something lives here so it can be
 * reasoned about and tested directly: whether this session may be migrated at all, whether the
 * account has room, which folders need renaming, and what a repeat of the same request answers.
 *
 * Three rules shape all of it:
 *
 *   * **A session migrates once, into one account.** The record of where it went is what makes a
 *     repeat idempotent for that account and a refusal for any other. Resources never move between
 *     accounts, and a caller is never told *which* account holds a session it does not.
 *   * **Only durable resources move.** A file with no retrievable bytes — an abandoned or failed
 *     upload — is not "kept" by transferring it: its record is closed instead, and the count is
 *     reported rather than hidden.
 *   * **A name collision is renamed, never overwritten.** Sibling names are unique per parent in
 *     the database. Migration picks a new name for a colliding *root* folder and reports the
 *     rename, because refusing the whole migration over a name the person cannot see yet would be
 *     a worse answer than "Photos 2".
 *
 * The route that serves this is a thin adapter: it hands `planMigrationRequest` the verified
 * identity and the one header it reads, and receives back either a refusal or the two facts the
 * transfer needs. Keeping that decision here — rather than spread through the handler — is what
 * makes "who may migrate, and into which account" testable without a database, and leaves the
 * handler no way to name an account the request body asked for, because it never sees the body.
 */

export interface MigrationFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

export interface FolderRename {
  readonly folderId: string;
  readonly from: string;
  readonly to: string;
}

/** What the session actually holds, counted inside the same transaction that moves it. */
export interface MigrationResources {
  /** Files in a state that implies retrievable bytes. */
  readonly files: number;
  readonly bytes: number;
  readonly folders: number;
  /** Files that will be closed rather than transferred (abandoned or failed uploads). */
  readonly incompleteFiles: number;
}

export interface MigrationSummary {
  readonly files: { readonly count: number; readonly bytes: number };
  readonly folders: { readonly count: number };
  readonly skippedIncompleteFiles: number;
  readonly folderRenames: readonly FolderRename[];
}

export type MigrationDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'replay'; readonly summary: MigrationSummary }
  | {
      readonly kind: 'refused';
      /** Stable, machine-readable reason. Never contains an account id it does not have to. */
      readonly reason:
        | 'session_inactive'
        | 'session_expired'
        | 'migrated_elsewhere'
        | 'nothing_to_migrate'
        | 'record_inconsistent';
      readonly detail: string;
    };

/** What a migration request is allowed to ask for, once the caller has been authorized. */
export interface MigrationRequestPlan {
  /**
   * The account the resources will belong to. It comes from the verified identity and there is no
   * request field that could carry another one: the route has no body schema at all.
   */
  readonly targetUserId: string;
  /** The anonymous session whose resources move, identified by the credential that proves ownership. */
  readonly anonymousCredential: string;
}

/**
 * Authorizes a migration request and reads the two facts it may supply.
 *
 * Three refusals, in this order, each with the status the contract promises:
 *
 *   1. **401** when the request carries no credential at all.
 *   2. **403** when the caller is not the right kind of principal for this operation. An anonymous
 *      session is refused because it would be migrating into itself — it has no account to receive
 *      anything — and an API key is refused by `account:manage` because "absorb another principal's
 *      files" is an account change, not a file operation. A key that could do this could launder an
 *      anonymous session's files into its owner's account without the person ever signing in.
 *   3. **400/401** for the presented session credential: absent is a validation failure the client
 *      can fix, malformed is refused as unauthenticated before the database is consulted, exactly
 *      as it is for an API key.
 *
 * The credential is *not* resolved here. Looking a session up, and refusing one that is revoked,
 * expired or already migrated, happens inside the locked transaction — a decision that has to be
 * made against the row it locks, not against a copy read beforehand.
 */
export function planMigrationRequest(input: {
  readonly identity: RequestIdentity;
  readonly presentedCredential: string | undefined;
}): MigrationRequestPlan {
  const user = requireSessionCredential(input.identity, 'account:manage');

  const credential = input.presentedCredential?.trim() ?? '';
  if (credential === '') {
    throw validationFailed('The anonymous session credential is required.', [
      { path: ANONYMOUS_CREDENTIAL_HEADER, message: 'missing from the request headers' },
    ]);
  }
  if (!ANONYMOUS_SESSION_CREDENTIAL_PATTERN.test(credential)) {
    throw new AppError('UNAUTHENTICATED', {
      detail: 'The anonymous session credential is not valid.',
    });
  }

  return { targetUserId: user.principal.userId, anonymousCredential: credential };
}

const MAX_FOLDER_NAME_LENGTH = 255;
const RENAME_SUFFIX = 'migrated';

/** Sibling names are compared case-insensitively, matching the unique index the database applies. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Truncates a base name so `base + suffix` still fits the column's 255-character limit. */
function withSuffix(base: string, suffix: string): string {
  const room = MAX_FOLDER_NAME_LENGTH - suffix.length;
  const trimmed = base.length <= room ? base : base.slice(0, room).trimEnd();
  // A base that is nothing but whitespace would produce a blank name, which the column rejects.
  return `${trimmed === '' ? 'folder' : trimmed}${suffix}`;
}

/**
 * The new names for migrating root folders that collide with a name the account already has.
 *
 * Only roots are considered: a colliding *inner* folder name is fine, because its whole sibling set
 * moves with it (the session's own names are unique among themselves, which the database already
 * guarantees). Roots are the only place two previously separate trees meet.
 *
 * Each name is chosen against both the account's existing names and the names this plan has already
 * handed out, so a migration can never pick a name it is about to use itself.
 */
export function planRootRenames(
  migrating: readonly MigrationFolder[],
  takenRootNames: readonly string[],
): FolderRename[] {
  const taken = new Set(takenRootNames.map(nameKey));
  const renames: FolderRename[] = [];

  // Sorted by id purely so a given input always produces the same plan: two roots cannot share a
  // name (the session's own uniqueness), so ordering cannot change the outcome — but a
  // deterministic order makes the reported list stable, which is what a test and a person read.
  const roots = migrating
    .filter((folder) => folder.parentId === null)
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const root of roots) {
    const key = nameKey(root.name);
    if (!taken.has(key)) {
      taken.add(key);
      continue;
    }

    let candidate = withSuffix(root.name, ` (${RENAME_SUFFIX})`);
    let counter = 2;
    while (taken.has(nameKey(candidate))) {
      candidate = withSuffix(root.name, ` (${RENAME_SUFFIX} ${counter})`);
      counter += 1;
    }
    taken.add(nameKey(candidate));
    renames.push({ folderId: root.id, from: root.name, to: candidate });
  }

  return renames;
}

/**
 * Whether this session may be migrated into this account, and what to answer.
 *
 * Order matters. A session already migrated to *this* account is a replay before anything else is
 * considered, because its rows are no longer the session's and its status is already `revoked`. A
 * session migrated to a *different* account is a refusal that must not name that account. Only then
 * do revocation, expiry and emptiness decide.
 */
export function decideMigration(input: {
  readonly session: AnonymousSessionEntity;
  readonly targetUserId: string;
  readonly resources: MigrationResources;
  readonly now: Date;
}): MigrationDecision {
  const { session, targetUserId, resources, now } = input;

  if (session.migratedAt !== null) {
    if (session.migratedToUserId === targetUserId) {
      if (
        session.migratedFileCount === null ||
        session.migratedBytes === null ||
        session.migratedFolders === null
      ) {
        // Written in one statement, so this cannot happen through this API. If it does, an operator
        // has edited the row: reporting invented counts would be worse than saying so.
        return {
          kind: 'refused',
          reason: 'record_inconsistent',
          detail: 'This session’s migration record is incomplete. Contact the operator.',
        };
      }
      return {
        kind: 'replay',
        summary: {
          files: { count: session.migratedFileCount, bytes: session.migratedBytes },
          folders: { count: session.migratedFolders },
          skippedIncompleteFiles: session.migratedSkippedFiles ?? 0,
          // The renames were reported when they happened; a replay repeats the totals, not the
          // history. Nothing was renamed a second time.
          folderRenames: [],
        },
      };
    }
    return {
      kind: 'refused',
      reason: 'migrated_elsewhere',
      detail:
        'This anonymous session has already been brought into an account. Its resources are not ' +
        'available here.',
    };
  }

  if (session.status === 'revoked') {
    return {
      kind: 'refused',
      reason: 'session_inactive',
      detail: 'This anonymous session was revoked, so it cannot be brought into an account.',
    };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return {
      kind: 'refused',
      reason: 'session_expired',
      detail: 'This anonymous session has expired, so it cannot be brought into an account.',
    };
  }

  if (resources.files === 0 && resources.folders === 0 && resources.incompleteFiles === 0) {
    return {
      kind: 'refused',
      reason: 'nothing_to_migrate',
      detail: 'This anonymous session holds no files or folders to bring over.',
    };
  }

  return { kind: 'proceed' };
}

/**
 * Whether the account has room for what is about to arrive.
 *
 * Checked against the account's own remaining allowance rather than merged and trimmed: a partial
 * migration would leave the person with half their files moved and no clear way to know which. The
 * whole set either fits or the caller is told exactly how much is missing.
 */
export function assessQuota(input: {
  readonly remainingBytes: number;
  readonly remainingFiles: number;
  readonly needed: MigrationResources;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'file_count_exceeded' | 'storage_quota_exceeded' } {
  if (input.needed.files > input.remainingFiles) {
    return { ok: false, reason: 'file_count_exceeded' };
  }
  if (input.needed.bytes > input.remainingBytes) {
    return { ok: false, reason: 'storage_quota_exceeded' };
  }
  return { ok: true };
}
