import type { MeResponse } from '@opendrive/shared';
import { formatBytes } from '../lib/format.js';

/**
 * Storage status, from `GET /api/v1/me`.
 *
 * When there is no quota answer (anonymous quota unknown, API unreachable), it says so rather
 * than drawing a full or empty bar. The figures are the principal's own usage and limit — never
 * an estimate, never a percentage of a number the API did not return.
 */
export function StorageMeter({ me }: { me: MeResponse | null }) {
  if (me === null) {
    return (
      <span className="meter meter--unknown" title="Storage usage is not available">
        <span className="label">Storage</span>
        <span className="meter__value dim">unknown</span>
      </span>
    );
  }

  const used = me.quota.usage.storageBytes;
  const limit = me.quota.limits.storageBytes;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const nearLimit = ratio >= 0.9;

  return (
    <span className="meter" title={`${formatBytes(used)} stored of ${formatBytes(limit)} allowed`}>
      <span className="label">Storage</span>
      <span className="meter__track" aria-hidden="true">
        <span
          className={`meter__fill${nearLimit ? ' meter__fill--warn' : ''}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      <span className="meter__value">
        {formatBytes(used)} / {formatBytes(limit)}
      </span>
      <span className="visually-hidden">
        {formatBytes(used)} stored of {formatBytes(limit)} allowed.
      </span>
    </span>
  );
}
