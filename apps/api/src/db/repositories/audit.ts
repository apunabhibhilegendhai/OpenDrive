import { newId } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';

/**
 * Audit events and abuse reports.
 *
 * Audit rows are append-only and deliberately narrow: an action name, the internal ids it touched,
 * the request id that produced it, and a hashed client address. Secrets, tokens and file contents
 * have no place here — an audit log is read by operators and by support tooling, which makes it one
 * of the easiest places to leak something by accident.
 *
 * Rows are written either inside the transaction that performed the action (so the record and the
 * change commit together) or through `recordAuditEventBestEffort`, which is for denials: a refused
 * request must still be answered even if the audit insert fails.
 */

export const AUDIT_ACTIONS = {
  anonymousSessionCreated: 'anonymous_session.created',
  /** An anonymous session's resources were transferred into an account, and it was revoked. */
  anonymousSessionMigrated: 'anonymous_session.migrated',
  apiKeyCreated: 'api_key.created',
  apiKeyRevoked: 'api_key.revoked',
  authenticationFailed: 'auth.failed',
  authorizationDenied: 'authz.denied',
} as const;

export type AuditSubjectType = 'file' | 'share' | 'upload' | 'api_key' | 'abuse_report' | 'system';
export type AuditActorKind = 'anonymous' | 'user' | 'service' | 'admin';

export interface AuditEventInput {
  readonly actorKind: AuditActorKind;
  readonly actorUserId: string | null;
  /** Dotted, lower-case action name. Must be short: the column is limited to 64 characters. */
  readonly action: string;
  readonly subjectType: AuditSubjectType;
  readonly subjectId: string | null;
  readonly requestId: string | null;
  readonly actorIpHash: string | null;
  /** Non-secret, non-identifying context. Never include tokens, keys or file names. */
  readonly metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Appends an audit event and returns its id.
 *
 * Throws on failure, which is what makes it usable inside a transaction: a creation that cannot be
 * audited should not be committed. Pass the transaction's own `sql` handle.
 */
export async function recordAuditEvent(sql: SqlExecutor, input: AuditEventInput): Promise<string> {
  // The id is generated here, not by the database: `audit_events.id` is a prefixed text key with
  // no default, which is what makes an audit id recognisable (`evt_…`) and lets the insert be
  // part of a transaction that also writes the resource it describes.
  const rows = await sql<{ id: string }[]>`
    insert into audit_events (id, actor_kind, actor_user_id, action, subject_type, subject_id,
                              request_id, actor_ip_hash, metadata)
    values (${newId('auditEvent')}, ${input.actorKind}, ${input.actorUserId}, ${input.action},
            ${input.subjectType}, ${input.subjectId}, ${input.requestId}, ${input.actorIpHash},
            ${sql.json(input.metadata ?? {})})
    returning id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('audit event insert returned no row');
  return id;
}

export interface BestEffortAuditContext {
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Appends an audit event without failing the caller when the insert fails.
 *
 * Used for refusals and failed authentications, where the request outcome is already decided. The
 * failure is logged at warn level so an audit gap is visible rather than silent.
 */
export async function recordAuditEventBestEffort(
  sql: SqlExecutor,
  input: AuditEventInput,
  context: BestEffortAuditContext,
): Promise<boolean> {
  try {
    await recordAuditEvent(sql, input);
    return true;
  } catch (error) {
    context.warn(
      { err: error, action: input.action, subjectType: input.subjectType },
      'audit event could not be recorded',
    );
    return false;
  }
}

export interface AbuseReportInput {
  readonly id: string;
  readonly fileId: string;
  readonly reason: 'copyright' | 'malware' | 'illegal_content' | 'spam' | 'other';
  readonly details: string | null;
  readonly reporterUserId: string | null;
  readonly reporterEmailHash: string | null;
  readonly reporterIpHash: string | null;
}

/**
 * Records an abuse report.
 *
 * The reporter's email and address are stored only as hashes: a report must be actionable without
 * becoming a record of who reported what. Reports are readable by the moderation tooling alone —
 * there is no API that returns them.
 */
export async function insertAbuseReport(
  sql: SqlExecutor,
  input: AbuseReportInput,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into abuse_reports (id, file_id, reason, details, reporter_user_id,
                               reporter_email_hash, reporter_ip_hash)
    values (${input.id}, ${input.fileId}, ${input.reason}, ${input.details},
            ${input.reporterUserId}, ${input.reporterEmailHash}, ${input.reporterIpHash})
    returning id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('abuse report insert returned no row');
  return id;
}
