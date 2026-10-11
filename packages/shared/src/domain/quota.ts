import { z } from 'zod';
import type { ErrorCode } from '../errors.js';

/**
 * Quota refusal vocabulary.
 *
 * `opendrive_reserve_storage` returns `{ok: false, reason: ...}` instead of raising, so the
 * reason is data. This list is the contract for that data: the repository validates every
 * response against it and fails closed (503/500) on anything unrecognised, rather than treating
 * an unknown reason as an approval.
 */

export const QUOTA_REFUSAL_REASONS = [
  'invalid_principal',
  'owner_unknown',
  'owner_not_active',
  'session_revoked',
  'session_expired',
  'policy_missing',
  'file_not_found',
  'owner_mismatch',
  'file_deleted',
  'size_mismatch',
  'already_reserved',
  'file_too_large',
  'file_count_exceeded',
  'storage_quota_exceeded',
  'upload_bandwidth_exceeded',
  'reservation_not_found',
  'reservation_not_held',
  'reservation_expired',
  'already_committed',
] as const;

export type QuotaRefusalReason = (typeof QUOTA_REFUSAL_REASONS)[number];
export const quotaRefusalReasonSchema = z.enum(QUOTA_REFUSAL_REASONS);

/** Reasons that describe an identity problem, not a quota problem. */
const OWNER_REFUSALS: readonly QuotaRefusalReason[] = [
  'owner_unknown',
  'session_revoked',
  'session_expired',
];

/** Reasons that mean the request itself is contradictory or already answered. */
const CONFLICT_REFUSALS: readonly QuotaRefusalReason[] = [
  'already_reserved',
  'already_committed',
  'file_deleted',
  'reservation_expired',
];

/**
 * Maps a refusal to the status code the API should answer with.
 *
 * `owner_mismatch` is a 403 rather than a 404: the caller is authenticated and is asking about a
 * resource that exists but is not theirs, and the file id came from their own request. The
 * resource-level 404 rule for *share* lookups applies to tokens, where the token is the secret.
 */
export function errorCodeForQuotaRefusal(reason: QuotaRefusalReason): ErrorCode {
  if ((OWNER_REFUSALS as readonly string[]).includes(reason)) return 'UNAUTHENTICATED';
  if (reason === 'owner_not_active') return 'FORBIDDEN';
  if (reason === 'owner_mismatch') return 'FORBIDDEN';
  if (reason === 'file_not_found') return 'NOT_FOUND';
  if (reason === 'file_too_large') return 'PAYLOAD_TOO_LARGE';
  if ((CONFLICT_REFUSALS as readonly string[]).includes(reason)) return 'CONFLICT';
  if (reason === 'size_mismatch') return 'INTEGRITY_CHECK_FAILED';
  if (reason === 'file_count_exceeded') return 'QUOTA_EXCEEDED';
  if (reason === 'storage_quota_exceeded') return 'QUOTA_EXCEEDED';
  if (reason === 'upload_bandwidth_exceeded') return 'RATE_LIMITED';
  // invalid_principal, policy_missing, reservation_not_found, reservation_not_held: a state the
  // API cannot express as a client request. These are server faults and are reported as such.
  return 'INTERNAL';
}

/**
 * Whether the caller may be told which limit was hit. Quota refusals are about the caller's own
 * account, so they are explicable — unlike share refusals, which must not confirm that a token
 * ever existed.
 */
export function isQuotaRefusalExplainable(reason: QuotaRefusalReason): boolean {
  return reason !== 'invalid_principal' && reason !== 'policy_missing';
}
