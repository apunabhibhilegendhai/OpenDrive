import { useState } from 'react';
import { Shell } from '../shell/Shell.js';
import { Icon } from '../components/Icon.js';
import { EmptyState } from '../files/EmptyState.js';
import { useApi } from '../lib/auth/session.js';
import { describeFailure } from '../lib/api/errors.js';
import { formatBytes } from '../lib/format.js';
import { formatTimestamp } from '../files/presentation.js';
import type { ResolveShareResponse } from '@opendrive/shared';

/**
 * Shares.
 *
 * The API can create, resolve and revoke a share link, but it has no route that lists them —
 * that is a real gap, so this page does not pretend to have a link library. What it does have
 * is the honest pair of operations that exist: resolve a token you hold, and a pointer to the
 * file inspector where links are created and revoked.
 */
export function SharesRoute() {
  const api = useApi();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolveShareResponse | null>(null);

  const resolve = async () => {
    const candidate = token.trim();
    if (candidate.length < 32) {
      setError('A share token is at least 32 characters. Paste the whole token.');
      setResolved(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.resolveShare(candidate);
      setResolved(result);
    } catch (failure) {
      setResolved(null);
      setError(
        `${describeFailure(failure)} Revoked, expired and never-existing tokens all answer the same way, so a refusal is not evidence that the link existed.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Shares" crumbs={[{ label: 'Shares' }]}>
      <header className="pagehead">
        <div className="pagehead__title">
          <span className="label">Links</span>
          <h1>Shares</h1>
          <p className="pagehead__meta">
            One link, one file, one decision: the token is the whole credential, and revoking it
            takes effect on the next request.
          </p>
        </div>
      </header>

      <section className="panel panel--sunken sharepanel">
        <h2 className="sharepanel__title">
          <Icon name="link" size={18} />
          Resolve a link
        </h2>
        <p className="sharepanel__copy">
          Checking a link needs no account, because the token is the credential. Revoked, expired,
          over-limit and never-existing tokens are answered identically.
        </p>
        <div className="sharepanel__row">
          <input
            className="input mono"
            type="text"
            placeholder="Paste a share token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-label="Share token"
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void resolve()}
            disabled={busy}
          >
            {busy ? 'Resolving…' : 'Resolve'}
          </button>
        </div>

        {error !== null && (
          <p className="sharepanel__error" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </p>
        )}

        {resolved !== null && (
          <dl className="sharepanel__result">
            <div>
              <dt>File</dt>
              <dd className="mono">{resolved.file.filename}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd className="mono">{formatBytes(resolved.file.sizeBytes)}</dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{resolved.share.kind}</dd>
            </div>
            <div>
              <dt>Downloads</dt>
              <dd className="mono">
                {resolved.share.downloadCount}
                {resolved.share.maxDownloads === null
                  ? ' (no limit)'
                  : ` of ${resolved.share.maxDownloads}`}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                {resolved.share.expiresAt === null
                  ? 'never'
                  : formatTimestamp(resolved.share.expiresAt)}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{resolved.share.status}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="panel sharepanel">
        <h2 className="sharepanel__title">
          <Icon name="info" size={18} />
          Where links come from
        </h2>
        <p className="sharepanel__copy">
          Create a link from a file's details panel in My Drive. Links are shown and revoked there,
          for the tab that created them.
        </p>
        <p className="sharepanel__copy">
          <strong>Not available:</strong> a list of existing links. The API publishes create,
          resolve and revoke, but no listing route — so nothing here invents one, and a link you
          created on another machine cannot be enumerated from this one.
        </p>
        <p className="sharepanel__copy">
          A link opens a public landing page at <span className="mono">/s/:token</span> where the
          recipient can preview the file and download it. Opening that page is what counts against
          the link's download limit.
        </p>
      </section>

      {resolved === null && error === null && (
        <EmptyState
          kind="empty"
          title="Nothing resolved yet"
          detail="Paste a token above to see exactly what a visitor would be told: the file it points at, how many times it has been used, and whether it is still active."
        />
      )}
    </Shell>
  );
}
