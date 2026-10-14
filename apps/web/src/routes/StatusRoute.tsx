import { Shell } from '../shell/Shell.js';
import { CapacityRuler } from '../components/CapacityRuler.js';
import { Icon } from '../components/Icon.js';
import { StatusChip, type StatusTone } from '../components/StatusChip.js';
import { formatBytes, formatClockTime } from '../lib/format.js';
import { useSystem } from '../state/system.js';

/**
 * System status — "ship status".
 *
 * The operator's view: liveness, per-dependency readiness, the limits this deployment enforces
 * and whether the file-size ceiling has actually been verified against a storage provider.
 * Every value comes from a live endpoint; there are no gauges, no uptime theatre and no
 * "100% secure" claims.
 */
function dependencyTone(status: string): StatusTone {
  if (status === 'ok') return 'live';
  if (status === 'degraded') return 'warn';
  if (status === 'unavailable') return 'down';
  return 'idle';
}

export function StatusRoute() {
  const system = useSystem();
  const { health, readiness, limits, error, loading, refresh } = system;

  return (
    <Shell title="System status" crumbs={[{ label: 'System status' }]}>
      <header className="pagehead">
        <div className="pagehead__title">
          <span className="label">Ship status</span>
          <h1>System status</h1>
          <p className="pagehead__meta">
            What this deployment can do right now, from the API's own answers.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" size={15} />
          {loading ? 'Checking…' : 'Check again'}
        </button>
      </header>

      {error !== null && (
        <p className="statusbanner" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </p>
      )}

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">Dependencies</h2>
        <div className="statuspanel__chips">
          <StatusChip
            tone={health === null ? 'idle' : 'live'}
            state={health === null ? 'no answer' : 'live'}
            label={
              health === null
                ? 'GET /healthz'
                : `v${health.version}, up ${Math.floor(health.uptimeSeconds / 60)}m`
            }
          />
          <StatusChip
            tone={readiness === null ? 'idle' : readiness.status === 'ready' ? 'live' : 'warn'}
            state={readiness?.status ?? 'unknown'}
            label={
              readiness === null ? 'GET /readyz' : `checked ${formatClockTime(readiness.checkedAt)}`
            }
          />
        </div>
        {readiness !== null && (
          <ul className="deps">
            {readiness.dependencies.map((dependency) => (
              <li key={dependency.name} className="deps__row">
                <span className={`deps__status deps__status--${dependency.status}`}>
                  <span className="visually-hidden">{dependency.status}</span>
                  <StatusChip
                    tone={dependencyTone(dependency.status)}
                    state={dependency.status.replace('_', ' ')}
                  />
                </span>
                <span className="deps__name">
                  {dependency.name}
                  {dependency.required ? ' (required)' : ' (optional)'}
                </span>
                <span className="deps__detail">{dependency.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">Limits this deployment enforces</h2>
        {limits === null ? (
          <p className="dim">No limits answer arrived from the API.</p>
        ) : (
          <dl className="limits">
            <div className="limits__row">
              <dt>Per file</dt>
              <dd>
                {formatBytes(limits.maxFileSizeBytes)}{' '}
                <span className={`tag tag--${limits.maxFileSizeVerified ? 'ok' : 'warn'}`}>
                  {limits.maxFileSizeVerified ? 'verified' : 'unverified'}
                </span>
              </dd>
            </div>
            <div className="limits__row">
              <dt>Part size</dt>
              <dd>
                {formatBytes(limits.chunkSizeBytes)} (allowed{' '}
                {formatBytes(limits.minChunkSizeBytes)} – {formatBytes(limits.maxChunkSizeBytes)})
              </dd>
            </div>
            <div className="limits__row">
              <dt>Parts per upload</dt>
              <dd>{limits.maxPartsPerUpload.toLocaleString()}</dd>
            </div>
            <div className="limits__row">
              <dt>Uploads per day</dt>
              <dd>
                {limits.anonymousUploadsPerDay} anonymous · {limits.registeredUploadsPerDay} with an
                account
              </dd>
            </div>
            <div className="limits__row">
              <dt>Malware scanning</dt>
              <dd>
                {limits.malwareScanEnabled
                  ? 'enabled before download'
                  : 'not enabled — files are served when their state allows it'}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">Storage ceiling</h2>
        <CapacityRuler
          maxFileSizeBytes={limits?.maxFileSizeBytes ?? 2 * 1024 ** 3}
          verified={limits?.maxFileSizeVerified ?? false}
        />
      </section>

      <section className="panel statuspanel">
        <h2 className="statuspanel__title">Known gaps in this build</h2>
        <ul className="gaps">
          <li>
            <Icon name="alert" size={15} />
            Abuse reporting answers <span className="mono">501</span> — the route is published and
            owned by a later phase, so there is no report control in the interface.
          </li>
          <li>
            <Icon name="alert" size={15} />
            No share <em>listing</em>: a link can be created, opened at{' '}
            <span className="mono">/s/:token</span> and revoked, but the API has no route that
            enumerates a file's links.
          </li>
          <li>
            <Icon name="alert" size={15} />
            No file rename or move: the API has no metadata update route for files.
          </li>
        </ul>
      </section>
    </Shell>
  );
}
