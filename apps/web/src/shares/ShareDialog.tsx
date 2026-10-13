import { useEffect, useId, useState } from 'react';
import type { CreatedShareRecord, FileRecord } from '@opendrive/shared';
import { Icon } from '../components/Icon.js';
import { describeFailure } from '../lib/api/errors.js';
import { useApi } from '../lib/auth/session.js';

/**
 * Create a share link.
 *
 * The token is returned exactly once by the API and cannot be listed afterwards, so the dialog
 * says that plainly and offers to copy it while it is still on screen. There is no share landing
 * page yet in this deployment, so the link's destination is described honestly rather than
 * presented as a working download.
 */
export function ShareDialog({
  file,
  open,
  onClose,
  onCreated,
}: {
  file: FileRecord | null;
  open: boolean;
  onClose: () => void;
  onCreated: (share: CreatedShareRecord) => void;
}) {
  const api = useApi();
  const [kind, setKind] = useState<'public' | 'unlisted'>('unlisted');
  const [expiryHours, setExpiryHours] = useState('0');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedShareRecord | null>(null);
  const [copied, setCopied] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      setCreated(null);
      setError(null);
      setBusy(false);
      setCopied(false);
      setMaxDownloads('');
      setExpiryHours('0');
      setKind('unlisted');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open || file === null) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const hours = Number(expiryHours);
      const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null;
      const parsedMax = maxDownloads.trim() === '' ? null : Number(maxDownloads);
      const share = await api.createShare({
        fileId: file.id,
        kind,
        expiresAt,
        maxDownloads:
          parsedMax !== null && Number.isFinite(parsedMax) && parsedMax > 0
            ? Math.floor(parsedMax)
            : null,
      });
      setCreated(share);
      onCreated(share);
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog__head">
          <h2 className="dialog__title" id={titleId}>
            {created === null ? 'Create a share link' : 'Link created'}
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="dialog__body">
          <p className="dialog__consequence">
            <span className="mono">{file.filename}</span> · the file must stay servable for the link
            to resolve, and the link stops working the moment it is revoked or expires.
          </p>

          {created === null ? (
            <div className="shareform">
              <fieldset className="field">
                <legend className="field__label">Kind</legend>
                <label className="radio">
                  <input
                    type="radio"
                    name="share-kind"
                    value="unlisted"
                    checked={kind === 'unlisted'}
                    onChange={() => setKind('unlisted')}
                  />
                  Unlisted — anyone with the token can read it
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="share-kind"
                    value="public"
                    checked={kind === 'public'}
                    onChange={() => setKind('public')}
                  />
                  Public — may be listed to others
                </label>
              </fieldset>

              <label className="field">
                <span className="field__label">Expires</span>
                <select
                  className="input"
                  value={expiryHours}
                  onChange={(event) => setExpiryHours(event.target.value)}
                >
                  <option value="0">Never</option>
                  <option value="1">In one hour</option>
                  <option value="24">In one day</option>
                  <option value="168">In seven days</option>
                  <option value="720">In thirty days</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">Download limit (optional)</span>
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="Unlimited"
                  value={maxDownloads}
                  onChange={(event) => setMaxDownloads(event.target.value)}
                />
              </label>

              {error !== null && (
                <p className="dialog__error" role="alert">
                  <Icon name="alert" size={15} />
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="sharecreated">
              <p className="sharecreated__warn">
                <Icon name="shield" size={15} />
                This is the only time the token is shown. The API stores only its digest, so it can
                never be listed or recovered — copy it now.
              </p>
              <label className="field">
                <span className="field__label">Link</span>
                <input
                  className="input mono"
                  readOnly
                  value={created.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <label className="field">
                <span className="field__label">Token</span>
                <input
                  className="input mono"
                  readOnly
                  value={created.token}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(created.token)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                <Icon name="key" size={15} />
                {copied ? 'Token copied' : 'Copy token'}
              </button>
              <p className="inspector__note">
                <Icon name="info" size={14} />
                No share landing page is served in this deployment yet, so the link's address is
                informational: resolving it needs the API. This does not affect owner downloads.
              </p>
            </div>
          )}
        </div>

        <footer className="dialog__foot">
          {created === null ? (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? 'Creating…' : 'Create link'}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
