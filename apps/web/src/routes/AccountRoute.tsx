import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiKeyRecord, CreatedApiKeyRecord } from '@opendrive/shared';
import { Shell } from '../shell/Shell.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { describePrincipal, useApi, useSession } from '../lib/auth/session.js';
import { describeFailure } from '../lib/api/errors.js';
import { formatBytes } from '../lib/format.js';
import { formatTimestamp } from '../files/presentation.js';
import { useSystem } from '../state/system.js';
import { useToasts } from '../components/ToastRegion.js';

/**
 * Account.
 *
 * Identity and quota come from `GET /api/v1/me`; API keys from the scoped key routes. A key's
 * secret is shown exactly once, at creation, and the list afterwards carries only the public
 * prefix — which is why the dialog says so before the key is even generated.
 *
 * An anonymous session has no account to manage and no key administration: the API refuses key
 * routes to it, so the interface does not offer them.
 *
 * "Sessions on this device" is where the multi-principal flows surface: switching between the
 * credentials this tab holds, and moving an anonymous session's files into the signed-in account.
 * The button calls the real endpoint and reports what the server said it moved — including the
 * folders it renamed and the unfinished uploads it closed.
 */

/** One sentence describing what a migration moved, from the server's own counts. */
function describeMigration(outcome: {
  alreadyMigrated: boolean;
  files: { count: number; bytes: number };
  folders: { count: number };
  skippedIncompleteFiles: number;
  folderRenames: { from: string; to: string }[];
}): string {
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  const parts = [
    plural(outcome.files.count, 'file', 'files'),
    outcome.folders.count > 0 ? plural(outcome.folders.count, 'folder', 'folders') : null,
    outcome.skippedIncompleteFiles > 0
      ? `${plural(outcome.skippedIncompleteFiles, 'unfinished upload', 'unfinished uploads')} closed`
      : null,
    outcome.folderRenames.length > 0
      ? `${plural(outcome.folderRenames.length, 'folder', 'folders')} renamed to avoid a clash`
      : null,
  ].filter((part): part is string => part !== null);
  return `${outcome.alreadyMigrated ? 'Already in this account: ' : 'Moved into this account: '}${parts.join(', ')}.`;
}
export function AccountRoute() {
  const api = useApi();
  const {
    state,
    epoch,
    principals,
    activeKey,
    switchPrincipal,
    forgetPrincipal,
    canMigrate,
    migrateAnonymousPrincipal,
  } = useSession();
  const { me } = useSystem();
  const { notify } = useToasts();
  const [migratingKey, setMigratingKey] = useState<string | null>(null);
  const [migrationReport, setMigrationReport] = useState<{
    key: string;
    text: string;
    failed: boolean;
  } | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['files:read']);
  const [createdKey, setCreatedKey] = useState<CreatedApiKeyRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const loadKeys = useCallback(async () => {
    if (state.kind !== 'signed-in') return;
    try {
      const page = await api.listApiKeys({ limit: 50 });
      setKeys(page.items);
      setKeysError(null);
    } catch (failure) {
      setKeys([]);
      setKeysError(describeFailure(failure));
    }
  }, [api, state.kind]);

  useEffect(() => {
    setKeys([]);
    setCreatedKey(null);
    void loadKeys();
  }, [loadKeys, epoch]);

  const createKey = async () => {
    const name = newKeyName.trim();
    if (name === '') return;
    setCreating(true);
    try {
      const created = await api.createApiKey({ name, scopes, expiresAt: null });
      setCreatedKey(created);
      setNewKeyName('');
      await loadKeys();
    } catch (failure) {
      notify(describeFailure(failure), 'danger');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (revokeTarget === null) return;
    setBusy(true);
    try {
      await api.revokeApiKey(revokeTarget.id);
      notify(`Key "${revokeTarget.name}" revoked. It stops working immediately.`, 'success');
      setRevokeTarget(null);
      await loadKeys();
    } catch (failure) {
      notify(describeFailure(failure), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const migrate = async (key: string) => {
    setMigratingKey(key);
    setMigrationReport(null);
    const result = await migrateAnonymousPrincipal(key);
    setMigratingKey(null);
    if (!result.ok) {
      setMigrationReport({ key, text: result.error, failed: true });
      return;
    }
    setMigrationReport({ key, text: describeMigration(result.outcome), failed: false });
    notify(describeMigration(result.outcome), 'success');
  };

  const quota = me?.quota;

  return (
    <Shell title="Account" crumbs={[{ label: 'Account' }]}>
      <header className="pagehead">
        <div className="pagehead__title">
          <span className="label">Ship's papers</span>
          <h1>Account</h1>
          <p className="pagehead__meta">
            {state.kind === 'signed-in'
              ? 'Signed in with a Supabase account. The API derives this identity from your token, never from the request body.'
              : 'Signed in with an anonymous session issued by the API.'}
          </p>
        </div>
      </header>

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">Identity</h2>
        {me === null ? (
          <p className="dim">The identity endpoint did not answer.</p>
        ) : (
          <dl className="limits">
            <div className="limits__row">
              <dt>Principal</dt>
              <dd className="mono">{me.identity.principalKind}</dd>
            </div>
            {me.identity.userId !== null && (
              <div className="limits__row">
                <dt>User id</dt>
                <dd className="mono">{me.identity.userId}</dd>
              </div>
            )}
            {me.identity.sessionId !== null && (
              <div className="limits__row">
                <dt>Session id</dt>
                <dd className="mono">{me.identity.sessionId}</dd>
              </div>
            )}
            <div className="limits__row">
              <dt>Account status</dt>
              <dd>{me.identity.accountStatus ?? 'not applicable'}</dd>
            </div>
            <div className="limits__row">
              <dt>Scopes</dt>
              <dd className="mono">{me.identity.scopes.join(', ') || '—'}</dd>
            </div>
            <div className="limits__row">
              <dt>Credential expires</dt>
              <dd>
                {me.identity.credentialExpiresAt === null
                  ? 'no expiry reported'
                  : formatTimestamp(me.identity.credentialExpiresAt)}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">Sessions on this device</h2>
        <p className="statuspanel__copy">
          This tab can hold more than one credential at once — an account and the anonymous session
          you uploaded with, or two accounts. Switching changes which credential the next request
          carries, and the API re-derives identity from that credential alone: nothing here grants
          access to anyone else’s data.
        </p>
        {principals.length === 0 ? (
          <p className="dim">No session is active. Sign in to continue.</p>
        ) : (
          <ul className="sessionlist">
            {principals.map((principal) => {
              const isActive = principal.key === activeKey;
              const report = migrationReport?.key === principal.key ? migrationReport : null;
              return (
                <li key={principal.key} className="sessionlist__row">
                  <div className="sessionlist__head">
                    <span className="sessionlist__name">{describePrincipal(principal)}</span>
                    <span className="tag tag--plain">
                      {principal.kind === 'user' ? 'account' : 'anonymous session'}
                    </span>
                    {isActive && <span className="tag">active</span>}
                  </div>

                  {principal.expiresAt !== null && (
                    <p className="dim sessionlist__meta">
                      {principal.refreshable
                        ? `Renewable until ${formatTimestamp(principal.expiresAt)}`
                        : `Held token expires ${formatTimestamp(principal.expiresAt)}; this one cannot be renewed, so sign in again if it lapses.`}
                    </p>
                  )}

                  <div className="sessionlist__actions">
                    {!isActive && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => switchPrincipal(principal.key)}
                      >
                        <Icon name="user" size={16} />
                        Switch to this session
                      </button>
                    )}
                    {principal.kind === 'anonymous' && (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!canMigrate || migratingKey !== null}
                        onClick={() => void migrate(principal.key)}
                      >
                        <Icon name="upload" size={16} />
                        {migratingKey === principal.key
                          ? 'Moving…'
                          : 'Move its files into this account'}
                      </button>
                    )}
                    {!isActive && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => forgetPrincipal(principal.key)}
                      >
                        Forget this session
                      </button>
                    )}
                  </div>

                  {principal.kind === 'anonymous' && !canMigrate && (
                    <p className="dim sessionlist__meta">
                      <Icon name="info" size={15} /> Only an account can receive a session’s files.{' '}
                      <Link to="/signin?add=1">Sign in</Link> and its files move here without
                      re-uploading.
                    </p>
                  )}

                  {report !== null && (
                    <p
                      className={report.failed ? 'sessionlist__error' : 'sessionlist__note'}
                      role={report.failed ? 'alert' : 'status'}
                    >
                      <Icon name={report.failed ? 'alert' : 'info'} size={15} />
                      {report.text}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="statuspanel__copy">
          Holding a second account is a convenience, not a second identity: it is only a credential
          kept in this tab’s memory for as long as the tab is open.{' '}
          <Link to="/signin?add=1">Add another account</Link> — you will be returned here.
        </p>
      </section>

      {quota !== undefined && (
        <section className="panel statuspanel">
          <h2 className="statuspanel__title">Quota</h2>
          <dl className="limits">
            <div className="limits__row">
              <dt>Stored</dt>
              <dd>
                {formatBytes(quota.usage.storedBytes)} of {formatBytes(quota.limits.storageBytes)}
                {quota.usage.heldBytes > 0 && (
                  <span className="dim">
                    {' '}
                    · {formatBytes(quota.usage.heldBytes)} held by open uploads
                  </span>
                )}
              </dd>
            </div>
            <div className="limits__row">
              <dt>Files</dt>
              <dd>
                {quota.usage.storedFiles} of {quota.limits.maxFiles}
              </dd>
            </div>
            <div className="limits__row">
              <dt>Uploaded today</dt>
              <dd>
                {formatBytes(quota.usage.uploadBytesToday)}
                {quota.limits.uploadBytesPerDay === null
                  ? ' (no daily limit)'
                  : ` of ${formatBytes(quota.limits.uploadBytesPerDay)}`}
              </dd>
            </div>
            <div className="limits__row">
              <dt>Per-file ceiling</dt>
              <dd>{formatBytes(quota.limits.maxFileSizeBytes)}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">API keys</h2>
        {state.kind !== 'signed-in' ? (
          <p className="dim">
            <Icon name="info" size={15} /> API keys belong to a registered account. An anonymous
            session holds a single credential, and the API refuses key administration to it.
          </p>
        ) : (
          <>
            <p className="statuspanel__copy">
              Keys are scoped and revocable. The secret is shown once, at creation; afterwards the
              API only ever returns its prefix.
            </p>
            <div className="keyform">
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="input"
                  value={newKeyName}
                  onChange={(event) => setNewKeyName(event.target.value)}
                  placeholder="Laptop backup script"
                  maxLength={80}
                />
              </label>
              <fieldset className="field keyform__scopes">
                <legend className="field__label">Scopes</legend>
                {['files:read', 'files:write', 'shares:write', 'account:read'].map((scope) => (
                  <label key={scope} className="check">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(event) => {
                        setScopes((current) =>
                          event.target.checked
                            ? [...new Set([...current, scope])]
                            : current.filter((value) => value !== scope),
                        );
                      }}
                    />
                    <span className="mono">{scope}</span>
                  </label>
                ))}
              </fieldset>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void createKey()}
                disabled={creating || newKeyName.trim() === ''}
              >
                <Icon name="key" size={16} />
                {creating ? 'Creating…' : 'Create key'}
              </button>
            </div>

            {createdKey !== null && (
              <div className="keycreated" role="status">
                <p className="keycreated__warn">
                  <Icon name="shield" size={15} />
                  This is the only time this key is shown. Store it now; the API keeps only a hash.
                </p>
                <label className="field">
                  <span className="field__label">
                    Key for {createdKey.name} ({createdKey.keyPrefix}…)
                  </span>
                  <input
                    className="input mono"
                    readOnly
                    value={createdKey.key}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <button type="button" className="btn" onClick={() => setCreatedKey(null)}>
                  Done
                </button>
              </div>
            )}

            {keysError !== null && (
              <p className="dialog__error" role="alert">
                <Icon name="alert" size={15} />
                {keysError}
              </p>
            )}

            {keys.length > 0 && (
              <table className="keytable">
                <caption className="visually-hidden">API keys on this account</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Prefix</th>
                    <th scope="col">Scopes</th>
                    <th scope="col">Last used</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr
                      key={key.id}
                      className={key.revokedAt !== null ? 'keytable__row--revoked' : undefined}
                    >
                      <th scope="row">{key.name}</th>
                      <td className="mono">{key.keyPrefix}…</td>
                      <td className="mono dim">{key.scopes.join(', ') || '—'}</td>
                      <td className="dim">
                        {key.lastUsedAt === null ? 'never' : formatTimestamp(key.lastUsedAt)}
                      </td>
                      <td>
                        {key.revokedAt === null ? (
                          <button
                            type="button"
                            className="btn btn--danger"
                            onClick={() => setRevokeTarget(key)}
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="tag tag--plain">revoked</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={`Revoke ${revokeTarget?.name ?? 'this key'}?`}
        consequence="Anything using this key stops being able to authenticate on its next request. This cannot be undone; you can create a new key instead."
        confirmLabel="Revoke key"
        destructive
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </Shell>
  );
}
