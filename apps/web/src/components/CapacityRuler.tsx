import { formatBytes } from '../lib/format.js';

/**
 * The one bold element on the page: a ruler showing the intended 2 GiB file-size target
 * against what has actually been verified with a storage provider.
 *
 * It is drawn rather than described because the distinction between "intended" and
 * "verified" is the single most important fact about this build. Today the verified
 * part is empty and the rest is hatched — that is the point, not a loading state.
 */
export function CapacityRuler({
  maxFileSizeBytes,
  verified,
}: {
  maxFileSizeBytes: number;
  verified: boolean;
}) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => formatBytes(maxFileSizeBytes * fraction));
  const summary = verified
    ? `${formatBytes(maxFileSizeBytes)} per file, verified against the configured storage provider.`
    : `${formatBytes(maxFileSizeBytes)} per file is the intended target. Nothing has been verified against a storage provider, so uploads are refused.`;

  return (
    <figure className="ruler">
      <div className="ruler__track" role="img" aria-label={summary}>
        <div className="ruler__unverified" aria-hidden="true" />
        <div
          className="ruler__verified"
          style={{ width: verified ? '100%' : '0%' }}
          aria-hidden="true"
        />
      </div>
      <div className="ruler__ticks" aria-hidden="true">
        {ticks.map((label, index) => (
          <span key={`${label}-${index}`} className="ruler__tick">
            {label}
          </span>
        ))}
      </div>
      <figcaption className="ruler__caption">
        <span className="ruler__key ruler__key--unverified">intended, unverified</span>
        <span className="ruler__key ruler__key--verified">verified and storable</span>
        <span className="ruler__value">{summary}</span>
      </figcaption>
    </figure>
  );
}
