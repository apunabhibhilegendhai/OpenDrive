import { AppError, errorCodeForQuotaRefusal, quotaRefusalReasonSchema } from '@opendrive/shared';

/**
 * Turning internal outcomes into problems.
 *
 * Two rules are encoded here rather than repeated at each call site:
 *
 *   * A refusal the caller can act on (their own quota, their own file size) is explained. A
 *     refusal that is really about the server's own state is not: it becomes an internal error
 *     whose detail stays in the log.
 *   * An unrecognised reason is never rendered as the caller's fault. If the database returns a
 *     reason this build does not know, that is a version skew, and the answer is 500 — not a 429
 *     that tells the caller to retry something that will never succeed.
 */

/** Reasons whose explanation is about the caller's own account, so the SQL message is shown. */
const EXPLAINED_REASONS: readonly string[] = [
  'file_too_large',
  'file_count_exceeded',
  'storage_quota_exceeded',
  'upload_bandwidth_exceeded',
];

export function quotaRefusalProblem(reason: string, message?: string): AppError {
  const known = quotaRefusalReasonSchema.safeParse(reason);
  if (!known.success) {
    return new AppError('INTERNAL', {
      detail: 'The quota check returned a result this build does not understand.',
      expose: false,
      context: { reason },
    });
  }

  const code = errorCodeForQuotaRefusal(known.data);

  // Everything that is not a limit is deliberately answered the same way the authorization layer
  // answers it: a resource the caller may not touch is reported as absent, whether the database
  // phrased it as "owner mismatch", "deleted" or anything else.
  const detail = EXPLAINED_REASONS.includes(known.data)
    ? (message ?? 'The request exceeds an account limit.')
    : code === 'NOT_FOUND'
      ? 'The resource does not exist.'
      : code === 'CONFLICT'
        ? 'The resource is not in a state that allows this operation.'
        : code === 'INTERNAL'
          ? 'The quota check could not be completed.'
          : 'The request could not be completed.';

  return new AppError(code, {
    detail,
    context: { reason: known.data },
    ...(code === 'INTERNAL' ? { expose: false } : {}),
  });
}
