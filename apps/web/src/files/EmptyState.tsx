import type { ReactNode } from 'react';
import { SeaChart } from '../assets/SeaChart.js';
import { WaveBand } from '../assets/WaveBand.js';
import { Icon } from '../components/Icon.js';

/**
 * The states a file browser must tell apart.
 *
 * "Nothing here yet", "nothing matches your filter", "we could not load this" and "this
 * deployment cannot store files" are four different situations with four different next steps.
 * Collapsing them into one grey box is how a product teaches people not to trust it.
 */
export type EmptyKind = 'loading' | 'empty' | 'filtered' | 'error' | 'unavailable';

export function EmptyState({
  kind,
  title,
  detail,
  action,
  onRetry,
}: {
  kind: EmptyKind;
  title: string;
  detail: ReactNode;
  action?: ReactNode;
  onRetry?: () => void;
}) {
  if (kind === 'loading') {
    return (
      <div className="state state--loading" role="status" aria-live="polite">
        <span className="state__label">Loading</span>
        <div className="skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="state__detail">Fetching what this credential owns…</p>
      </div>
    );
  }

  const icon = kind === 'error' ? 'alert' : kind === 'unavailable' ? 'shield' : 'compass';

  return (
    <div className={`state state--${kind}`}>
      {kind === 'empty' && <SeaChart className="state__map" />}
      <WaveBand height={18} className="state__waves" />
      <h3 className="state__title">
        <Icon name={icon} size={18} />
        {title}
      </h3>
      <p className="state__detail">{detail}</p>
      {(action !== undefined || onRetry !== undefined) && (
        <div className="state__actions">
          {action}
          {onRetry !== undefined && (
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={15} />
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
