import { AppError } from '@opendrive/shared';
import type { ErrorCode } from '@opendrive/shared';

/**
 * Translating database failures into API problems.
 *
 * A constraint is a rule the application has already reasoned about, so when one fires the client
 * deserves the specific answer ("a folder with that name already exists here") rather than a 500.
 * What the client must never see is the raw error, which contains table names, constraint
 * definitions and sometimes row values.
 *
 * The mapping is by constraint *name*, so a new constraint added to the schema without an entry
 * here still fails safely — as an opaque conflict or internal error — instead of being guessed at.
 */

interface SqlErrorLike {
  code?: unknown;
  constraint_name?: unknown;
  message?: unknown;
}

function asSqlError(error: unknown): SqlErrorLike | null {
  if (typeof error !== 'object' || error === null) return null;
  return error;
}

function codeOf(error: unknown): string | null {
  const sqlError = asSqlError(error);
  if (sqlError === null) return null;
  return typeof sqlError.code === 'string' ? sqlError.code : null;
}

export function constraintNameOf(error: unknown): string | null {
  const sqlError = asSqlError(error);
  if (sqlError === null) return null;
  return typeof sqlError.constraint_name === 'string' ? sqlError.constraint_name : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === '23505';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return codeOf(error) === '23503';
}

export function isCheckViolation(error: unknown): boolean {
  return codeOf(error) === '23514';
}

interface Translation {
  readonly code: ErrorCode;
  readonly detail: string;
}

/**
 * Known constraints and the client-visible meaning of each. Every detail here is written as
 * advice a caller can act on, and none of it echoes the offending value back.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  folders_sibling_name_unique: {
    code: 'CONFLICT',
    detail: 'A folder with that name already exists in this location.',
  },
  folders_parent_same_owner: {
    code: 'NOT_FOUND',
    detail: 'The parent folder does not exist.',
  },
  files_folder_same_owner: {
    code: 'NOT_FOUND',
    detail: 'The target folder does not exist.',
  },
  folders_no_self_parent: {
    code: 'CONFLICT',
    detail: 'A folder cannot be its own parent.',
  },
  // Raised by the hierarchy guard trigger. A cycle is a conflict with the current tree, not a
  // malformed request: the same move becomes legal once the other folder is moved away.
  folders_no_cycles: {
    code: 'CONFLICT',
    detail: 'A folder cannot be moved inside one of its own descendants.',
  },
  folders_max_depth: {
    code: 'CONFLICT',
    detail: 'The folder hierarchy is already as deep as this deployment supports.',
  },
  anonymous_sessions_expires_after_creation: {
    code: 'INTERNAL',
    detail: 'The session lifetime is invalid.',
  },
  api_keys_scopes_known: {
    code: 'VALIDATION_FAILED',
    detail: 'The API key requests a scope that does not exist.',
  },
  api_keys_key_prefix_key: {
    code: 'CONFLICT',
    detail: 'That API key prefix is already in use.',
  },
  files_one_owner: {
    code: 'INTERNAL',
    detail: 'A file must belong to exactly one owner.',
  },
  files_ready_is_servable: {
    code: 'CONFLICT',
    detail: 'A deleted or infected file cannot be marked ready.',
  },
};

/** SQLSTATEs that mean "the request was wrong", independent of which constraint fired. */
const SQLSTATE_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  '23505': { code: 'CONFLICT', detail: 'That value already exists.' },
  '23503': { code: 'NOT_FOUND', detail: 'A referenced resource does not exist.' },
  // A check violation with no constraint name of its own describes a rule the caller broke, but
  // not a malformed request: the request is well-formed and the data refuses it.
  '23514': { code: 'CONFLICT', detail: 'The request conflicts with an existing record.' },
  '23502': { code: 'VALIDATION_FAILED', detail: 'A required value is missing.' },
  '22P02': { code: 'VALIDATION_FAILED', detail: 'A value has the wrong format.' },
  '22001': { code: 'VALIDATION_FAILED', detail: 'A value is too long.' },
  // Insufficient privilege is never the client's fault: it means the deployment's database role
  // is wrong, which the readiness probe also reports.
  '42501': {
    code: 'INTERNAL',
    detail: 'The database role is not permitted to perform this operation.',
  },
};

/**
 * Converts a write failure into an AppError.
 *
 * `fallbackDetail` is used when the error is not a recognised data-rule violation; it must be
 * safe to show. Unexpected errors keep their original as `cause` so the server log has the truth.
 */
export function translateWriteError(error: unknown, fallbackDetail: string): AppError {
  const constraintName = constraintNameOf(error);
  if (constraintName !== null) {
    const translation = CONSTRAINT_TRANSLATIONS[constraintName];
    if (translation !== undefined) {
      return new AppError(translation.code, { detail: translation.detail, cause: error });
    }
  }

  const sqlState = codeOf(error);
  if (sqlState !== null) {
    const translation = SQLSTATE_TRANSLATIONS[sqlState];
    if (translation !== undefined) {
      return new AppError(translation.code, { detail: translation.detail, cause: error });
    }
  }

  return new AppError('INTERNAL', { detail: fallbackDetail, expose: false, cause: error });
}
