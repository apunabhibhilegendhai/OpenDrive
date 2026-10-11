import { z } from 'zod';
import {
  accountStatusSchema,
  principalKindSchema,
  quotaRefusalReasonSchema,
} from '@opendrive/shared';
import type { Principal } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';
import type {
  CommitOutcome,
  QuotaSummaryEntity,
  ReleaseOutcome,
  ReservationOutcome,
} from '../entities.js';
import { parseByteCount, parseTimestamp } from '../parse.js';

/**
 * Quota.
 *
 * All decisions live in SQL (`opendrive_quota_summary`, `opendrive_reserve_storage`,
 * `opendrive_commit_reservation`, `opendrive_release_reservation`). That is not an accident of
 * convenience: a quota check is a check-then-act, and doing it in the application would let two
 * concurrent uploads both pass it. The functions take a lock on the limit row, count only the
 * states that really hold bytes, and record a reservation the next caller can see.
 *
 * This module's job is to call them and to *validate what comes back*. Each response is parsed
 * against a schema; a response that does not match is a 500, never a default. An unknown refusal
 * reason is treated the same way — a reason this build does not understand must not be read as
 * approval.
 */

export interface QuotaPrincipal {
  readonly ownerUserId: string | null;
  readonly ownerSessionId: string | null;
}

/** The two owner columns of a principal, in the shape the SQL functions expect. */
export function quotaArgsFor(principal: Principal): QuotaPrincipal {
  return principal.kind === 'user'
    ? { ownerUserId: principal.userId, ownerSessionId: null }
    : { ownerUserId: null, ownerSessionId: principal.sessionId };
}

const quotaSummarySchema = z.object({
  ok: z.literal(true),
  principalKind: principalKindSchema,
  accountStatus: accountStatusSchema,
  storageLimitBytes: z.number().int().positive(),
  storageUsedBytes: z.number().int().nonnegative(),
  storageRemainingBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  maxFiles: z.number().int().positive(),
  maxFileSizeBytes: z.number().int().positive(),
  uploadBytesPerDay: z.number().int().positive().nullable(),
  uploadBytesUsedToday: z.number().int().nonnegative(),
  downloadBytesPerDay: z.number().int().positive().nullable(),
  downloadBytesUsedToday: z.number().int().nonnegative(),
  fileExpiresAfterHours: z.number().int().positive().nullable(),
  heldReservationBytes: z.number().int().nonnegative(),
});

const quotaSummaryRefusalSchema = z.object({
  ok: z.literal(false),
  reason: z.string(),
});

const reservationSuccessSchema = z.object({
  ok: z.literal(true),
  reservationId: z.string().min(1),
  storageLimitBytes: z.number().int().positive(),
  storageUsedBytes: z.number().int().nonnegative(),
  storageRemainingBytes: z.number().int(),
  expiresAt: z.string(),
});

const reservationRefusalSchema = z.object({
  ok: z.literal(false),
  reason: quotaRefusalReasonSchema,
  message: z.string().optional(),
});

const commitSchema = z.object({
  ok: z.boolean(),
  alreadyCommitted: z.boolean().optional(),
  fileId: z.string().optional(),
  committedBytes: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

const releaseSchema = z.object({
  ok: z.boolean(),
  alreadyReleased: z.boolean().optional(),
  releasedBytes: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

function internal(detail: string, cause?: unknown): Error {
  return new Error(`quota: ${detail}`, cause === undefined ? undefined : { cause });
}

export type QuotaSummaryOutcome =
  | { readonly ok: true; readonly summary: QuotaSummaryEntity }
  | { readonly ok: false; readonly reason: string };

/**
 * Limits plus live usage for one principal, in a single round trip.
 *
 * A refusal is returned as a reason rather than as null: `policy_missing` and `owner_unknown` mean
 * very different things (a deployment fault versus an identity that is not provisioned), and the
 * caller maps them to different statuses. Any *other* response shape is a server fault.
 */
export async function readQuotaSummary(
  sql: SqlExecutor,
  principal: QuotaPrincipal,
): Promise<QuotaSummaryOutcome> {
  const rows = await sql<{ result: unknown }[]>`
    select opendrive_quota_summary(${principal.ownerUserId}::uuid,
                                   ${principal.ownerSessionId}::text) as result
  `;
  const raw = rows[0]?.result;
  const parsed = quotaSummarySchema.safeParse(raw);
  if (parsed.success) {
    return {
      ok: true,
      summary: {
        principalKind: parsed.data.principalKind,
        accountStatus: parsed.data.accountStatus,
        storageLimitBytes: parseByteCount(parsed.data.storageLimitBytes, 'quota.storageLimitBytes'),
        storageUsedBytes: parseByteCount(parsed.data.storageUsedBytes, 'quota.storageUsedBytes'),
        storageRemainingBytes: parseByteCount(
          parsed.data.storageRemainingBytes,
          'quota.storageRemainingBytes',
        ),
        heldReservationBytes: parseByteCount(
          parsed.data.heldReservationBytes,
          'quota.heldReservationBytes',
        ),
        fileCount: parsed.data.fileCount,
        maxFiles: parsed.data.maxFiles,
        maxFileSizeBytes: parseByteCount(parsed.data.maxFileSizeBytes, 'quota.maxFileSizeBytes'),
        uploadBytesPerDay: parsed.data.uploadBytesPerDay,
        uploadBytesUsedToday: parsed.data.uploadBytesUsedToday,
        downloadBytesPerDay: parsed.data.downloadBytesPerDay,
        downloadBytesUsedToday: parsed.data.downloadBytesUsedToday,
        fileExpiresAfterHours: parsed.data.fileExpiresAfterHours,
      },
    };
  }
  const refusal = quotaSummaryRefusalSchema.safeParse(raw);
  if (refusal.success) return { ok: false, reason: refusal.data.reason };
  throw internal('summary response did not match the expected shape', raw);
}

export interface ReserveStorageInput {
  readonly reservationId: string;
  readonly principal: QuotaPrincipal;
  readonly fileId: string;
  readonly bytes: number;
  readonly ttlSeconds: number;
}

/**
 * Reserves storage for one upload.
 *
 * The refusal path is a normal outcome, not an exception: the API maps `reason` to a status code
 * through `errorCodeForQuotaRefusal`. `requested_bytes` is capped and positive at the database
 * level, so a caller cannot reserve a negative amount to free quota.
 */
export async function reserveStorage(
  sql: SqlExecutor,
  input: ReserveStorageInput,
): Promise<ReservationOutcome> {
  const rows = await sql<{ result: unknown }[]>`
    select opendrive_reserve_storage(
             ${input.reservationId},
             ${input.principal.ownerUserId}::uuid,
             ${input.principal.ownerSessionId}::text,
             ${input.fileId},
             ${input.bytes}::bigint,
             make_interval(secs => ${input.ttlSeconds})
           ) as result
  `;
  const raw = rows[0]?.result;

  const success = reservationSuccessSchema.safeParse(raw);
  if (success.success) {
    return {
      ok: true,
      reservationId: success.data.reservationId,
      storageLimitBytes: parseByteCount(success.data.storageLimitBytes, 'reservation.limit'),
      storageUsedBytes: parseByteCount(success.data.storageUsedBytes, 'reservation.used'),
      storageRemainingBytes: parseByteCount(
        success.data.storageRemainingBytes,
        'reservation.remaining',
      ),
      expiresAt: parseTimestamp(success.data.expiresAt, 'reservation.expiresAt'),
    };
  }

  const refusal = reservationRefusalSchema.safeParse(raw);
  if (refusal.success) {
    return refusal.data.message === undefined
      ? { ok: false, reason: refusal.data.reason }
      : { ok: false, reason: refusal.data.reason, message: refusal.data.message };
  }

  // Unknown refusal reasons are NOT treated as approval.
  throw internal('reservation response did not match the expected shape', raw);
}

/** Commits a hold once bytes are durable. Idempotent: a repeat commit reports `alreadyCommitted`. */
export async function commitReservation(
  sql: SqlExecutor,
  reservationId: string,
): Promise<CommitOutcome> {
  const rows = await sql<{ result: unknown }[]>`
    select opendrive_commit_reservation(${reservationId}) as result
  `;
  const raw = rows[0]?.result;
  const parsed = commitSchema.safeParse(raw);
  if (!parsed.success) throw internal('commit response did not match the expected shape', raw);
  return {
    ok: parsed.data.ok,
    ...(parsed.data.alreadyCommitted === undefined
      ? {}
      : { alreadyCommitted: parsed.data.alreadyCommitted }),
    ...(parsed.data.fileId === undefined ? {} : { fileId: parsed.data.fileId }),
    ...(parsed.data.committedBytes === undefined
      ? {}
      : { committedBytes: parsed.data.committedBytes }),
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
  };
}

/** Releases a hold after a failed upload. Idempotent, so a retried failure path is safe. */
export async function releaseReservation(
  sql: SqlExecutor,
  reservationId: string,
): Promise<ReleaseOutcome> {
  const rows = await sql<{ result: unknown }[]>`
    select opendrive_release_reservation(${reservationId}) as result
  `;
  const raw = rows[0]?.result;
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) throw internal('release response did not match the expected shape', raw);
  return {
    ok: parsed.data.ok,
    ...(parsed.data.alreadyReleased === undefined
      ? {}
      : { alreadyReleased: parsed.data.alreadyReleased }),
    ...(parsed.data.releasedBytes === undefined
      ? {}
      : { releasedBytes: parsed.data.releasedBytes }),
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
  };
}

/** Sweeps expired holds across every principal. The worker calls this on a schedule. */
export async function sweepExpiredReservations(sql: SqlExecutor): Promise<number> {
  const rows = await sql<{ result: number }[]>`
    select opendrive_sweep_expired_reservations() as result
  `;
  return rows[0]?.result ?? 0;
}
